import { resolve } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask, LiveDoc, UsageDoc } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { fauxServer, post, temp, until } from './helpers.ts'

const anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'status-line.fixture',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, caller) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        caller,
      ),
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})
const message = (output: number) => {
  const value = fauxAssistantMessage([fauxText('fixture')])
  value.usage = {
    ...value.usage,
    input: output * 2,
    output,
    reasoning: output * 5,
    cacheRead: output * 3,
    cacheWrite: output * 4,
  }
  return value
}

it('atomically snapshots settled models plus partials for owned idle/background descendants only', async () => {
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: await temp(),
    userHome: await temp(),
  })
  try {
    server.host.registry.install(defineExtension({ name: 'status-line-fixture', tasks: [anchor] }))
    const root = server.root.id
    const entry = await server.harness.commit(
      (tx) => tx.appendEntry(root, { kind: 'status-line.fixture', data: {} }),
      context,
    )
    const ids = await server.harness.commit(async (tx) => {
      const task = await tx.createTask(anchor, null, {
        ownership: { kind: 'conversation' },
        conversationId: root,
        background: true,
      })
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId: task } })
      const nestedTask = await tx.createTask(anchor, null, {
        ownership: { kind: 'conversation' },
        conversationId: child.id,
        background: true,
      })
      const nested = await tx.createConversation({
        ownership: { kind: 'task', taskId: nestedTask },
      })
      const fork = await tx.forkConversation(root, entry.id, { ownership: { kind: 'ownerless' } })
      const unrelated = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      for (const [id, output] of [
        [root, 100],
        [child.id, 200],
        [nested.id, 300],
        [fork.id, 9000],
        [unrelated.id, 9000],
      ] as const) {
        const usage = await tx.doc(UsageDoc, id)
        usage.models['faux/model'] = message(output).usage
        usage.models['faux/second'] = message(10).usage
        usage.tools.expensive = message(50000).usage
        ;(await tx.doc(LiveDoc, id)).generation = {
          attempt: 1,
          message: JSON.parse(JSON.stringify(message(20))),
        }
      }
      return { child: child.id, nested: nested.id, fork: fork.id, unrelated: unrelated.id }
    }, context)
    await until(() => server.api.conversations().length >= 5)
    await until(() => !server.api.conversations().some((item) => item.busy))
    const commit = vi.spyOn(server.harness, 'commit')
    const snapshot = async (conversationId = root) =>
      post(server, '/api/extensions/status-line/actions/rates', { conversationId, args: null })
    const first = await snapshot()
    expect(first.status).toBe(200)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(first.data.result).toEqual([
      { id: root, input: 260, output: 130, cacheRead: 390, cacheWrite: 520 },
      { id: ids.child, input: 460, output: 230, cacheRead: 690, cacheWrite: 920 },
      { id: ids.nested, input: 660, output: 330, cacheRead: 990, cacheWrite: 1320 },
    ])
    commit.mockRestore()
    // Pi's settlement operation updates the model ledger and removes the partial in one commit.
    await server.harness.commit(async (tx) => {
      ;(await tx.doc(UsageDoc, root)).models['faux/model'] = message(120).usage
      delete (await tx.doc(LiveDoc, root)).generation
    }, context)
    expect((await snapshot()).data).toEqual(first.data)
    expect((await snapshot(ids.child)).data.result.map((item: { id: number }) => item.id)).toEqual([
      ids.child,
      ids.nested,
    ])
    expect(
      (
        await post(server, '/api/extensions/status-line/actions/rates', {
          conversationId: 999999,
          args: null,
        })
      ).status,
    ).toBe(500)
  } finally {
    await server.close()
  }
})
