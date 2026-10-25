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
import advisor, { actions } from '../extensions/advisor/server.ts'
import { deliver, route } from '../extensions/advisor/deliver.ts'
import { mergeConfig } from '../extensions/advisor/config.ts'
import { Runs, State, Ledger, utcDay } from '../extensions/advisor/state.ts'
import { review, runEntries } from '../extensions/advisor/review.ts'
import { renderInput } from '../extensions/advisor/render.ts'
import { Standing, Profile } from '../extensions/subagents/api.ts'
import type { AdvisorNoteEntry, Role } from '../extensions/advisor/refs.ts'
import { closeOut, expireNotes } from '../extensions/advisor/lifecycle.ts'
vi.mock('../lib/exec.ts', () => ({
  exec: async () => {
    throw Object.assign(new Error('not ignored'), { code: 1 })
  },
}))

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
  await f.harness.commit(async (tx) => {
    const state = await tx.doc(State, ROOT_CONVERSATION_ID)
    for (const id of ['n1', 'n2'])
      state.notes.push({
        ...entry.notes[0],
        id,
        conversation: f.id,
        advisor: entry.advisor,
        role: entry.role,
        point: entry.point,
        at: Date.now(),
        status: 'open',
      })
  }, context)
  await deliver(f.host, f.id, entry, context)
  await deliver(
    f.host,
    f.id,
    {
      ...entry,
      review: 'note',
      delivered: 'note',
      notes: entry.notes.map((n) => ({ ...n, id: 'n2' })),
    },
    context,
  )
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
  const stored = (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes
  expect(stored.find((n) => n.id === 'n1')?.entry).toBe(
    entries.find((e) => (e.data as AdvisorNoteEntry)?.review === 'card')?.id,
  )
  expect(stored.find((n) => n.id === 'n2')?.entry).toBe(
    entries.find((e) => (e.data as AdvisorNoteEntry)?.review === 'note')?.id,
  )
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
it('keeps the original brief after an advisor continuation and never counts its own text as intervention', async () => {
  const f = await fixture()
  const brief = await f.harness.commit(
    (tx) =>
      tx.appendEntry(f.id, {
        kind: 'pi.user',
        model: [
          {
            role: 'user',
            content: 'Verify the actual requested change',
            timestamp: Date.now() - 120_000,
          },
        ],
      }),
    context,
  )
  const submission = vi.spyOn(f.harness, 'submission').mockResolvedValue({
    status: async () => ({ type: 'input', status: 'placed', entry: brief.id }),
  } as never)
  try {
    const first = await f.hooks.onYield(fauxAssistantMessage('Done'), f.api(), context)
    expect(first).toBeDefined()
    const runs = await f.harness.snapshot(Runs, ROOT_CONVERSATION_ID, context)
    expect(Object.values(runs!.deliveries).some((e) => e.delivered === 'continue')).toBe(false)
    const continuation = await f.harness.commit(
      (tx) =>
        tx.appendEntry(f.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: first!.continue, timestamp: Date.now() - 60_000 }],
        }),
      context,
    )
    const entries = await runEntries(f.host, f.id, context)
    expect(entries.map((e) => e.id)).not.toContain(continuation.id)
    const recorded = runs!.conversations[f.id].continuations!
    expect(
      JSON.parse(
        renderInput(
          [brief, continuation],
          'worker',
          '',
          '',
          undefined,
          undefined,
          undefined,
          false,
          recorded,
        ),
      ).request,
    ).toBe('Verify the actual requested change')
    f.response.content = [
      fauxText(JSON.stringify({ notes: [{ ...notes[0], note: 'Still needs verification' }] })),
    ]
    await f.hooks.onYield(fauxAssistantMessage('Done again'), f.api(), context)
    expect(JSON.stringify(f.stream.mock.calls.at(-1)?.[1].messages)).not.toContain('<advisory')
    expect(
      (await f.harness.snapshot(Runs, ROOT_CONVERSATION_ID, context))?.conversations[f.id]
        ?.lastInput,
    ).toBeUndefined()
  } finally {
    submission.mockRestore()
  }
})
it('does not let newly invented ledger items authorize a passive ultimate note, and bounds the ledger', async () => {
  const f = await fixture('ultimate')
  await f.harness.commit(async (tx) => {
    const ledger = await tx.doc(Ledger, f.id)
    ledger.items = Array.from({ length: 50 }, (_, i) => ({
      id: `old${i}`,
      kind: 'question' as const,
      text: `Old question ${i}`,
      since: i,
    }))
  }, context)
  f.response.content = [
    fauxText(
      JSON.stringify({
        notes: [{ ...notes[0], evidence: '#123' }],
        ledger: {
          add: Array.from({ length: 10 }, (_, i) => ({
            kind: 'question',
            text: `Invented question ${i}`,
            entry: 123,
          })),
          resolve: [],
        },
      }),
    ),
  ]
  await review(
    f.host,
    f.api(),
    { role: 'ultimate', point: 'answer', run: 100 },
    f.config,
    [],
    context,
  )
  const conversation = (await f.harness.conversation(f.id, context))!
  const entries = (await conversation.entries({ order: 'ascending' }, 20, undefined, context)).items
  expect(entries.find((e) => e.kind === 'advisor.note')?.data).toMatchObject({ delivered: 'card' })
  const ledger = (await f.harness.snapshot(Ledger, f.id, context))!.items
  expect(ledger).toHaveLength(50)
  expect(ledger.filter((i) => i.text.startsWith('Invented'))).toHaveLength(5)
  expect(ledger.some((i) => i.id === 'old0')).toBe(false)
})
it.each(['idle', 'new run'] as const)(
  'downgrades a stale steer to a passive note: %s',
  async (state) => {
    const f = await fixture()
    await f.harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, f.id)
      if (state === 'idle') delete live.run
      else live.run!.inputs = [200 as never]
    }, context)
    const recipient = (await f.harness.conversation(f.id, context))!
    const submit = vi
      .spyOn(recipient, 'submit')
      .mockResolvedValue({ status: async () => ({ type: 'write', status: 'queued' }) } as never)
    const conversation = vi.spyOn(f.harness, 'conversation').mockResolvedValue(recipient)
    try {
      const entry: AdvisorNoteEntry = {
        review: 'stale',
        advisor: 'verification',
        role: 'worker',
        point: 'rounds',
        model: 'faux/faux',
        delivered: 'steer',
        notes: notes.map((n) => ({ ...n, id: 'stale-note' })),
      }
      await deliver(f.host, f.id, entry, context, 100)
      expect(submit.mock.calls[0]?.[0]).toMatchObject({
        type: 'write',
        entry: { data: { delivered: 'note' }, model: [{ role: 'user' }] },
      })
    } finally {
      submit.mockRestore()
      conversation.mockRestore()
    }
  },
)

