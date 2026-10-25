import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { Message } from '@earendil-works/pi-ai'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { candidates, defaults, gateOpen, rewrite } from '../extensions/context-hygiene/rewrite.ts'
import hygiene from '../extensions/context-hygiene/server.ts'
import { Ledger } from '../extensions/context-hygiene/api.ts'
import { saveOutput } from '../extensions/context-offload/store.ts'
import { ContextOffload } from '../extensions/context-offload/api.ts'
import { suffixPositions } from '../extensions/context-hygiene/rewrite.ts'

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
      ...read('a', { path: './x', offset: 5, limit: 5 }, 'a\na\na\na\na'),
      ...read(
        'b',
        { path: '/work/x', offset: 1, limit: 20 },
        Array.from({ length: 20 }, () => 'b').join('\n'),
      ),
    ]).a.reason,
  ).toBe('superseded')
  const mutation = read('edit', { path: 'x' })
  if (mutation[0].role === 'assistant' && mutation[0].content[0].type === 'toolCall')
    mutation[0].content[0].name = 'edit'
  const before = read('a', { path: 'x', offset: 5, limit: 5 }, 'before')
  expect(
    detect([
      ...before,
      ...mutation,
      ...read('b', { path: 'x', offset: 1, limit: 20 }, 'after\n'.repeat(19) + 'after'),
    ]).a,
  ).toBeUndefined()
  expect(detect([...before, ...mutation, ...read('b')]).a.reason).toBe('superseded')
  expect(
    detect([
      ...read('a', { path: 'x' }, 'before\n'.repeat(30)),
      ...read('b', { path: 'x', offset: 1, limit: 20 }, 'after'),
    ]).a,
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
    now: 10_000_000,
    lastAssistant: 9_999_999,
    newContext: false,
    suffixTokens: 20000,
    savings: 3000,
    requestTokens: 40000,
    contextWindow: 200000,
  }
  expect(gateOpen(input, defaults)).toBe(false)
  expect(gateOpen({ ...input, lastAssistant: 1 }, defaults)).toBe(true)
  // A 30-minute gap is inside the one-hour cache: still warm.
  expect(gateOpen({ ...input, lastAssistant: input.now - 30 * 60_000 }, defaults)).toBe(false)
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

