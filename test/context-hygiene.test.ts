import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { Message } from '@earendil-works/pi-ai'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { candidates, defaults, gateOpen, rewrite } from '../extensions/context-hygiene/rewrite.ts'
import hygiene from '../extensions/context-hygiene/server.ts'
import { Ledger } from '../extensions/context-hygiene/api.ts'

const read = (
  id: string,
  args: Record<string, string | number> = { path: 'x' },
  output = 'old'.repeat(3000),
): Message[] => [
  {
    ...fauxAssistantMessage(''),
    content: [{ type: 'toolCall', id, name: 'read', arguments: args }],
  },
  {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text: output }],
    isError: false,
    timestamp: 1,
  },
]
const tail: Message = { role: 'user', content: 'padding'.repeat(9000), timestamp: 1 }
const detect = (messages: Message[]) => candidates([...messages, tail], '/work', 1)

it('detects covering resolved reads, whole reads, and the edited-between partial exception', () => {
  expect(
    detect([
      ...read('a', { path: './x', offset: 5, limit: 5 }),
      ...read('b', { path: '/work/x', offset: 1, limit: 20 }),
    ]).a.reason,
  ).toBe('superseded')
  const mutation = read('edit', { path: 'x' })
  if (mutation[0].role === 'assistant' && mutation[0].content[0].type === 'toolCall')
    mutation[0].content[0].name = 'edit'
  const before = read('a', { path: 'x', offset: 5, limit: 5 }, 'before')
  expect(
    detect([...before, ...mutation, ...read('b', { path: 'x', offset: 1, limit: 20 }, 'after')]).a,
  ).toBeUndefined()
  expect(detect([...before, ...mutation, ...read('b')]).a.reason).toBe('superseded')
  expect(
    detect([...read('a'), ...read('b', { path: 'x', offset: 1, limit: 20 }, 'after')]).a,
  ).toBeUndefined()
})
it('opts into empty results and elides older exact duplicates independent of argument key order', () => {
  const empty = read('empty')
  if (empty[1].role === 'toolResult') empty[1].details = { useless: true }
  expect(detect(empty).empty.reason).toBe('empty')
  const a = read('a', { path: 'x', limit: 10 }),
    b = read('b', { limit: 10, path: 'x' })
  for (const message of [...a, ...b]) {
    if (message.role === 'assistant' && message.content[0].type === 'toolCall')
      message.content[0].name = 'bash'
    if (message.role === 'toolResult') message.toolName = 'bash'
  }
  expect(detect([...a, ...b]).a).toMatchObject({ reason: 'duplicate', by: 'b' })
  expect(detect([...a, ...read('c')]).a).toBeUndefined()
})
it('never considers errors or images, but discovers recent redundant results', () => {
  const error = read('error'),
    image = read('image')
  if (error[1].role === 'toolResult') error[1].isError = true
  if (image[1].role === 'toolResult')
    image[1].content.push({ type: 'image', data: 'x', mimeType: 'image/png' })
  expect(detect([...error, ...image, ...read('later')])).toEqual({})
  expect(candidates([...read('a'), ...read('b')], '/work', 1).a.reason).toBe('superseded')
})
it('opens only for cold cache, new context, cheap suffix or pressure with sufficient savings', () => {
  const input = {
    now: 1_000_000,
    lastAssistant: 999_999,
    newContext: false,
    suffixTokens: 20000,
    savings: 3000,
    requestTokens: 40000,
    contextWindow: 200000,
  }
  expect(gateOpen(input, defaults)).toBe(false)
  expect(gateOpen({ ...input, lastAssistant: 1 }, defaults)).toBe(true)
  expect(gateOpen({ ...input, newContext: true }, defaults)).toBe(true)
  expect(gateOpen({ ...input, suffixTokens: 8000 }, defaults)).toBe(true)
  expect(gateOpen({ ...input, suffixTokens: 8000, savings: 1999 }, defaults)).toBe(false)
  expect(gateOpen({ ...input, requestTokens: 130000, savings: 8000 }, defaults)).toBe(true)
  expect(gateOpen({ ...input, requestTokens: 130000 }, defaults)).toBe(false)
})
it('preserves all message pairing, order and metadata without mutating source messages', () => {
  const messages = [...read('a'), ...read('b'), tail]
  const before = structuredClone(messages)
  const decisions = detect(messages)
  decisions.a.state = 'applied'
  const output = rewrite(messages, decisions)
  expect(messages).toEqual(before)
  expect(output.map((message) => message.role)).toEqual(messages.map((message) => message.role))
  expect(output.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId)).toEqual(['a', 'b'])
  expect(output[1]).toMatchObject({
    role: 'toolResult',
    toolCallId: 'a',
    toolName: 'read',
    isError: false,
  })
  expect(rewrite(messages, structuredClone(decisions))).toEqual(output)
})

