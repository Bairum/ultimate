import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  candidates,
  defaults,
  estimate,
  gateOpen,
  placeholder,
  suffixPositions,
} from '../../../extensions/context-hygiene/rewrite.ts'
import type { Message, AssistantMessage } from '@earendil-works/pi-ai'

type Entry = {
  id: number
  conversationId: number
  kind: string
  head?: number | 'self'
  model?: Message[]
  edits?: { target: number; action: string; messages?: Message[] }[]
}
type Conversation = { id: number; title?: string; label?: string; cwd?: string; agent?: unknown }
type Model = { id: string; provider: string; contextWindow: number }
type Options = {
  base: string
  ttl: number
  rewrite: number
  keep: boolean
  json: boolean
  conversations?: number[]
}
type Projection = { saved: number; cost: number; events: number; tokenResends: number }
const projection = (): Projection => ({ saved: 0, cost: 0, events: 0, tokenResends: 0 })
export const tokens = (s: string) => Math.ceil(s.length / 3.5)
const text = (m: Message) =>
  typeof m.content === 'string'
    ? m.content
    : m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')
const size = estimate
const callKey = (name: string, args: Record<string, unknown>, cwd: string) =>
  typeof args.path === 'string'
    ? `${name}:${resolve(cwd, args.path)}`
    : typeof args.command === 'string'
      ? `${name}:${args.command}`
      : `${name}:${JSON.stringify(args)}`
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)

/** Only these read endpoints are permitted; redirects cannot escape the allowlist. */
export async function get(base: string, path: string) {
  if (!/^\/api\/(models|conversations\/\d+\/history\?before=\d+)$/.test(path))
    throw new Error(`Disallowed GET path: ${path}`)
  const response = await fetch(new URL(path, base), {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`)
  return response.json()
}

/** Read only the initial conversations SSE frame, then close the connection. */
async function listConversations(base: string): Promise<Conversation[]> {
  const response = await fetch(new URL('/api/events', base), {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok || !response.body) throw new Error(`GET /api/events: ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) throw new Error('Event stream ended before conversations frame')
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (/^event: ?conversations$/m.test(frame))
          return JSON.parse(
            frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n'),
          )
      }
    }
  } finally {
    await reader.cancel()
  }
}
/** Exact store.ts excerpt algorithm, without saveOutput/readFile or any source-data writes. */
export function excerpt(full: string, path: string): string | undefined {
  const bytes = Buffer.byteLength(full)
  if (bytes <= 16 * 1024) return undefined
  const rows = full.split('\n')
  if (rows.at(-1) === '') rows.pop()
  const indexed = rows.map((text, index) => ({ text, index }))
  function take(rows: { text: string; index: number }[], budget: number) {
    const kept: { text: string; index: number; sourceBytes: number }[] = []
    let used = 0
    for (const row of rows) {
      const points = Array.from(row.text)
      const text =
        points.length > 300
          ? `${points.slice(0, 300).join('')}…[+${points.length - 300} chars]`
          : row.text
      const bytes = Buffer.byteLength(text) + 1
      if (used + bytes > budget) break
      used += bytes
      kept.push({
        text,
        index: row.index,
        sourceBytes: Buffer.byteLength(points.slice(0, 300).join('')),
      })
    }
    return kept
  }
  const head = take(indexed.slice(0, 60), 1900)
  const tail = take(
    indexed.slice(Math.max(head.length, rows.length - 60)).toReversed(),
    3800,
  ).toReversed()
  const matches = take(
    indexed.filter((row) => /error|fail|panic|warn/i.test(row.text)).slice(0, 20),
    1400,
  )
  const hidden = rows.length - head.length - tail.length
  const shown = new Map([...head, ...tail, ...matches].map((row) => [row.index, row.sourceBytes]))
  const omitted = Math.max(0, bytes - sum([...shown.values()]))
  const marker = `… ${hidden.toLocaleString('en-US')} lines and ${omitted.toLocaleString('en-US')} bytes not shown (${Math.ceil(bytes / 1024).toLocaleString('en-US')} KB total). Full output: ${path}. Use read with offset/limit or grep on that file.`
  const result = [
    ...head.map((row) => row.text),
    ...(hidden > 0 ? [`… ${hidden.toLocaleString('en-US')} lines omitted …`] : []),
    ...tail.map((row) => row.text),
    ...(matches.length
      ? ['Matching lines:', ...matches.map((row) => `${row.index + 1}: ${row.text}`)]
      : []),
    marker,
  ].join('\n')
  return Buffer.byteLength(result) < bytes && Buffer.byteLength(result) <= 8192 ? result : undefined
}