async function fixture(
  fail = false,
  contextWindow = 128000,
  settings: { userHome: string; project: JsonObject } = { userHome: '/nonexistent', project: {} },
  outputHome?: string,
) {
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
    want: (token) =>
      (token === ContextOffload && outputHome
        ? {
            save: (conversation: number, id: string, text: string) =>
              saveOutput(outputHome, conversation, id, text),
          }
        : undefined) as never,
    notice: (message) => notices.push(message),
    projectSettings: async () => settings.project,
    projectRoot: '/nonexistent',
    userHome: settings.userHome,
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
it('honours read truncation details carried by actual request messages', async () => {
  const f = await fixture()
  try {
    const later = read('b', { path: 'x' }, 'new\n'.repeat(20))
    if (later[1].role === 'toolResult')
      later[1].details = {
        truncation: { truncated: true, outputLines: 20, firstLineExceedsLimit: false },
      }
    await f.seed(true, [...read('a', { path: 'x', offset: 30, limit: 1 }, 'old'), ...later, tail])
    await f.submit()
    expect((await f.harness.snapshot(Ledger, f.root.id, context))?.decisions.a).toBeUndefined()
    expect(
      f.sent[0].find((message) => message.role === 'toolResult' && message.toolCallId === 'a'),
    ).toMatchObject({ content: [{ type: 'text', text: 'old' }] })
  } finally {
    await f.harness.close(context)
  }
})
it('merges trusted project threshold keys over user settings without replacing the user object', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'context-hygiene-settings-'))
  await mkdir(join(userHome, '.ultimate'))
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ contextHygiene: { suffixSavings: 1000000 } }),
  )
  const project: JsonObject = { contextHygiene: { suffixTokens: 100000 } }
  const f = await fixture(false, 128000, { userHome, project })
  try {
    await f.seed(false)
    await f.submit()
    expect((await f.harness.snapshot(Ledger, f.root.id, context))?.decisions.a.state).toBe(
      'pending',
    )
    project.contextHygiene = { suffixTokens: 100000, suffixSavings: 0 }
    await f.submit()
    expect((await f.harness.snapshot(Ledger, f.root.id, context))?.decisions.a.state).toBe(
      'applied',
    )
    expect(f.notices).toEqual([])
  } finally {
    await f.harness.close(context)
    await rm(userHome, { recursive: true, force: true })
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
    expect((await f.harness.snapshot(Ledger, f.root.id, context))!.stats.requests).toBe(
      ledger.stats.requests,
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
it('bounds cheap Anthropic suffixes by positions rather than just tokens', () => {
  const messages = [
    ...read('old'),
    ...Array.from({ length: 8 }, (_, i) => read(`next-${i}`, { path: `${i}` }, 'tiny')).flat(),
  ]
  const positions = suffixPositions(messages, 'old')
  expect(positions).toBeGreaterThan(14)
  const input = {
    now: 1,
    lastAssistant: 1,
    newContext: false,
    suffixTokens: 100,
    savings: 3000,
    requestTokens: 5000,
    contextWindow: 200000,
  }
  expect(gateOpen({ ...input, suffixPositions: positions }, defaults)).toBe(false)
  expect(gateOpen(input, defaults)).toBe(true)
  expect(gateOpen({ ...input, suffixPositions: positions, newContext: true }, defaults)).toBe(true)
})

it.each(['pressure', 'no-pressure', 'no-store', 'save-fails', 'off'] as const)(
  'masks only old large results with a recoverable output file: %s',
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), 'hygiene-mask-'))
    const broken = join(home, 'not-a-directory')
    await writeFile(broken, 'blocked')
    const f = await fixture(
      false,
      mode === 'no-pressure' ? 1000000 : 100000,
      // Masking is opt-in: 'off' runs under pressure with the default settings.
      {
        userHome: '/nonexistent',
        project: mode === 'off' ? {} : { contextHygiene: { mask: true } },
      },
      mode === 'no-store' ? undefined : mode === 'save-fails' ? broken : home,
    )
    const original = 'old output\n'.repeat(8000)
    const recent = 'recent output\n'.repeat(20000)
    const old = read('old-mask', { path: 'old' }, original)
    if (old[1].role === 'toolResult') old[1].details = { offloadExempt: true }
    try {
      await f.seed(false, [...old, ...read('recent-mask', { path: 'recent' }, recent)])
      await f.submit()
      const ledger = await f.harness.snapshot(Ledger, f.root.id, context)
      const sent = f.sent[0].find((m) => m.role === 'toolResult' && m.toolCallId === 'old-mask')
      expect(
        f.sent[0].find((m) => m.role === 'toolResult' && m.toolCallId === 'recent-mask'),
      ).toMatchObject({ content: [{ type: 'text', text: recent }] })
      const decision = ledger?.decisions['old-mask']
      expect(decision?.reason).toBe(mode === 'pressure' ? 'masked' : undefined)
      expect(decision?.state).toBe(mode === 'pressure' ? 'applied' : undefined)
      const saved = decision?.path ? await readFile(decision.path, 'utf8') : undefined
      expect(saved).toBe(mode === 'pressure' ? original : undefined)
      expect(sent).toEqual(mode === 'pressure' ? rewrite(old, ledger!.decisions)[1] : old[1])
      expect(JSON.stringify(sent).includes('Full text:')).toBe(mode === 'pressure')
      expect(f.notices.join('\n').includes('masking skipped')).toBe(
        ['no-store', 'save-fails'].includes(mode),
      )
      await f.submit()
      expect(f.sent[1].find((m) => m.role === 'toolResult' && m.toolCallId === 'old-mask')).toEqual(
        sent,
      )
    } finally {
      await f.harness.close(context)
      await rm(home, { recursive: true, force: true })
    }
  },
)
