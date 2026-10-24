import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux'
import {
  configure,
  defineExtension,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { afterEach, expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import { Metadata } from '../server/metadata.ts'
import { defineEvent } from '../shared/events.ts'
import type { SubagentsService } from '../extensions/subagents/api.ts'
import type { DreamGrantService } from '../extensions/automations/api.ts'
import { createChild } from '../extensions/subagents/children.ts'
import automations, {
  act,
  actions,
  Automations,
  userActions,
} from '../extensions/automations/server.ts'
import type { Automation } from '../extensions/automations/types.ts'
import { temp, eventHost, apis } from './helpers.ts'

/** Waits forever: it only carries a task-scoped receipt, as a running tool call's task does. */
const ToolCall = defineTask<Record<string, never>, { phase: 'wait' }, null>({
  name: 'grant-test.call',
  version: 1,
  initial: () => ({ phase: 'wait' }),
  phases: { wait: (_task, runtime, ctx) => runtime.sleepUntil(8.64e15, { phase: 'wait' }, ctx) },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
})
const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0)) await close()
  vi.useRealTimers()
})

async function fixture() {
  const root = await temp('ultimate-grant-')
  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome: root,
    home: root,
    faux: fauxProvider(),
  })
  let opened: OpenHost
  const events = eventHost(() => opened.harness, 'automations')
  const resources = new Map<string, unknown>()
  let opener: () => Promise<void>
  let closer: () => Promise<void>
  const dream = {
    start: vi.fn<DreamGrantService['start']>(async () => ({ session: 7 })),
    asleep: vi.fn<DreamGrantService['asleep']>(async () => ({ session: 7 })),
  }
  const host = {
    ...prepared,
    ...events,
    harness: () => opened.harness,
    metadata: Metadata,
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    onOpen: (fn: () => Promise<void>) => {
      opener = fn
    },
    onRelease: () => {},
    onClose: (fn: () => Promise<void>) => {
      closer = fn
    },
    ...apis(
      new Map<string, unknown>([
        ['messages', { send: async () => ({}) }],
        ['lineage', { rootOf: async () => undefined }],
        ['automations.dream', dream],
      ]),
    ),
    extensions: () => [{ name: 'subagents', enabled: true }],
    projectSetup: async () => ({ decision: false }),
    notice: (message: string) => {
      throw new Error(message)
    },
  }
  host.provided.set('subagents', {
    standing: async (name: string) => (name === 'ultimate' ? ultimate : undefined),
    createChild: (tx: Tx, options: Parameters<SubagentsService['createChild']>[1]) =>
      createChild(host, tx, options),
  })
  prepared.registry.install(automations(host as unknown as ExtensionHost))
  prepared.registry.install(defineExtension({ name: 'grant-test', tasks: [ToolCall] }))
  const answer = () => {
    prepared.faux!.appendResponses([answer])
    return fauxAssistantMessage([fauxText('OK')])
  }
  prepared.faux!.setResponses([answer])
  opened = await prepared.open()
  const [ultimate, stranger] = await opened.harness.commit(async (tx) => {
    const ids: ConversationId[] = []
    for (let i = 0; i < 2; i++) {
      const child = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await configure(tx, child.id, {})
      ids.push(child.id)
    }
    return ids
  }, context)
  await opener!()
  await events.start()
  closes.push(async () => {
    await events.stop()
    await closer!()
    await opened.close()
  })
  const action = (name: keyof typeof actions, args: JsonValue = {}) =>
    actions[name](args, { host, conversationId: ultimate } as unknown as ActionContext)
  const record = async (id: string) =>
    (await opened.harness.snapshot(Automations, context))!.automations[id]
  /** A subscriber-only automation woken on @ultimate, fired once. */
  const fired = async (grant?: string[]) => {
    const a = (await action('create', {
      name: 'Dream at 80%',
      condition: { metric: 'context', of: '@ultimate', above: 80 },
    })) as Automation
    if (grant) await action('grant', { id: a.id, actions: grant, source: 'Daniel: "do it"' })
    await action('run', { id: a.id })
    return a.id
  }
  /** A real task standing in for one `automation act` tool call: its receipt lives on it. */
  const call = () =>
    opened.harness.commit(
      async (tx) =>
        Number(
          await tx.createTask(
            ToolCall,
            {},
            {
              conversationId: ROOT_CONVERSATION_ID,
              ownership: { kind: 'conversation' },
              background: true,
            },
          ),
        ),
      context,
    )
  const acted = async () =>
    (await host.eventLog.recent({ events: [defineEvent('automations.acted')] })).map(
      (event) => event.data,
    )
  return {
    host: host as unknown as ExtensionHost,
    action,
    record,
    fired,
    acted,
    call,
    dream,
    ultimate,
    stranger,
    harness: () => opened.harness,
  }
}

it('keeps granting a user action, and validates what can be granted', async () => {
  expect(userActions).toContain('grant')
  const f = await fixture()
  const id = await f.fired()
  await expect(f.action('grant', { id, actions: ['switch'] })).rejects.toThrow('actions must be')
  const granted = (await f.action('grant', {
    id,
    actions: ['asleep', 'dream'],
    source: 'Daniel: "do it"',
  })) as Automation
  expect(granted.grant).toMatchObject({ actions: ['dream', 'asleep'], source: 'Daniel: "do it"' })
  await f.action('grant', { id, actions: [] })
  expect((await f.record(id)).grant).toBeUndefined()
})