export function positions(messages: Message[]) {
  let n = 0,
    last = ''
  for (const m of messages) {
    const blocks =
      m.role === 'toolResult'
        ? ['toolResult']
        : typeof m.content === 'string'
          ? m.content.trim()
            ? ['text']
            : []
          : m.content.flatMap((p) =>
              p.type === 'text'
                ? p.text.trim()
                  ? ['text']
                  : []
                : p.type === 'thinking'
                  ? p.thinking.trim() || p.thinkingSignature?.trim()
                    ? ['thinking']
                    : []
                  : [p.type],
            )
    for (const block of blocks) {
      if (!['toolCall', 'toolResult'].includes(block) || block !== last) n++
      last = block
    }
  }
  return n
}

function prices(m: AssistantMessage) {
  const u = m.usage,
    c = u.cost
  const longTokens = u.cacheWrite1h ?? 0
  const input = u.cacheWrite
    ? c.cacheWrite / ((u.cacheWrite - longTokens) * 1.25 + longTokens * 2)
    : u.input
      ? c.input / u.input
      : u.cacheRead
        ? (c.cacheRead / u.cacheRead) * 10
        : 0
  return {
    input,
    read: u.cacheRead ? c.cacheRead / u.cacheRead : input * 0.1,
    output: u.output ? c.output / u.output : input * 5,
  }
}
const anthropic = (m: AssistantMessage) =>
  m.api === 'anthropic-messages' || m.provider === 'anthropic' || m.provider === 'claude-code'
const causes = [
  'first request/context',
  'idle TTL',
  'compaction/reset',
  'model/thinking switch',
  'system-prompt change',
  'tool-list change',
  'hygiene trim (off in history)',
  'lookback miss',
  'unexplained',
]

