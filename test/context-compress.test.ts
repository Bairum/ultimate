import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import type { Message } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  hook,
  Harness,
  MemoryStorage,
} from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import compress, { Ranges } from '../extensions/context-compress/server.ts'
import { prune, rewrite, turns, validate } from '../extensions/context-compress/rewrite.ts'
import type { Range } from '../extensions/context-compress/refs.ts'
import hygiene from '../extensions/context-hygiene/server.ts'
import { Ledger } from '../extensions/context-hygiene/api.ts'
import { apis } from './helpers.ts'

const user = (content: string): Message => ({ role: 'user', content, timestamp: 1 })
const assistant = fauxAssistantMessage('finished')
const tools: Message[] = [
  fauxAssistantMessage(
    [
      fauxToolCall('read', { path: 'x' }, { id: 'read-a' }),
      fauxToolCall('read', { path: 'y' }, { id: 'read-b' }),
    ],
    {
      stopReason: 'toolUse',
    },
  ),
  // Stored out of call order; ContextView.messages orders the results for the provider.
  {
    role: 'toolResult',
    toolCallId: 'read-b',
    toolName: 'read',
    content: [{ type: 'text', text: 'other data' }],
    isError: false,
    timestamp: 1,
  },
  {
    role: 'toolResult',
    toolCallId: 'read-a',
    toolName: 'read',
    content: [{ type: 'text', text: 'data'.repeat(2000) }],
    isError: false,
    timestamp: 1,
  },
]
async function fixture(reverse = false) {
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 0 })
  models.setProvider(faux.provider)
  const registry = createRegistry(),
    services = apis(),
    notices: string[] = [],
    sent: (readonly Message[])[] = []
  let harness: Harness
  const host = {
    ...services,
    harness: () => harness,
    notice: (s: string) => notices.push(s),
    projectRoot: '/work',
    userHome: '/nonexistent',
    projectSettings: async () => ({}),
  }
  const h = hygiene(host),
    c = compress(host)
  let inconsistent = false
  const injector = defineExtension({
    name: 'test.inject',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }) =>
          inconsistent
            ? {
                messages: messages.map((m) =>
                  m.role === 'user' && m.content === 'First task\nDetails'
                    ? { ...m, content: 'changed by another hook' }
                    : m,
                ),
              }
            : undefined,
      }),
    ],
  })
  const extensions = reverse ? [injector, c, h] : [h, injector, c]
  for (const e of extensions) registry.install(e)
  harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { compaction: { enabled: false } } },
    ctx,
  )
  const root = await harness.root(ctx, {
    agent: { model: { provider: 'faux', modelId: faux.getModel().id }, extensions },
  })
  await harness.commit(async (tx) => {
    for (const message of [
      user('First task\nDetails'),
      { role: 'system', content: 'System instructions. '.repeat(3000), timestamp: 1 } as Message,
      ...tools,
      assistant,
      user('Second task'),
      fauxAssistantMessage('second'.repeat(1000)),
      user('Recent task'),
      fauxAssistantMessage('padding'.repeat(14000)),
    ])
      await tx.appendEntry(root.id, {
        kind: message.role === 'user' ? 'pi.user' : 'test.seed',
        model: [message],
      })
  }, ctx)
  await harness.commit(async (tx) => {
    ;(await tx.doc(Ledger, root.id)).decisions['read-a'] = {
      reason: 'empty',
      tokens: 2000,
      state: 'applied',
      at: 1,
    }
  }, ctx)
  const invoke = async (name?: string, args: JsonObject = {}) => {
    faux.setResponses(
      name
        ? [
            fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' }),
            (request) => {
              sent.push(request.messages)
              return fauxAssistantMessage('done')
            },
          ]
        : [
            (request) => {
              sent.push(request.messages)
              return fauxAssistantMessage('done')
            },
          ],
    )
    expect(
      await (await root.submit({ type: 'input', content: 'continue' }, ctx)).wait(ctx),
    ).toMatchObject({ status: 'done' })
    return (await root.context(ctx)).messages.findLast((m) => m.role === 'toolResult')
  }
  return {
    harness,
    root,
    invoke,
    notices,
    sent,
    breakMapping: () => {
      inconsistent = true
    },
  }
}