async function fixture(fail = false, contextWindow = 128000) {
  const models = createModels(),
    faux = fauxProvider({
      tokensPerSecond: 0,
      models: [{ id: 'faux-1', contextWindow, maxTokens: 1000 }],
    })
  models.setProvider(faux.provider)
  const registry = createRegistry(),
    storage = new MemoryStorage()
  storage.close = async () => {}
  let harness: Harness
  const notices: string[] = []
  const sent: (readonly Message[])[] = []
  const extension = hygiene({
    harness: () => {
      if (fail) throw new Error('injected failure')
      return harness
    },
    implement: () => {},
    notice: (message) => notices.push(message),
    projectRoot: '/nonexistent',
    userHome: '/nonexistent',
  })
  registry.install(extension)
  const options = { models, registry, settings: { compaction: { enabled: false } } }
  harness = await Harness.open(storage, options, context)
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' }, extensions: [extension] },
  })
  const seed = async (cold: boolean, messages = [...read('a'), ...read('b'), tail]) =>
    harness.commit(async (tx) => {
      for (const message of messages) {
        if (message.role === 'assistant') message.timestamp = cold ? 1 : Date.now()
        await tx.appendEntry(root.id, { kind: 'test.seed', model: [message] })
      }
    }, context)
  const submit = async () => {
    faux.setResponses([
      (request) => {
        sent.push(request.messages)
        return fauxAssistantMessage('done')
      },
    ])
    const result = await (
      await (await harness.conversation(root.id, context))!.submit(
        { type: 'input', content: 'continue' },
        context,
      )
    ).wait(context)
    expect(result).toMatchObject({ status: 'done' })
  }
  return {
    root,
    seed,
    submit,
    notices,
    sent,
    get harness() {
      return harness
    },
    restart: async () => {
      await harness.close(context)
      harness = await Harness.open(storage, options, context)
    },
  }
}
it.each([true, false])(
  'applies recent redundancy on a cold cache or cheap suffix (cold=%s)',
  async (cold) => {
    const f = await fixture()
    try {
      await f.seed(cold, [...read('a'), ...read('b')])
      await f.submit()
      expect((await f.harness.snapshot(Ledger, f.root.id, context))?.decisions.a.state).toBe(
        'applied',
      )
    } finally {
      await f.harness.close(context)
    }
  },
)
it('protects recent decisions only when pressure is the gate that opens', async () => {
  const f = await fixture(false, 60000)
  try {
    const older = read('a', { path: 'x' }, 'x'.repeat(49000))
    const recent = read('b', { path: 'x' }, 'y'.repeat(49000))
    if (recent[1].role === 'toolResult') recent[1].details = { useless: true }
    await f.seed(false, [
      ...older,
      ...recent,
      { role: 'user', content: 'z'.repeat(40000), timestamp: 1 },
    ])
    await f.submit()
    const ledger = await f.harness.snapshot(Ledger, f.root.id, context)
    expect(ledger?.decisions.a.state).toBe('applied')
    expect(ledger?.decisions.b.state).toBe('pending')
    expect(f.notices).toEqual([])
  } finally {
    await f.harness.close(context)
  }
})
it('keeps stored entries unchanged, holds warm pending decisions, and fails open with diagnostics', async () => {
  for (const fail of [false, true]) {
    const f = await fixture(fail)
    try {
      await f.seed(false)
      const before = (await f.root.context(context)).entries
      await f.submit()
      const after = (await f.root.context(context)).entries
      expect(after.filter((entry) => before.some((old) => old.id === entry.id))).toEqual(before)
      const state = await f.harness.snapshot(Ledger, f.root.id, context)
      expect(f.notices.some((notice) => notice.includes('injected failure'))).toBe(fail)
      expect(state?.decisions.a?.state).toBe(fail ? undefined : 'pending')
      expect(
        f.sent[0].find((message) => message.role === 'toolResult' && message.toolCallId === 'a'),
      ).toEqual(read('a')[1])
    } finally {
      await f.harness.close(context)
    }
  }
})
it('applies cold decisions durably, sends identical retry bytes after restart, and forks as of an entry', async () => {
  const f = await fixture()
  try {
    await f.seed(true)
    const storedBefore = (await f.root.context(context)).entries
    const beforeDecision = storedBefore.at(-1)!.id
    await f.submit()
    expect(
      (await f.root.context(context)).entries.filter((entry) =>
        storedBefore.some((old) => old.id === entry.id),
      ),
    ).toEqual(storedBefore)
    const ledger = (await f.harness.snapshot(Ledger, f.root.id, context))!
    expect(ledger.decisions.a.state).toBe('applied')
    const firstSent = f.sent[0].find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'a',
    )
    expect(firstSent).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('Elided') }],
    })
    const messages = [...read('a'), ...read('b'), tail]
    const output = rewrite(messages, ledger.decisions)
    const entries = (await f.root.context(context)).entries
    const at = entries.at(-1)!.id
    await f.restart()
    expect(
      rewrite(messages, (await f.harness.snapshot(Ledger, f.root.id, context))!.decisions),
    ).toEqual(output)
    await f.submit()
    expect(
      f.sent[1].find((message) => message.role === 'toolResult' && message.toolCallId === 'a'),
    ).toEqual(firstSent)
    expect((await f.harness.snapshot(Ledger, f.root.id, context))!.decisions.a.state).toBe(
      'applied',
    )
    const root = (await f.harness.conversation(f.root.id, context))!
    const earlier = await root.fork(beforeDecision, { ownership: { kind: 'ownerless' } }, context)
    expect((await f.harness.snapshot(Ledger, earlier.id, context))?.decisions ?? {}).toEqual({})
    const child = await root.fork(at, { ownership: { kind: 'ownerless' } }, context)
    expect((await f.harness.snapshot(Ledger, child.id, context))?.decisions).toEqual(
      ledger.decisions,
    )
  } finally {
    await f.harness.close(context)
  }
})