async function lifecycleNote(
  f: Awaited<ReturnType<typeof fixture>>,
  delivery: AdvisorNoteEntry['delivered'] = 'note',
) {
  const api = f.api()
  await review(
    f.host,
    api,
    { role: 'worker', point: 'rounds', run: 100 },
    {
      ...f.config,
      roles: {
        worker: {
          enabled: true,
          advisors: ['verification'],
          delivery: delivery === 'card' ? 'card' : 'note',
          steerOn: 'never',
        },
      },
    },
    [],
    context,
  )
  return (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes.at(-1)!
}
it('tracks request reads without changing messages; continuations are read at delivery, cards never are', async () => {
  const f = await fixture()
  const note = await lifecycleNote(f)
  const messages = [
    { role: 'user' as const, content: `<advisory id="${note.ref}">test</advisory>`, timestamp: 0 },
  ]
  const original = structuredClone(messages)
  expect(await f.hooks.beforeRequest({ messages }, f.api(), context)).toBeUndefined()
  expect(messages).toEqual(original)
  expect((await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0].readAt).toEqual(
    expect.any(Number),
  )
  const g = await fixture()
  await g.hooks.onYield(fauxAssistantMessage([fauxText('done')]), g.api(), context)
  expect((await g.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0]).toMatchObject({
    delivered: 'continue',
    readAt: expect.any(Number),
  })
  const h = await fixture()
  const card = await lifecycleNote(h, 'card')
  await h.hooks.beforeRequest(
    { messages: [{ ...messages[0], content: `<advisory id="${card.ref}">test</advisory>` }] },
    h.api(),
    context,
  )
  expect(
    (await h.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0].readAt,
  ).toBeUndefined()
})
it.each(['addressed', 'deferred', 'disputed'])(
  'records %s acknowledgements and lets a later ack replace them',
  async (status) => {
    const f = await fixture()
    const note = await lifecycleNote(f)
    await f.hooks.beforeRequest(
      {
        messages: [
          { role: 'user', content: `<advisory id="${note.ref}">test</advisory>`, timestamp: 0 },
        ],
      },
      f.api(),
      context,
    )
    await f.hooks.afterResponse(
      fauxAssistantMessage([
        fauxText(`ADVISOR ${note.ref}: ${status.toUpperCase()} — because tests`),
      ]),
      f.api(),
      context,
    )
    expect(
      (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0].response,
    ).toMatchObject({ status, source: 'ack', reason: 'because tests' })
    await f.hooks.afterResponse(
      fauxAssistantMessage([fauxText(`advisor ${note.ref}: deferred: later`)]),
      f.api(),
      context,
    )
    expect(
      (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0].response,
    ).toMatchObject({ status: 'deferred', reason: 'later' })
  },
)
it('judges read notes once, resolves acknowledgements without a model, and preserves user closes', async () => {
  const f = await fixture()
  const note = await lifecycleNote(f)
  await f.hooks.beforeRequest(
    {
      messages: [
        { role: 'user', content: `<advisory id="${note.ref}">test</advisory>`, timestamp: 0 },
      ],
    },
    f.api(),
    context,
  )
  f.response.content = [
    fauxText(JSON.stringify({ status: 'addressed', reason: 'check rerun', evidence: '#23' })),
  ]
  f.response.usage.cost.total = 0.02
  const api = f.api()
  const before = f.stream.mock.calls.length
  expect((await f.harness.snapshot(Runs, ROOT_CONVERSATION_ID, context))?.readRuns).toEqual({
    [note.id]: 100,
  })
  await closeOut(f.host, api, { run: 100, latest: 'check passed' }, f.config, context)
  await closeOut(f.host, api, { run: 100, latest: 'check passed' }, f.config, context)
  expect(f.stream.mock.calls.length - before).toBe(1)
  const state = (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!
  expect(state.notes[0]).toMatchObject({
    status: 'resolved',
    closedBy: 'auto',
    response: { status: 'addressed', source: 'judged', evidence: '#23' },
  })
  expect(state.spend[utcDay(Date.now())].roles.worker).toBe(0.02)
  expect(f.stream.mock.calls.at(-1)![1].tools).toBeUndefined()
  const g = await fixture()
  const ack = await lifecycleNote(g)
  await g.hooks.beforeRequest(
    {
      messages: [
        { role: 'user', content: `<advisory id="${ack.ref}">test</advisory>`, timestamp: 0 },
      ],
    },
    g.api(),
    context,
  )
  await g.hooks.afterResponse(
    fauxAssistantMessage([fauxText(`advisor ${ack.ref}: disputed - not relevant`)]),
    g.api(),
    context,
  )
  await actions.feedback({ note: ack.id, status: 'dismissed', reason: 'false-alarm' }, {
    host: g.host,
  } as never)
  const calls = g.stream.mock.calls.length
  await closeOut(g.host, g.api(), { run: 100, latest: 'done' }, g.config, context)
  expect(g.stream).toHaveBeenCalledTimes(calls)
  expect((await g.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0]).toMatchObject({
    status: 'dismissed',
    closedBy: 'user',
    dismissReason: 'false-alarm',
    response: { status: 'disputed', source: 'ack' },
  })
})
it('records late and unread notes on the five-minute tick and reports lifecycle stats', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval')
  const f = await fixture()
  const tick = interval.mock.calls.at(-1)![0] as () => void
  interval.mockRestore()
  const note = await lifecycleNote(f)
  await f.harness.commit(async (tx) => {
    const state = await tx.doc(State, ROOT_CONVERSATION_ID)
    state.notes.push({ ...state.notes[0], id: 'unread', ref: 'unred', at: note.at - 100 })
  }, context)
  vi.spyOn(f.host, 'want').mockReturnValue({ concluded: async () => new Set([f.id]) })
  vi.spyOn(f.host, 'conversations').mockReturnValue([
    {
      id: f.id,
      label: 'worker',
      busy: false,
      answerAt: note.at - 1,
      inputAt: note.at - 10,
      cwd: f.host.projectRoot,
    },
  ] as never)
  tick()
  await until(async () =>
    (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes.every(
      (n) => n.response,
    ),
  )
  const state = (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!
  expect(state.notes.map((n) => n.response?.status)).toEqual(['late', 'unread'])
  expect(state.notes.every((n) => n.status === 'resolved' && n.closedBy === 'auto')).toBe(true)
  expect(await actions.stats({ days: 7 }, { host: f.host } as never)).toMatchObject({
    roles: { worker: { delivered: 2, read: 0, late: 1, unread: 1, pending: 0 } },
  })
})
it('skips a pending delivery dismissed by the user', async () => {
  const f = await fixture()
  const note = {
    ...notes[0],
    id: 'pending-note',
    ref: 'pend1',
    conversation: f.id,
    advisor: 'verification',
    role: 'worker' as const,
    point: 'rounds' as const,
    at: Date.now(),
    status: 'open' as const,
    delivered: 'note' as const,
  }
  const entry: AdvisorNoteEntry = {
    review: 'pending',
    advisor: 'verification',
    role: 'worker',
    point: 'rounds',
    model: 'faux/faux',
    delivered: 'note',
    notes: [{ ...notes[0], id: note.id, ref: note.ref }],
  }
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(State, ROOT_CONVERSATION_ID)).notes.push(note)
    ;(await tx.doc(Runs, ROOT_CONVERSATION_ID)).deliveries.pending = entry
  }, context)
  await actions.feedback({ note: note.id, status: 'dismissed', reason: 'handled' }, {
    host: f.host,
  } as never)
  const conversation = (await f.harness.conversation(f.id, context))!
  const before = (await conversation.entries({ order: 'ascending' }, 100, undefined, context)).items
    .length
  await deliver(f.host, f.id, entry, context)
  expect(
    (await f.harness.snapshot(Runs, ROOT_CONVERSATION_ID, context))!.deliveries.pending,
  ).toBeUndefined()
  expect(
    (await conversation.entries({ order: 'ascending' }, 100, undefined, context)).items,
  ).toHaveLength(before)
  await expireNotes(f.host, f.config, new Set([f.id]), context)
  const retained = (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0]
  expect(retained).not.toHaveProperty('delivered')
  expect(retained).not.toHaveProperty('response')
  expect(await actions.stats(null, { host: f.host } as never)).toMatchObject({
    roles: { worker: { delivered: 0, read: 0, dismissed: 1, late: 0, unread: 0, pending: 0 } },
  })
})
it('manages explicit notes or all matching filters, archives only closed notes, and reopens cleanly', async () => {
  const f = await fixture()
  const note = await lifecycleNote(f)
  await f.harness.commit(async (tx) => {
    const state = await tx.doc(State, ROOT_CONVERSATION_ID)
    state.notes[0].at = Date.now() - 3 * 86_400_000
    state.notes.push(
      { ...state.notes[0], id: 'newer', at: Date.now() },
      { ...state.notes[0], id: 'other-role', role: 'scout' },
      { ...state.notes[0], id: 'other-conversation', conversation: 999 },
    )
  }, context)
  const ctx = { host: f.host } as never
  const snoozeUntil = Date.now() + 60_000
  expect(await actions.feedback({ note: note.id, snoozeUntil }, ctx)).toMatchObject({
    snoozedUntil: snoozeUntil,
  })
  expect(await actions.feedback({ note: note.id, snoozeUntil: null }, ctx)).not.toHaveProperty(
    'snoozedUntil',
  )
  await expect(
    actions.feedback({ note: note.id, snoozeUntil: Date.now() + 31 * 86_400_000 }, ctx),
  ).rejects.toThrow('Invalid feedback')
  await expect(
    actions.feedback({ note: note.id, status: 'dismissed', reason: 'bad' }, ctx),
  ).rejects.toThrow('Invalid feedback')
  expect(await actions.manage({ do: 'archive', notes: [note.id] }, ctx)).toEqual({ changed: 0 })
  expect(
    await actions.manage(
      {
        do: 'dismiss',
        conversation: f.id,
        role: 'worker',
        status: 'open',
        olderThanDays: 2,
        reason: 'wont-fix',
      },
      ctx,
    ),
  ).toEqual({ changed: 1 })
  expect(await actions.manage({ do: 'archive', notes: [note.id, 'newer'] }, ctx)).toEqual({
    changed: 1,
  })
  expect(await actions.stats(null, ctx)).toMatchObject({ roles: { worker: { dismissed: 1 } } })
  expect(await actions.manage({ do: 'reopen', notes: [note.id] }, ctx)).toEqual({ changed: 1 })
  const reopened = (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0]
  expect(reopened.status).toBe('open')
  for (const key of ['closedBy', 'closedAt', 'dismissReason', 'archivedAt'])
    expect(reopened).not.toHaveProperty(key)
  await expect(actions.manage({ do: 'resolve' }, ctx)).rejects.toThrow('Invalid note selection')
})