it.each([false, true])(
  'compresses next request and restores without editing stored entries, composing both hook orders (%s)',
  async (reverse) => {
    const f = await fixture(reverse)
    try {
      const original = await f.root.context(ctx)
      expect(
        original.messages.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId),
      ).toEqual(['read-a', 'read-b'])
      const listed = turns(original, [])
      expect(listed).toHaveLength(2)
      expect(listed[0].tokens).toBeLessThan(4000)
      const result = await f.invoke('context_ranges')
      expect(result?.role === 'toolResult' && result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('First task') }),
        ]),
      )
      await f.invoke('compress', {
        from: listed[0].id,
        to: listed[1].id,
        summary: 'Finished first and second tasks; read x.',
      })
      const ranges = (await f.harness.snapshot(Ranges, f.root.id, ctx))!.ranges
      expect(ranges).toHaveLength(1)
      expect(f.notices).toEqual([])
      expect(
        f.sent
          .at(-1)!
          .filter(
            (m) =>
              m.role === 'user' &&
              typeof m.content === 'string' &&
              m.content.startsWith('<compressed'),
          ),
      ).toHaveLength(1)
      expect(f.sent.at(-1)!.some((m) => m.role === 'toolResult' && m.toolCallId === 'read-a')).toBe(
        false,
      )
      expect((await f.root.context(ctx)).entries.slice(0, original.entries.length)).toEqual(
        original.entries,
      )
      const compressedMessages = (messages: readonly Message[]) =>
        messages.filter(
          (m) =>
            m.role === 'user' &&
            typeof m.content === 'string' &&
            m.content.startsWith('<compressed'),
        )
      const firstRequest = JSON.stringify(compressedMessages(f.sent.at(-1)!))
      await f.invoke()
      expect(JSON.stringify(compressedMessages(f.sent.at(-1)!))).toBe(firstRequest)
      const view = await f.root.context(ctx)
      expect(() =>
        rewrite(
          [original.messages.find((m) => m.role === 'user')!, ...view.messages],
          view,
          ranges,
          (m) => m,
        ),
      ).toThrow('Ambiguous injected copy')
      const first = rewrite(view.messages, view, ranges, (m) => m)
      expect(JSON.stringify(rewrite(view.messages, view, structuredClone(ranges), (m) => m))).toBe(
        JSON.stringify(first),
      )
      const injected = user('injected hook note')
      expect(rewrite([injected, ...view.messages], view, ranges, (m) => m)[0]).toBe(injected)
      const untouched = first.filter(
        (m) =>
          !(
            m.role === 'user' &&
            typeof m.content === 'string' &&
            m.content.startsWith('<compressed')
          ),
      )
      expect(untouched).toEqual(
        view.messages.filter(
          (m) =>
            m.role === 'system' ||
            !view.contributions
              .filter(
                (_batch, i) =>
                  view.entries[i].id >= ranges[0].fromEntry &&
                  view.entries[i].id <= ranges[0].toEntry,
              )
              .flat()
              .some((old) => JSON.stringify(old) === JSON.stringify(m)),
        ),
      )
      await f.invoke('decompress', { id: ranges[0].id })
      expect(f.sent.at(-1)!.some((m) => m.role === 'toolResult' && m.toolCallId === 'read-a')).toBe(
        true,
      )
      expect((await f.root.context(ctx)).entries.slice(0, original.entries.length)).toEqual(
        original.entries,
      )
      expect((await f.harness.snapshot(Ranges, f.root.id, ctx))!.ranges[0].active).toBe(false)
    } finally {
      await f.harness.close(ctx)
    }
  },
)

