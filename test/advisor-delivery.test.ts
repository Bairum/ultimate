import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux'
import {
  Harness,
  MemoryStorage,
  createRegistry,
  LiveDoc,
  InboxDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { GenerationHooks, HookApi } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import advisor from '../extensions/advisor/server.ts'
import { deliver, route } from '../extensions/advisor/deliver.ts'
import { mergeConfig } from '../extensions/advisor/config.ts'
import { Runs, State, utcDay } from '../extensions/advisor/state.ts'
import { review } from '../extensions/advisor/review.ts'
import { Standing, Profile } from '../extensions/subagents/api.ts'
import type { AdvisorNoteEntry, Role } from '../extensions/advisor/refs.ts'

import { until } from './helpers.ts'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
const notes = [{ severity: 'blocker' as const, note: 'Required check failed', evidence: '#12' }]
async function fixture(role: Role = 'worker') {
  const home = await mkdtemp(join(tmpdir(), 'advisor-delivery-'))
  await mkdir(join(home, '.ultimate'))
  const config = mergeConfig(
    {
      model: 'faux/faux',
      roles: { [role]: { enabled: true, advisors: ['verification'], quietMs: 0 } },
    },
    {},
  )
  await writeFile(join(home, '.ultimate/settings.json'), JSON.stringify({ advisor: config }))
  const registry = createRegistry()
  const models = createModels()
  const response = fauxAssistantMessage([fauxText(JSON.stringify({ notes }))])
  const stream = vi
    .spyOn(models, 'streamSimple')
    .mockImplementation(() => ({ result: async () => response }) as never)
  const getModel = vi
    .spyOn(models, 'getModel')
    .mockReturnValue({ provider: 'faux', id: 'faux' } as never)
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context)
  const root = await harness.root(context)
  const child = await harness.commit(
    (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
    context,
  )
  const id = child.id
  const close = vi.fn<() => Promise<void>>(async () => {})
  const accountResponse = vi.fn<() => Promise<void>>(async () => {})
  const emit = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
  const host = {
    userHome: home,
    projectRoot: home,
    harness: () => harness,
    projectSetup: async () => ({ config: false, decision: false }),
    projectSettings: async () => ({}),
    notice: vi.fn<(message: string) => void>(),
    conversations: () => [{ id, label: role, busy: false, cwd: home }],
    doc: () => undefined,
    want: () => undefined,
    need: () => ({ accountResponse }),
    emit,
    onClose: (fn: () => Promise<void>) => {
      close.mockImplementation(fn)
    },
  } as unknown as ExtensionHost
  const extension = advisor(host)
  registry.install(extension)
  const hooks = extension.hooks![0].handlers as GenerationHooks
  await harness.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, id)
    live.run = { inputs: [100], taskId: 1000 } as never
    ;(await tx.doc(Profile, id)).definition = role
    if (role === 'ultimate') (await tx.doc(Standing, root.id)).ultimate = id
  }, context)
  let task = 1000
  const api = () => {
    const memos = new Map<string, JsonValue>()
    return {
      conversationId: id,
      taskId: ++task,
      models,
      snapshot: harness.snapshot.bind(harness),
      memo: async (key: string, value: unknown, ctx?: unknown) => {
        if (ctx === undefined) return memos.get(key)
        if (!memos.has(key)) memos.set(key, value as JsonValue)
        return memos.get(key)
      },
    } as unknown as HookApi
  }
  cleanups.push(async () => {
    await close()
    await harness.close(context)
    stream.mockRestore()
    getModel.mockRestore()
    await rm(home, { recursive: true, force: true })
  })
  return { host, harness, id, config, hooks, api, stream, response, emit }
}
it('routes quiet periods, idle and ultimate without waking ultimate', () => {
  const profile = {
    delivery: 'card' as const,
    continueOn: 'blocker' as const,
    steerOn: 'concern' as const,
    quietMs: 100,
  }
  expect(route('worker', profile, 'answer', notes, 0, 200, false, false)).toBe('continue')
  expect(route('worker', profile, 'answer', notes, 0, 200, true, false)).toBe('card')
  expect(route('worker', profile, 'answer', notes, 150, 200, false, false)).toBe('note')
  expect(route('worker', profile, 'rounds', notes, 0, 200, false, false)).toBe('steer')
  expect(route('worker', profile, 'rounds', notes, 150, 200, false, false)).toBe('note')
  expect(route('worker', profile, 'idle', notes, 0, 200, false, false)).toBe('card')
  for (const point of ['answer', 'rounds', 'idle', 'signals'] as const) {
    expect(route('ultimate', profile, point, notes, undefined, 200, false, false)).toBe('card')
    expect(route('ultimate', profile, point, notes, undefined, 200, false, true)).toBe('note')
  }
})
it('writes a card without model context, and a note as passive user context', async () => {
  const f = await fixture()
  await f.harness.commit(async (tx) => {
    delete (await tx.doc(LiveDoc, f.id)).run
  }, context)
  f.harness.resume()
  const entry: AdvisorNoteEntry = {
    review: 'card',
    advisor: 'verification',
    role: 'worker',
    point: 'answer',
    model: 'faux/faux',
    delivered: 'card',
    notes: notes.map((n) => ({ ...n, id: 'n1' })),
  }
  await deliver(f.host, f.id, entry, context)
  await deliver(f.host, f.id, { ...entry, review: 'note', delivered: 'note' }, context)
  const conversation = (await f.harness.conversation(f.id, context))!
  await until(async () => (await conversation.context(context)).messages.length === 1)
  const entries = (await conversation.entries({ order: 'ascending' }, 20, undefined, context)).items
  expect(
    entries.find((e) => (e.data as AdvisorNoteEntry)?.review === 'card')?.model,
  ).toBeUndefined()
  expect(
    entries.find((e) => (e.data as AdvisorNoteEntry)?.review === 'note')?.model?.[0],
  ).toMatchObject({ role: 'user', content: expect.stringContaining('<advisory') })
  expect((await conversation.context(context)).messages).toHaveLength(1)
})
it('continues at most once per run, even on a new generation', async () => {
  const f = await fixture()
  const yielded = await f.hooks.onYield(fauxAssistantMessage('I am finished'), f.api(), context)
  expect(JSON.stringify(f.stream.mock.calls[0]?.[1])).toContain('I am finished')
  expect(yielded).toMatchObject({ continue: expect.stringContaining('Required check failed') })
  // A different blocker in the following generation must not trigger another continuation.
  f.response.content = [
    fauxText(JSON.stringify({ notes: [{ ...notes[0], note: 'Another failed check' }] })),
  ]
  expect(await f.hooks.onYield(f.response, f.api(), context)).toBeUndefined()
  expect(
    (await f.harness.snapshot(Runs, ROOT_CONVERSATION_ID, context))?.conversations[f.id]?.continued,
  ).toBe(true)
})
it('ultimate schedules a background review and never holds its answer or calls a model inline', async () => {
  const f = await fixture('ultimate')
  expect(await f.hooks.onYield(f.response, f.api(), context)).toBeUndefined()
  expect(f.stream).not.toHaveBeenCalled()
  expect(
    (await f.harness.snapshot(Runs, ROOT_CONVERSATION_ID, context))?.conversations[f.id]?.pending,
  ).toBeDefined()
})
it('skips exhausted global and role budgets before a model call and emits the skip', async () => {
  const f = await fixture()
  for (const roleBudget of [false, true]) {
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(State, ROOT_CONVERSATION_ID)
      state.spend[utcDay(Date.now())] = { total: roleBudget ? 1 : 5, roles: { worker: 1 } }
    }, context)
    const config = {
      ...f.config,
      roles: {
        ...f.config.roles,
        worker: { ...f.config.roles?.worker, ...(roleBudget ? { dayUsd: 1 } : {}) },
      },
    }
    await review(
      f.host,
      f.api(),
      { role: 'worker', point: 'answer', run: 100 },
      config,
      [],
      context,
    )
    expect(
      (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))?.conversations[f.id]
        ?.lastSkip,
    ).toBe('budget')
  }
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.emit).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ skipped: 'budget' }),
  )
})
it('offers checkout tools on the first turn and replays model steps and read results without calls', async () => {
  const f = await fixture()
  const toolResponse = fauxAssistantMessage([
    { type: 'toolCall', id: 'read1', name: 'advisor_read', arguments: { path: 'example.ts' } },
  ])
  toolResponse.stopReason = 'toolUse'
  f.stream.mockImplementationOnce(() => ({ result: async () => toolResponse }) as never)
  await writeFile(join(f.host.projectRoot, 'example.ts'), 'export const example = true')
  const api = f.api()
  const first = await f.hooks.onYield(fauxAssistantMessage('Finished the change'), api, context)
  expect(first).toMatchObject({ continue: expect.stringContaining('Required check failed') })
  expect(f.stream).toHaveBeenCalledTimes(2)
  expect(f.stream.mock.calls[0]?.[1].tools?.map((t) => t.name)).toEqual([
    'advisor_read',
    'advisor_grep',
  ])
  expect(JSON.stringify(f.stream.mock.calls[1]?.[1].messages)).toContain(
    'export const example = true',
  )
  expect(await f.hooks.onYield(fauxAssistantMessage('Finished the change'), api, context)).toEqual(
    first,
  )
  expect(f.stream).toHaveBeenCalledTimes(2)
})
it.each(['brief', 'steer', 'parent note'] as const)(
  'only mid-run intervention suppresses continuation: %s',
  async (intervention) => {
    const f = await fixture()
    f.config.roles!.worker!.quietMs = 600_000
    await writeFile(
      join(f.host.userHome, '.ultimate/settings.json'),
      JSON.stringify({ advisor: f.config }),
    )
    const now = Date.now()
    const brief = await f.harness.commit(async (tx) => {
      const first = await tx.appendEntry(f.id, {
        kind: 'pi.user',
        model: [
          {
            role: 'user',
            content: 'Implement the task',
            timestamp: now - (intervention === 'brief' ? 60_000 : 120_000),
          },
        ],
      })
      if (intervention !== 'brief')
        await tx.appendEntry(f.id, {
          kind: intervention === 'steer' ? 'pi.user' : 'board.message',
          ...(intervention === 'parent note' ? { data: { from: 1 } } : {}),
          model: [
            { role: 'user', content: 'Use the corrected requirement', timestamp: now - 60_000 },
          ],
        })
      // An earlier run's quiet marker must not suppress the new brief either.
      const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
      runs.conversations[f.id] = { run: 99, rounds: 0, signals: [], lastInput: now - 30_000 }
      ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = 1 as never
      return first
    }, context)
    const submission = vi.spyOn(f.harness, 'submission').mockResolvedValue({
      status: async () => ({ type: 'input', status: 'placed', entry: brief.id }),
    } as never)
    try {
      const yielded = await f.hooks.onYield(fauxAssistantMessage('Finished'), f.api(), context)
      expect(yielded !== undefined).toBe(intervention === 'brief')
      const inbox = await f.harness.snapshot(InboxDoc, f.id, context)
      expect(
        inbox?.items.some(
          (item) =>
            item.mode === 'write' && (item.entry.data as AdvisorNoteEntry)?.delivered === 'note',
        ),
      ).toBe(intervention !== 'brief')
    } finally {
      submission.mockRestore()
    }
  },
)