it('refuses every action without a grant, and tells the agent to ask the user', async () => {
  const f = await fixture()
  const id = await f.fired()
  for (const name of ['dream', 'compact', 'asleep'])
    await expect(act(f.host, id, name, f.ultimate)).rejects.toThrow(`no grant for ${name}`)
  expect(f.dream.start).not.toHaveBeenCalled()
  expect(f.dream.asleep).not.toHaveBeenCalled()
  expect(await f.acted()).toEqual([])
})

it('allows only what the grant names: a dream grant never falls asleep or compacts', async () => {
  const f = await fixture()
  const id = await f.fired(['dream'])
  await expect(act(f.host, id, 'asleep', f.ultimate)).rejects.toThrow('no grant for asleep')
  await expect(act(f.host, id, 'compact', f.ultimate)).rejects.toThrow('no grant for compact')
  expect(f.dream.asleep).not.toHaveBeenCalled()
  const [first, second, third, fourth] = [
    await f.call(),
    await f.call(),
    await f.call(),
    await f.call(),
  ]
  const result = await act(f.host, id, 'dream', f.ultimate, first)
  expect(result).toMatchObject({ action: 'dream', session: 7, automation: id })
  expect(f.dream.start).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ automation: id, name: 'Dream at 80%' }),
    f.ultimate,
  )
  // Once per fire: another call is refused. The same tool call replayed returns its recorded result and does not
  // start a second dream.
  await expect(act(f.host, id, 'dream', f.ultimate, second)).rejects.toThrow('already used')
  expect(await act(f.host, id, 'dream', f.ultimate, first)).toMatchObject({ session: 7 })
  expect(f.dream.start).toHaveBeenCalledOnce()
  expect(await f.acted()).toHaveLength(1)
  // Saving the grant again, or widening it, does not hand back the act this fire already used.
  await f.action('grant', { id, actions: ['dream', 'compact'] })
  await expect(act(f.host, id, 'dream', f.ultimate, fourth)).rejects.toThrow('already used')
  // The next fire may act again. A replay of the first call after it still returns the first call's result.
  await f.action('run', { id })
  expect(await act(f.host, id, 'dream', f.ultimate, first)).toMatchObject({ session: 7 })
  expect(f.dream.start).toHaveBeenCalledOnce()
  await act(f.host, id, 'dream', f.ultimate, third)
  expect(f.dream.start).toHaveBeenCalledTimes(2)
  expect(await f.acted()).toHaveLength(2)
})

it('keeps each call its own receipt however many acts follow, in any task order', async () => {
  const f = await fixture()
  const id = await f.fired(['dream'])
  // An early call that acts late: many later calls, and later fires, act in between.
  const late = await f.call()
  const others = []
  for (let i = 0; i < 25; i++) others.push(await f.call())
  for (const call of others) {
    await act(f.host, id, 'dream', f.ultimate, call)
    await f.action('resume', { id })
    await f.harness().commit(async (tx) => {
      // A new fire without the hourly cap: this test is about receipts, not floods.
      const a = (await tx.doc(Automations)).automations[id]
      a.fires++
      a.recentFires = []
    }, context)
  }
  await act(f.host, id, 'dream', f.ultimate, late)
  const calls = f.dream.start.mock.calls.length
  for (const call of [late, ...others])
    expect(await act(f.host, id, 'dream', f.ultimate, call)).toMatchObject({ action: 'dream' })
  expect(f.dream.start).toHaveBeenCalledTimes(calls)
})

it('passes a granted Fall asleep to dream, which runs every gate', async () => {
  const f = await fixture()
  const id = await f.fired(['asleep'])
  await expect(act(f.host, id, 'dream', f.ultimate)).rejects.toThrow('no grant for dream')
  expect(await act(f.host, id, 'asleep', f.ultimate)).toMatchObject({ action: 'asleep' })
  expect(f.dream.asleep).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ automation: id, name: 'Dream at 80%' }),
    {},
  )
  expect(f.dream.start).not.toHaveBeenCalled()
})

it('refuses a conversation it does not wake, a paused automation and a stale fire', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await fixture()
  const id = await f.fired(['dream'])
  await expect(act(f.host, id, 'dream', f.stranger)).rejects.toThrow('is not woken by')
  await f.action('pause', { id })
  await expect(act(f.host, id, 'dream', f.ultimate)).rejects.toThrow('is paused')
  await f.action('resume', { id })
  vi.setSystemTime(Date.now() + 6 * 3600_000 + 1)
  await expect(act(f.host, id, 'dream', f.ultimate)).rejects.toThrow('last six hours')
  const never = (await f.action('create', {
    name: 'Never fired',
    event: { name: 'update.applied' },
  })) as Automation
  await f.action('grant', { id: never.id, actions: ['dream'] })
  await expect(act(f.host, never.id, 'dream', f.ultimate)).rejects.toThrow('last six hours')
  expect(f.dream.start).not.toHaveBeenCalled()
})

it('compacts the conversation a context trigger watches', async () => {
  const f = await fixture()
  const id = await f.fired(['compact'])
  const call = await f.call()
  const result = (await act(f.host, id, 'compact', f.ultimate, call)) as unknown as {
    taskId: number
  }
  expect(result).toMatchObject({ action: 'compact', conversation: f.ultimate })
  const task = await f.harness().getTask(result.taskId as never, context)
  expect(task).toMatchObject({ conversationId: f.ultimate })
  // A replay of the call returns the same compaction, created once with the act.
  expect(await act(f.host, id, 'compact', f.ultimate, call)).toMatchObject({
    taskId: result.taskId,
  })
})