it('rejects partial turns, reversed ranges, overlap, protect-window ranges, empty and oversized summaries', async () => {
  const f = await fixture()
  try {
    const view = await f.root.context(ctx),
      available = turns(view, [])
    const from = available[0].id,
      to = available[1].id
    const selected = validate(view, [], from, to, 'summary')
    const range: Range = { id: 'c1', ...selected, summary: 'summary', active: true, at: 1 }
    expect(() => validate(view, [], from + 1, to, 'summary')).toThrow('whole turns')
    expect(() => validate(view, [], to, from, 'summary')).toThrow('whole turns')
    expect(() => validate(view, [range], from, to, 'summary')).toThrow('overlaps')
    const recent = view.entries.findLast((e) => e.kind === 'pi.user')!.id
    expect(() => validate(view, [], from, recent, 'summary')).toThrow('whole turns')
    expect(() => validate(view, [], from, to, ' ')).toThrow('non-empty')
    expect(() => validate(view, [], from, to, 'oversized'.repeat(10000))).toThrow('25%')
  } finally {
    await f.harness.close(ctx)
  }
})

it('inherits the rewindable ledger as of a fork and deactivates ranges after compaction removes their entries', async () => {
  const f = await fixture()
  try {
    const view = await f.root.context(ctx),
      available = turns(view, [])
    const before = view.entries.at(-1)!.id
    await f.invoke('compress', {
      from: available[0].id,
      to: available[1].id,
      summary: 'Tasks finished.',
    })
    const after = (await f.root.context(ctx)).entries.at(-1)!.id
    const earlier = await f.root.fork(before, { ownership: { kind: 'ownerless' } }, ctx)
    const later = await f.root.fork(after, { ownership: { kind: 'ownerless' } }, ctx)
    expect((await f.harness.snapshot(Ranges, earlier.id, ctx))?.ranges ?? []).toEqual([])
    expect((await f.harness.snapshot(Ranges, later.id, ctx))!.ranges[0].active).toBe(true)
    await f.harness.commit(async (tx) => {
      await tx.appendEntry(f.root.id, {
        kind: 'pi.compaction',
        head: after,
        model: [user('Compacted summary')],
      })
    }, ctx)
    await f.invoke()
    expect((await f.harness.snapshot(Ranges, f.root.id, ctx))!.ranges[0].active).toBe(false)
  } finally {
    await f.harness.close(ctx)
  }
})

it('fails open with an explicit reason on inconsistent mapping, and rejects split tool pairs', async () => {
  const f = await fixture()
  try {
    const view = await f.root.context(ctx),
      available = turns(view, [])
    const range: Range = {
      id: 'c1',
      ...validate(view, [], available[0].id, available[1].id, 'summary'),
      summary: 'summary',
      active: true,
      at: 1,
    }
    expect(() =>
      rewrite(
        view.messages.filter((m) => m.role !== 'toolResult'),
        view,
        [range],
        (m) => m,
      ),
    ).toThrow('align')
    const split = {
      ...range,
      toEntry: view.entries.find((e) =>
        e.model?.some(
          (m) => m.role === 'assistant' && m.content.some((part) => part.type === 'toolCall'),
        ),
      )!.id,
    }
    expect(() => rewrite(view.messages, view, [split], (m) => m)).toThrow('pair')
    const broken = { ...range, fromEntry: range.toEntry + 1000, toEntry: range.toEntry + 1001 }
    await f.harness.commit(async (tx) => {
      ;(await tx.doc(Ranges, f.root.id)).ranges.push(broken)
    }, ctx)
    // Invalid compacted ranges are pruned, not sent as placeholders.
    await f.invoke()
    expect(f.sent.at(-1)!.some((m) => m.role === 'toolResult' && m.toolCallId === 'read-a')).toBe(
      true,
    )
    await f.harness.commit(async (tx) => {
      ;(await tx.doc(Ranges, f.root.id)).ranges.push(range)
    }, ctx)
    f.breakMapping()
    await f.invoke()
    expect(f.notices).toEqual([expect.stringContaining('Cannot align entries for c1')])
    expect(
      f.sent.at(-1)!.some((m) => m.role === 'user' && m.content === 'changed by another hook'),
    ).toBe(true)
    expect(f.sent.at(-1)!.some((m) => m.role === 'toolResult' && m.toolCallId === 'read-a')).toBe(
      true,
    )
    const ranges = [range]
    prune(ranges, { ...view, entries: [] })
    expect(ranges[0].active).toBe(false)
  } finally {
    await f.harness.close(ctx)
  }
})