it('starts only one durable close-out after the final answer, not the advisor continuation', async () => {
  const f = await fixture()
  const notices = vi.spyOn(f.host, 'notice')
  await f.hooks.onYield(fauxAssistantMessage([fauxText('first answer')]), f.api(), context)
  expect((await f.harness.snapshot(Runs, ROOT_CONVERSATION_ID, context))?.closeouts).toBeUndefined()
  await writeFile(
    join(f.host.userHome, '.ultimate/settings.json'),
    JSON.stringify({
      advisor: { model: 'faux/faux', roles: { worker: { enabled: true, at: [] } } },
    }),
  )
  f.response.content = [
    fauxText(JSON.stringify({ status: 'ignored', reason: 'no follow-up', evidence: '' })),
  ]
  await f.hooks.onYield(fauxAssistantMessage([fauxText('final answer')]), f.api(), context)
  await f.hooks.onYield(fauxAssistantMessage([fauxText('final answer')]), f.api(), context)
  expect(
    Object.keys((await f.harness.snapshot(Runs, ROOT_CONVERSATION_ID, context))!.closeouts!),
  ).toHaveLength(1)
  f.harness.resume()
  await until(
    async () =>
      !!(await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0].response,
  )
  expect((await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0]).toMatchObject({
    status: 'resolved',
    response: { source: 'judged', status: 'ignored' },
  })
  expect(notices).not.toHaveBeenCalledWith(expect.stringContaining('close-out'))
})

