import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { abstract } from '../extensions/lineage/server.ts'
import { SubmissionLanded } from '../extensions/workspaces/api.ts'
import type { LandedData } from '../extensions/workspaces/api.ts'
import { emit, EventLog } from '../server/events.ts'
import { context } from '../server/harness.ts'
import { UiState } from '../server/ui-state.ts'
import { until } from './helpers.ts'
import { branchFrom, fixture, notifyFixture, servers, settled } from './lineage-fixture.ts'
import type { Server } from './lineage-fixture.ts'

const landing = (submission: string, conversationId: number): LandedData => ({
  submission,
  conversationId,
  at: 3,
  sha: `${submission}abcdef0`,
  base: '0000000',
  target: 'main',
  lander: 2,
  divergence: 'None',
  title: 'Land me',
  feature: 'Landing',
  commits: [{ sha: 'abc1234', subject: `feat: ${submission}` }],
  commitCount: 12,
  paths: ['landed.txt'],
})
const land = async (server: Server, data: LandedData) =>
  (await server.harness.commit((tx) => emit(tx, SubmissionLanded, data), context)).id
const notes = async (server: Server) =>
  (await server.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note')
const concluded = async (server: Server) =>
  ((await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context))?.[
    'ext.conversations.concluded'
  ] ?? []) as number[]
/** Whether the conclude task of `submission`'s landing in `id` has ended. */
const concludeEnded = async (server: Server, id: ConversationId, submission: string) =>
  (
    await server.harness.commit(
      (tx) => tx.scanTasks({ conversationId: id, kind: 'lineage.conclude-landed' }, 10),
      context,
    )
  ).items.some(
    (task) =>
      (task.input as { submission: string }).submission === submission &&
      task.state.status === 'terminal',
  )
/** How far lineage's landing reactor has read the event log. */
const cursor = async (server: Server) =>
  (await server.harness.snapshot(EventLog, ROOT_CONVERSATION_ID, context))?.cursors[
    'lineage/landing-notes'
  ] ?? 0

it.concurrent('concludes a landed branch only when its report run answered, never after a Stop', async () => {
  const { server } = await notifyFixture()
  const id = await branchFrom(server, { from: 1, prompt: 'Land me' })
  const branch = await settled(server, id)
  // The lander's report starts a run that the person stops before it answers.
  await branch.submit({ type: 'input', content: 'HOLD', requestId: 'lander:s1' }, context)
  await until(async () => !!(await server.harness.snapshot(LiveDoc, id, context))?.run)
  await land(server, landing('s1', id))
  const run = (await server.harness.snapshot(LiveDoc, id, context))!.run!.taskId
  await server.harness.abortTask(run, context)
  await server.harness.waitForTask(run, context)
  expect(
    await server.harness.commit((tx) => tx.submissionByRequest(id, 'lander:s1'), context),
  ).toMatchObject({ status: 'unanswered', reason: 'aborted' })
  await until(() => concludeEnded(server, id, 's1'))
  expect(await concluded(server)).not.toContain(id)

  // A report that is answered concludes it.
  await branch.submit({ type: 'input', content: 'Landed.', requestId: 'lander:s2' }, context)
  await land(server, landing('s2', id))
  await until(async () => (await concluded(server)).includes(id))
})
it.concurrent('notes a landing in its tree root once, across a failed attempt and a restart', async () => {
  const { server, home } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'Land me' })
  await settled(server, first)
  await server.harness.commit((tx) => abstract(tx, first, { text: 'State: done.', at: 3 }), context)

  // The reactor's first attempt fails after it placed the note, as a crash before its commit would.
  let failed = false
  const commit = server.harness.commit.bind(server.harness)
  const spy = vi.spyOn(server.harness, 'commit').mockImplementation((change, ctx) =>
    commit(async (tx) => {
      let noted = false
      const watched = new Proxy(tx, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown
          if (key === 'appendEntry')
            return (...args: Parameters<Tx['appendEntry']>) => {
              if ((args[1] as { kind?: string }).kind === 'lineage.note') noted = true
              return target.appendEntry(...args)
            }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const result = await change(watched)
      if (noted && !failed) {
        failed = true
        throw new Error('crashed before commit')
      }
      return result
    }, ctx),
  )
  const before = await cursor(server)
  await land(server, landing('s1', first))
  await until(() => failed)
  // The failed attempt rolled back its note and its cursor: the event stays pending.
  expect(await notes(server)).toHaveLength(0)
  expect(await cursor(server)).toBe(before)

  // The next landing retries it: each note is written once, the first freezing the open abstract.
  const second = await land(server, landing('s2', first))
  await until(async () => (await notes(server)).length === 2)
  const [one, two] = await notes(server)
  expect(one.data).toEqual({
    at: 3,
    divergence: 'None',
    sha: 's1abcdef0',
    base: '0000000',
    target: 'main',
    commits: [{ sha: 'abc1234', subject: 'feat: s1' }],
    paths: ['landed.txt'],
    title: 'Land me',
    more: 11,
    lander: 2,
    feature: 'Landing',
    text: `Landed s1abcde on main from #${first}/3 Land me (Landing):\nDiverged: None\nfeat: s1\nand 11 more\nChanged: landed.txt`,
    from: first,
    source: 'lander',
    abstract: { at: 3, text: 'State: done.' },
  })
  expect((two.data as { sha: string }).sha).toBe('s2abcdef0')
  await until(async () => (await cursor(server)) >= second)

  // A restart on the same home catches up from the cursor and writes nothing again.
  spy.mockRestore()
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = (await fixture(home)).server
  const third = await land(reopened, landing('s3', first))
  await until(async () => (await cursor(reopened)) >= third)
  expect((await notes(reopened)).map((note) => (note.data as { sha: string }).sha)).toEqual([
    's1abcdef0',
    's2abcdef0',
    's3abcdef0',
  ])
})
