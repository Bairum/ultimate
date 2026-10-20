import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool, LiveDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import pauseExtension, { actions } from '../extensions/pause/server.ts'
import { lasted } from '../extensions/pause/lasted.ts'
import { PauseApi } from '../extensions/pause/api.ts'
import { apis, removeTemps, temp, until } from './helpers.ts'

const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  await removeTemps()
})

/** A faux harness with the pause extension and a `work` tool that runs until the test releases it, as bash would. */
async function fixture(home?: string) {
  home ??= await temp('ultimate-pause-')
  const prepared = await prepareHarness({ ultimateRoot: home, userHome: home, home, faux: true })
  let finish: (() => void) | undefined
  let finished = 0
  prepared.registry.install(
    defineExtension({
      name: 'pause-test',
      tools: [
        defineTool({
          name: 'work',
          description: 'Work until released',
          parameters: Type.Object({}),
          execute: async () => {
            await new Promise<void>((resolve) => {
              finish = resolve
            })
            finished++
            return { output: [{ type: 'text', text: 'worked' }] }
          },
        }),
      ],
    }),
  )
  let opened: OpenHost | undefined
  const services = apis()
  const openers: (() => Promise<void>)[] = []
  const host = {
    ...services,
    harness: () => opened!.harness,
    resource: (() => {
      const resources = new Map<string, unknown>()
      return <T>(key: string, create: () => T) => {
        if (!resources.has(key)) resources.set(key, create())
        return resources.get(key) as T
      }
    })(),
    onOpen: (callback: () => Promise<void>) => void openers.push(callback),
    conversations: () => [],
  } as unknown as ExtensionHost
  prepared.registry.install(pauseExtension(host))
  /** Open as the server does: the openers settle first, then scheduling resumes. */
  const open = async () => {
    opened = await prepared.open(false)
    hosts.push(opened)
    for (const callback of openers) await callback()
    opened.harness.resume()
    return opened
  }
  const action = (name: keyof typeof actions) =>
    actions[name](null, { host } as unknown as ActionContext)
  return {
    home,
    prepared,
    open,
    action,
    paused: () => services.want(PauseApi)!.paused(),
    get opened() {
      return opened!
    },
    get finish() {
      return finish
    },
    finished: () => finished,
    async close() {
      await opened!.close()
      hosts.splice(hosts.indexOf(opened!), 1)
    },
  }
}

const generations = async (harness: Harness) =>
  (await harness.inspect(context)).tasks.filter(({ record }) => record.kind === 'pi.generation')

it('lets a running tool finish, starts no generation after it while paused, and continues on play', async () => {
  const f = await fixture()
  let responses = 0
  f.prepared.faux!.setResponses([
    () => {
      responses++
      return fauxAssistantMessage([fauxToolCall('work', {})], { stopReason: 'toolUse' })
    },
    () => {
      responses++
      return fauxAssistantMessage([fauxText('done')])
    },
  ])
  const { root, harness } = await f.open()
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(() => f.finish !== undefined)

  const pausing = await f.action('pause')
  expect(pausing.paused).toBe(true)
  expect(pausing.running.map((task) => task.what)).toEqual(['work'])
  expect(f.paused()).toBe(true)
  expect((await harness.inspect(context)).scheduling).toBe('paused')

  // The tool finishes on its own; the generation that waited for it parks instead of asking for the next response.
  f.finish!()
  await until(async () => (await f.action('state')).running.length === 0)
  expect(f.finished()).toBe(1)
  expect(responses).toBe(1)
  // Its tool ended, so the generation could take its next step; held, it is only ready.
  const [generation] = await generations(harness)
  expect(generation.state.kind).toBe('ready')
  // A submit or wait asks Pi to resume scheduling; the hold wins.
  await root.submit({ type: 'input', content: 'queued meanwhile' }, context)
  harness.resume()
  await Promise.resolve()
  expect((await harness.inspect(context)).scheduling).toBe('paused')
  expect(responses).toBe(1)

  const played = await f.action('play')
  expect(played.paused).toBe(false)
  expect(f.paused()).toBe(false)
  await submission.wait(context)
  expect(responses).toBeGreaterThanOrEqual(2)
  const notes = (await root.context(context)).entries.filter((entry) => entry.kind === 'pause.note')
  expect(notes).toHaveLength(1)
  expect(notes[0].model?.[0]?.content).toMatch(/^Paused for \d+s; the run continued after Play\.$/)
})

it('reopens paused: nothing starts until play', async () => {
  const f = await fixture()
  let responses = 0
  f.prepared.faux!.setResponses([
    () => {
      responses++
      return fauxAssistantMessage([fauxText('answer')])
    },
  ])
  await f.open()
  await f.action('pause')
  await f.close()

  const reopened = await f.open()
  expect(f.paused()).toBe(true)
  expect((await reopened.harness.inspect(context)).scheduling).toBe('paused')
  const submission = await reopened.root.submit({ type: 'input', content: 'hello' }, context)
  await new Promise((resolve) => setImmediate(resolve))
  expect(responses).toBe(0)
  const [generation] = await generations(reopened.harness)
  expect(generation.record.state.status).toBe('pending')
  expect(generation.state.kind).toBe('ready')

  await f.action('play')
  await submission.wait(context)
  expect(responses).toBe(1)
  // Idle when paused: no note.
  const entries = (await reopened.root.context(context)).entries
  expect(entries.some((entry) => entry.kind === 'pause.note')).toBe(false)
})

it('leaves a note only on runs that were mid-turn, once, and none on idle conversations', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () => fauxAssistantMessage([fauxToolCall('work', {})], { stopReason: 'toolUse' }),
    () => fauxAssistantMessage([fauxText('done')]),
  ])
  const { root, harness } = await f.open()
  const idle = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(() => f.finish !== undefined)
  await f.action('pause')
  f.finish!()
  await until(async () => (await f.action('state')).running.length === 0)
  await f.action('play')
  // A second Play finds nothing paused and leaves nothing.
  await f.action('play')
  await submission.wait(context)
  const notes = async (id: ConversationId) =>
    (await (await harness.conversation(id, context))!.context(context)).entries.filter(
      (entry) => entry.kind === 'pause.note',
    )
  expect(await notes(root.id)).toHaveLength(1)
  expect(await notes(idle.id)).toEqual([])
  expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined()
})

it('words how long a pause lasted', () => {
  expect(lasted(40_000)).toBe('40s')
  expect(lasted(5 * 60_000)).toBe('5m')
  expect(lasted((2 * 60 + 14) * 60_000)).toBe('2h 14m')
})