it.each(['no model', 'provider error', 'timeout', 'invalid JSON'] as const)(
  'closes every remaining read note when close-out fails: %s',
  async (failure) => {
    const f = await fixture()
    const note = await lifecycleNote(f)
    await f.hooks.beforeRequest(
      {
        messages: [
          { role: 'user', content: `<advisory id="${note.ref}">data</advisory>`, timestamp: 0 },
        ],
      },
      f.api(),
      context,
    )
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(State, ROOT_CONVERSATION_ID)
      state.notes.push({ ...state.notes[0], id: 'second', ref: 'secnd' })
      ;(await tx.doc(Runs, ROOT_CONVERSATION_ID)).readRuns!.second = 100
    }, context)
    const api = f.api()
    if (failure === 'no model') vi.spyOn(api.models, 'getModel').mockReturnValue(undefined)
    else if (failure === 'invalid JSON') f.response.content = [fauxText('not JSON')]
    else
      f.stream.mockImplementation(
        () =>
          ({
            result: async () => {
              throw new Error(failure)
            },
          }) as never,
      )
    await closeOut(f.host, api, { run: 100, latest: 'done' }, f.config, context)
    const state = (await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!
    for (const current of state.notes) {
      expect(current).toMatchObject({
        status: 'resolved',
        closedBy: 'auto',
        response: { status: 'ignored', source: 'auto', reason: expect.any(String) },
      })
    }
    expect((await f.harness.snapshot(Runs, ROOT_CONVERSATION_ID, context))!.readRuns).toEqual({})
  },
)
it('expires read notes on the tick when a run stops without yielding', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval')
  const f = await fixture()
  const tick = interval.mock.calls.at(-1)![0] as () => void
  interval.mockRestore()
  const note = await lifecycleNote(f)
  await f.hooks.beforeRequest(
    {
      messages: [
        { role: 'user', content: `<advisory id="${note.ref}">data</advisory>`, timestamp: 0 },
      ],
    },
    f.api(),
    context,
  )
  await f.harness.commit(async (tx) => {
    delete (await tx.doc(LiveDoc, f.id)).run
  }, context)
  tick()
  await until(
    async () =>
      !!(await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0].response,
  )
  expect((await f.harness.snapshot(State, ROOT_CONVERSATION_ID, context))!.notes[0]).toMatchObject({
    status: 'resolved',
    response: { status: 'ignored', source: 'auto', reason: 'run ended without close-out' },
  })
  expect((await f.harness.snapshot(Runs, ROOT_CONVERSATION_ID, context))!.readRuns).toEqual({})
})