export function analyze(
  histories: { conversation: Conversation; entries: Entry[] }[],
  models: Model[],
  options: Pick<Options, 'ttl' | 'rewrite'>,
) {
  const attribution = Object.fromEntries(
    causes.map((key) => [key, { count: 0, tokens: 0, cost: 0 }]),
  )
  const projections = Object.fromEntries(
    [
      '1h cache',
      'keep-warm eligible',
      'keep-warm unknown role',
      'offload',
      'hygiene',
      'pressure masking',
      'section churn upper bound',
      'combined eligible',
    ].map((key) => [key, projection()]),
  )
  const sections: Record<
    string,
    {
      patches: number
      tokens: number
      readdTokens: number
      write: number
      resends: number
      resendTokens: number
    }
  > = {}
  const rewrites: unknown[] = []
  let actual = 0,
    anthropicSpend = 0,
    requests = 0,
    anthRequests = 0,
    masked = 0,
    reread = 0,
    unknownWindows = 0
  let first = Infinity,
    last = 0
  const seen = new Set<number>()
  for (const { conversation, entries } of histories) {
    let active: Entry[] = [],
      previous: AssistantMessage | undefined,
      previousEnd = 0
    let reset = false,
      hadContext = false
    let ownRequests = 0
    let systemChanged = new Set<string>(),
      toolsChanged = false,
      readded = false
    let removedKeys: string[] = []
    const sectionState: Record<string, string> = {}
    let churn: { key: string; tokens: number; readd: boolean; charged: boolean }[] = []
    const offloaded = new Map<string, number>(),
      hygiene = new Map<string, number>(),
      masks = new Map<string, number>()
    let decided: Parameters<typeof candidates>[3] = {}
    const maskedKeys = new Set<string>(),
      rereadKeys = new Set<string>()
    const cwd = conversation.cwd ?? '/'
    let role =
      conversation.title === '@ultimate' ||
      /ultimate|coordinator/.test(
        `${conversation.label ?? ''} ${JSON.stringify(conversation.agent ?? '')}`,
      )
        ? 'eligible'
        : /worker|reviewer|scout/.test(
              `${conversation.label ?? ''} ${JSON.stringify(conversation.agent ?? '')}`,
            )
          ? 'worker'
          : 'unknown'
    for (const entry of entries.toSorted((a, b) => a.id - b.id)) {
      if (entry.head !== undefined || ['pi.reset', 'pi.compaction'].includes(entry.kind)) {
        const head = entry.head === 'self' || entry.head === undefined ? entry.id : entry.head
        active = active.filter((e) => e.id >= head && e.head === undefined)
        reset = true
        offloaded.clear()
        hygiene.clear()
        masks.clear()
        decided = {}
        churn = []
      }
      for (const edit of entry.edits ?? [])
        active = active.map((e) =>
          e.id === edit.target
            ? { ...e, model: edit.action === 'omit' ? [] : (edit.messages ?? e.model) }
            : e,
        )
      const message = entry.model?.[0]
      if (message?.role === 'system') {
        const patch = message.sections ?? {}
        const keys = Object.keys(sectionState)
        const allNull =
          keys.length > 0 &&
          keys.every((key) => patch[key] === null) &&
          Object.values(patch).every((value) => value === null)
        if (allNull) removedKeys = keys
        const fullReadd =
          removedKeys.length > 0 && removedKeys.every((key) => typeof patch[key] === 'string')
        if (fullReadd) readded = true
        for (const [key, value] of Object.entries(patch)) {
          if (sectionState[key] !== value) systemChanged.add(key)
          if (value === null) delete sectionState[key]
          else {
            sectionState[key] = value
            if (previous && !reset)
              churn.push({ key, tokens: tokens(value), readd: fullReadd, charged: false })
          }
        }
        if (message.toolsAdded?.length || message.toolsRemoved?.length) toolsChanged = true
        if (fullReadd) removedKeys = []
      }
      // Infer role from the actual system sections, not conversation titles.
      if (message?.role === 'system') {
        const agent = message.sections?.instructions ?? ''
        if (/You are a subagent|You are an? (?:worker|reviewer)/i.test(agent)) role = 'worker'
        if (/You are the coordinator|You are @ultimate/i.test(agent)) role = 'eligible'
      }
      if (entry.kind !== 'pi.assistant' || message?.role !== 'assistant') {
        active.push(entry)
        continue
      }
      const owns = entry.conversationId === conversation.id && !seen.has(entry.id)
      const firstRequest = owns && ownRequests === 0
      const messages = active
        .flatMap((e) => e.model ?? [])
        .filter(
          (m) => m.role !== 'assistant' || !['error', 'aborted', 'deferred'].includes(m.stopReason),
        )
      const gap = previous ? message.timestamp - previous.timestamp : Infinity
      const p = prices(message),
        u = message.usage
      const isAnthropic = anthropic(message)
      const switchModel =
        previous &&
        (previous.model !== message.model ||
          previous.provider !== message.provider ||
          previous.thinkingLevel !== message.thinkingLevel)
      const deltaPositions = positions(messages.slice(previousEnd))
      if (owns) {
        seen.add(entry.id)
        requests++
        ownRequests++
        actual += u.cost.total
        first = Math.min(first, message.timestamp)
        last = Math.max(last, message.timestamp)
      }
      if (owns && isAnthropic) {
        anthRequests++
        anthropicSpend += u.cost.total
        if (u.cacheWrite > options.rewrite) {
          const cause =
            firstRequest || !previous
              ? causes[0]
              : gap > options.ttl
                ? causes[1]
                : reset
                  ? causes[2]
                  : switchModel
                    ? causes[3]
                    : systemChanged.size
                      ? causes[4]
                      : toolsChanged
                        ? causes[5]
                        : deltaPositions > 20
                          ? causes[7]
                          : causes[8]
          const row = attribution[cause]
          row.count++
          row.tokens += u.cacheWrite
          row.cost += u.cost.cacheWrite
          rewrites.push({
            conversation: conversation.id,
            entry: entry.id,
            cause,
            gapMinutes: Number.isFinite(gap) ? gap / 60000 : null,
            sections: [...systemChanged],
            removeAllReadd: readded,
            positions: deltaPositions,
            tokens: u.cacheWrite,
            cost: u.cost.cacheWrite,
          })
        }
      }
      // Stable ingestion savings and persistent projection ledgers, until the next context head.
      for (const m of messages)
        if (m.role === 'toolResult' && !offloaded.has(m.toolCallId)) {
          if (
            m.toolName === 'read' ||
            (m.details &&
              typeof m.details === 'object' &&
              'offloadExempt' in m.details &&
              m.details.offloadExempt === true)
          )
            continue
          const out = excerpt(
            text(m),
            `/project-home/outputs/${conversation.id}/${m.toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`,
          )
          if (out !== undefined)
            offloaded.set(m.toolCallId, Math.max(0, tokens(text(m)) - tokens(out)))
        }
      const pending = candidates(messages, cwd, message.timestamp, decided)
      const savings = sum(Object.values(pending).map((d) => d.tokens))
      const ids = Object.keys(pending)
      const earliest = messages.findIndex(
        (m) => m.role === 'toolResult' && ids.includes(m.toolCallId),
      )
      const suffix = earliest < 0 ? [] : messages.slice(earliest)
      const window =
        models.find((m) => m.id === message.model && m.provider === message.provider)
          ?.contextWindow ?? 0
      const requestTokens = u.input + u.cacheRead + u.cacheWrite
      const gate = {
        newContext: !hadContext || reset,
        now: message.timestamp,
        lastAssistant: previous?.timestamp,
        suffixTokens: sum(suffix.slice(1).map(size)),
        suffixPositions: Math.max(...ids.map((id) => suffixPositions(messages, id))),
        savings,
        requestTokens,
        contextWindow: window,
      }
      const eligible = gateOpen({ ...gate, contextWindow: 0 }, defaults)
        ? ids
        : ids.filter((id) => {
            const index = messages.findIndex((m) => m.role === 'toolResult' && m.toolCallId === id)
            return sum(messages.slice(index + 1).map(size)) >= defaults.protectTokens
          })
      const open =
        eligible.length > 0 &&
        gateOpen({ ...gate, savings: sum(eligible.map((id) => pending[id].tokens)) }, defaults)
      let hygieneRewrite = 0,
        maskRewrite = 0
      if (open) {
        for (const id of eligible) {
          const d = pending[id]
          hygiene.set(id, d.tokens)
          decided[id] = { ...d, state: 'applied' }
        }
        if (previous && gap <= options.ttl && !reset)
          hygieneRewrite = sum(suffix.map(size)) * p.input * 1.25
      }
      if (owns && isAnthropic && !window) unknownWindows++
      if (window && requestTokens > 0.6 * window) {
        let recent = 0,
          oldest = -1
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i],
            age = recent
          recent += size(m)
          if (
            age < 40000 ||
            m.role !== 'toolResult' ||
            tokens(text(m)) < 500 ||
            m.isError ||
            m.content.some((b) => b.type !== 'text') ||
            masks.has(m.toolCallId)
          )
            continue
          masks.set(
            m.toolCallId,
            Math.max(
              0,
              tokens(text(m)) -
                tokens(
                  placeholder({
                    reason: 'masked',
                    state: 'applied',
                    tokens: tokens(text(m)),
                    path: `/project-home/outputs/${conversation.id}/${m.toolCallId}.txt`,
                    at: message.timestamp,
                  }),
                ),
            ),
          )
          oldest = i
          const call = messages
            .flatMap((m) =>
              m.role === 'assistant' ? m.content.filter((b) => b.type === 'toolCall') : [],
            )
            .find((b) => b.id === m.toolCallId)
          if (call) maskedKeys.add(callKey(call.name, call.arguments, cwd))
          if (owns && isAnthropic) masked++
        }
        if (oldest >= 0 && previous && gap <= options.ttl && !reset)
          maskRewrite = sum(messages.slice(oldest).map(size)) * p.input * 1.25
      }
      if (owns && isAnthropic) {
        const ttl = projections['1h cache']
        const convertible =
          previous && gap > options.ttl && gap <= 3600000 && u.cacheWrite > options.rewrite
        const longWritePremium = u.cacheWrite * p.input * 2 - u.cost.cacheWrite
        ttl.cost += longWritePremium
        if (convertible) {
          ttl.events++
          ttl.saved += u.cacheWrite * (p.input * 2 - p.read)
        }
        const warm = projection()
        if (previous && gap > 3600000 && u.cacheWrite > options.rewrite) {
          const pings = Math.floor(gap / (55 * 60000))
          warm.events = pings
          warm.cost =
            pings *
            ((previous.usage.input +
              previous.usage.cacheRead +
              previous.usage.cacheWrite +
              previous.usage.output) *
              p.read +
              8 * p.output)
          warm.saved = u.cacheWrite * (p.input * 2 - p.read)
          if (role !== 'worker') {
            const target =
              projections[role === 'eligible' ? 'keep-warm eligible' : 'keep-warm unknown role']
            target.events += warm.events
            target.cost += warm.cost
            target.saved += warm.saved
          }
        }
        const idsInContext = new Set(
          messages.flatMap((m) => (m.role === 'toolResult' ? [m.toolCallId] : [])),
        )
        function saved(ledger: Map<string, number>) {
          return sum([...ledger].filter(([id]) => idsInContext.has(id)).map(([, n]) => n))
        }
        const off = saved(offloaded),
          hyg = saved(hygiene),
          mask = saved(masks)
        for (const [key, n, cost] of [
          ['offload', off, 0],
          ['hygiene', hyg, hygieneRewrite],
          ['pressure masking', mask, maskRewrite],
        ] as const) {
          const row = projections[key]
          row.saved += n * p.read
          row.tokenResends += n
          row.cost += cost
          if (cost || n) row.events++
        }
        let sectionSavings = 0
        for (const item of churn) {
          const row = (sections[item.key] ??= {
            patches: 0,
            tokens: 0,
            readdTokens: 0,
            write: 0,
            resends: 0,
            resendTokens: 0,
          })
          if (!item.charged) {
            row.patches++
            row.tokens += item.tokens
            row.readdTokens += item.readd ? item.tokens : 0
            row.write += item.tokens * p.input * 1.25
            item.charged = true
            sectionSavings += item.tokens * p.input * 1.25
          } else {
            row.resendTokens += item.tokens
            row.resends += item.tokens * p.read
            sectionSavings += item.tokens * p.read
            projections['section churn upper bound'].tokenResends += item.tokens
          }
        }
        projections['section churn upper bound'].saved += sectionSavings
        if (churn.length) projections['section churn upper bound'].events++
        const combined = projections['combined eligible']
        const union = sum(
          [...idsInContext].map((id) =>
            Math.max(offloaded.get(id) ?? 0, hygiene.get(id) ?? 0, masks.get(id) ?? 0),
          ),
        )
        combined.saved +=
          union * p.read +
          sectionSavings +
          (convertible ? u.cacheWrite * (p.input * 2 - p.read) : 0) +
          (role === 'eligible' ? warm.saved : 0)
        combined.cost +=
          longWritePremium +
          (Math.max(hygieneRewrite, maskRewrite) * 2) / 1.25 +
          (role === 'eligible' ? warm.cost : 0)
        combined.tokenResends += union
        if (union || convertible || (role === 'eligible' && warm.events) || churn.length)
          combined.events++
      }
      hadContext = true
      reset = false
      systemChanged = new Set()
      toolsChanged = false
      readded = false
      removedKeys = []
      previous = message
      previousEnd = messages.length
      if (message?.role === 'assistant') {
        for (const block of message.content)
          if (block.type === 'toolCall') {
            const key = callKey(block.name, block.arguments, cwd)
            if (maskedKeys.has(key)) rereadKeys.add(key)
          }
      }
      active.push(entry)
    }
    reread += rereadKeys.size
  }
  return {
    period: {
      first: Number.isFinite(first) ? new Date(first).toISOString() : null,
      last: last ? new Date(last).toISOString() : null,
    },
    conversations: histories.length,
    requests,
    anthRequests,
    actual,
    anthropicSpend,
    attribution,
    rewrites,
    projections,
    sections,
    quality: { masked, maskedThenReread: reread, unknownContextWindows: unknownWindows },
  }
}

export function print(report: ReturnType<typeof analyze>) {
  const money = (n: number) => `$${n.toFixed(4)}`
  console.log(
    `Period: ${report.period.first} — ${report.period.last}\nConversations ${report.conversations}; requests ${report.requests} (${report.anthRequests} Anthropic); actual ${money(report.actual)} (Anthropic ${money(report.anthropicSpend)})`,
  )
  console.log('\nCache rewrite attribution (hygiene was off: 0 historical trims)')
  console.table(
    Object.entries(report.attribution).map(([cause, row]) => ({
      cause,
      count: row.count,
      writeTokens: row.tokens,
      writeCost: money(row.cost),
    })),
  )
  console.log('Projections: positive net = savings; keep-warm is incremental to 1h cache')
  console.table(
    Object.entries(report.projections).map(([change, row]) => ({
      change,
      events: row.events,
      tokenResends: row.tokenResends,
      gross: money(row.saved),
      added: money(row.cost),
      net: money(row.saved - row.cost),
    })),
  )
  console.log('Section churn (gross upper bound, not an implementable removal of all patches)')
  console.table(
    Object.entries(report.sections).map(([section, row]) => ({
      section,
      patches: row.patches,
      appendedTokens: row.tokens,
      readdTokens: row.readdTokens,
      writes: money(row.write),
      resends: money(row.resends),
    })),
  )
  console.log(
    `Masked ${report.quality.masked}; masked-then-reread ${report.quality.maskedThenReread}; unknown context-window requests ${report.quality.unknownContextWindows}`,
  )
  console.log(
    `Combined projected spend: ${money(report.actual - report.projections['combined eligible'].saved + report.projections['combined eligible'].cost)} (includes section-churn upper bound; not a forecast).`,
  )
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://127.0.0.1:4747' },
      conversations: { type: 'string' },
      ttl: { type: 'string', default: '5' },
      rewrite: { type: 'string', default: '20000' },
      keep: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  })
  const ids = values.conversations?.split(',').map(Number)
  if (ids?.some((id) => !Number.isSafeInteger(id) || id < 1))
    throw new Error('Invalid conversation IDs')
  const options: Options = {
    base: values.base!,
    conversations: ids,
    ttl: Number(values.ttl) * 60000,
    rewrite: Number(values.rewrite),
    keep: values.keep!,
    json: values.json!,
  }
  if (
    !Number.isFinite(options.ttl) ||
    !Number.isFinite(options.rewrite) ||
    !(options.ttl > 0) ||
    !(options.rewrite >= 0)
  )
    throw new Error('Invalid TTL/rewrite threshold')
  const cache = await mkdtemp(join(tmpdir(), 'ultimate-context-replay-'))
  try {
    const conversations: Conversation[] = await listConversations(options.base)
    const selected = ids ? conversations.filter((c) => ids.includes(c.id)) : conversations
    if (ids && selected.length !== new Set(ids).size)
      throw new Error('Unknown conversation ID in filter')
    const models = await get(options.base, '/api/models')
    await writeFile(join(cache, 'conversations.json'), JSON.stringify(conversations), {
      mode: 0o600,
    })
    await writeFile(join(cache, 'models.json'), JSON.stringify(models), { mode: 0o600 })
    const histories: { conversation: Conversation; entries: Entry[] }[] = []
    let cursor = 0
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < selected.length) {
          const conversation = selected[cursor++]
          const entries: Entry[] = []
          let before: number | undefined = Number.MAX_SAFE_INTEGER
          while (before !== undefined) {
            const page = await get(
              options.base,
              `/api/conversations/${conversation.id}/history?before=${before}`,
            )
            await writeFile(
              join(cache, `${conversation.id}-${before}.json`),
              JSON.stringify(page),
              { mode: 0o600 },
            )
            entries.push(...page.entries)
            if (page.before !== undefined && page.before >= before)
              throw new Error('History cursor did not advance')
            before = page.before
          }
          histories.push({ conversation, entries })
        }
      }),
    )
    const report = analyze(
      histories.toSorted((a, b) => a.conversation.id - b.conversation.id),
      models.models,
      options,
    )
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else print(report)
  } finally {
    if (options.keep) console.error(`Fetched history kept at ${cache}`)
    else await rm(cache, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
