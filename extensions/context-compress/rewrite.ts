import type { Message } from '@earendil-works/pi-ai'
import { estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { ContextView } from '@earendil-works/pi-durable'
import type { Range, Turn } from './refs.ts'
export function turns(view: ContextView, ranges: readonly Range[]): Turn[] {
  const result: Turn[] = []
  let current: Turn | undefined
  let suffix = 0
  const protectedEntries = new Set<number>()
  for (let i = view.entries.length - 1; i >= 0; i--) {
    if (suffix < 16000) protectedEntries.add(view.entries[i].id)
    suffix += view.contributions[i].reduce((n, m) => n + estimateMessageTokens(m), 0)
  }
  for (let i = 0; i < view.entries.length; i++) {
    const entry = view.entries[i]
    const messages = view.contributions[i]
    if (entry.kind === 'pi.user') {
      const user = messages.find((m) => m.role === 'user')
      const content = user?.content
      const text =
        typeof content === 'string'
          ? content
          : (content?.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ') ?? '')
      current = {
        id: entry.id,
        fromEntry: entry.id,
        toEntry: entry.id,
        tokens: 0,
        gist: text.split('\n')[0],
        compressed: null,
      }
      result.push(current)
    }
    if (!current) continue
    current.toEntry = entry.id
    // System baselines stay in the request, even when stored between this turn's entries.
    current.tokens += messages.reduce(
      (n, m) => n + (m.role === 'system' ? 0 : estimateMessageTokens(m)),
      0,
    )
    const names = messages.flatMap((m) =>
      m.role === 'assistant'
        ? m.content.flatMap((p) => (p.type === 'toolCall' ? [p.name] : []))
        : [],
    )
    if (names.length) current.gist += ` · ${[...new Set(names)].join(', ')}`
  }
  return result
    .filter(
      (turn, index) =>
        index < result.length - 1 &&
        !view.entries.some(
          (e) => e.id >= turn.fromEntry && e.id <= turn.toEntry && protectedEntries.has(e.id),
        ),
    )
    .map((turn) => ({
      ...turn,
      compressed:
        ranges.find((r) => r.active && r.fromEntry <= turn.fromEntry && r.toEntry >= turn.toEntry)
          ?.id ?? null,
    }))
}
export function validate(
  view: ContextView,
  ranges: readonly Range[],
  from: number,
  to: number,
  summary: string,
) {
  const available = turns(view, ranges)
  const start = available.findIndex((t) => t.id === from)
  const end = available.findIndex((t) => t.id === to)
  if (start < 0 || end < start)
    throw new Error('Choose whole turns outside the newest 16k tokens from context_ranges')
  const selected = available.slice(start, end + 1)
  const fromEntry = selected[0].fromEntry,
    toEntry = selected.at(-1)!.toEntry
  if (ranges.some((r) => r.active && r.fromEntry <= toEntry && r.toEntry >= fromEntry))
    throw new Error('Range overlaps an active compression')
  const tokens = selected.reduce((n, t) => n + t.tokens, 0)
  if (!summary.trim() || estimateTextTokens(summary) > tokens / 4)
    throw new Error('Summary must be non-empty and at most 25% of the original tokens')
  return { fromEntry, toEntry, tokens }
}
export function prune(ranges: Range[], view: ContextView) {
  const present = new Set<number>(view.entries.map((e) => e.id))
  for (const range of ranges)
    if (!present.has(range.fromEntry) || !present.has(range.toEntry)) range.active = false
}

/** Content aligns contributions, never identifies turns. Entry ids alone own ranges. */
export function rewrite(
  messages: readonly Message[],
  view: ContextView,
  ranges: readonly Range[],
  hygienize: (messages: readonly Message[]) => readonly Message[],
): readonly Message[] {
  const active = ranges.filter((r) => r.active)
  if (!active.length) return messages
  const originals = view.contributions.flatMap((batch, i) =>
    batch.map((message) => ({ message, entry: view.entries[i].id, used: false })),
  )
  const normalized = hygienize(originals.map((item) => item.message))
  const byContent = new Map<string, number[]>()
  originals.forEach((item, i) => {
    for (const bytes of new Set([JSON.stringify(item.message), JSON.stringify(normalized[i])]))
      byContent.set(bytes, [...(byContent.get(bytes) ?? []), i])
  })
  const owners = messages.map((message) => {
    const candidates = byContent.get(JSON.stringify(message)) ?? []
    const index = candidates.find((i) => !originals[i].used)
    if (index === undefined) {
      if (
        candidates.some((i) =>
          active.some((r) => originals[i].entry >= r.fromEntry && originals[i].entry <= r.toEntry),
        )
      )
        throw new Error('Ambiguous injected copy of a compressed message')
      return undefined // Other hooks' injected messages stay exactly where they were.
    }
    originals[index].used = true
    return originals[index].entry
  })
  const replacements = new Map<number, Message>()
  const removed = new Set<number>()
  for (const range of active) {
    const inside = (entry: number | undefined) =>
      entry !== undefined && entry >= range.fromEntry && entry <= range.toEntry
    if (
      originals.some((item) => inside(item.entry) && !item.used && item.message.role !== 'system')
    )
      throw new Error(`Cannot align entries for ${range.id}`)
    const indices = owners.flatMap((entry, i) =>
      inside(entry) && messages[i].role !== 'system' ? [i] : [],
    )
    if (!indices.length) throw new Error(`No messages for ${range.id}`)
    const selected = new Set(indices)
    // Every result and every call must have its partner on the same side of the fold.
    const calls = new Map<string, number[]>(),
      results = new Map<string, number[]>()
    messages.forEach((message, i) => {
      if (message.role === 'assistant')
        for (const part of message.content)
          if (part.type === 'toolCall') calls.set(part.id, [...(calls.get(part.id) ?? []), i])
      if (message.role === 'toolResult')
        results.set(message.toolCallId, [...(results.get(message.toolCallId) ?? []), i])
    })
    for (const id of new Set([...calls.keys(), ...results.keys()])) {
      const c = calls.get(id) ?? [],
        r = results.get(id) ?? []
      if (
        [...c, ...r].some((i) => selected.has(i)) &&
        (c.length !== 1 || r.length !== 1 || ![...c, ...r].every((i) => selected.has(i)))
      )
        throw new Error(`Split or ambiguous tool pair in ${range.id}`)
    }
    const lastTurn = view.entries.findLast((entry) => entry.kind === 'pi.user' && inside(entry.id))
    if (!lastTurn) throw new Error(`Cannot find turns for ${range.id}`)
    indices.forEach((i) => removed.add(i))
    replacements.set(indices[0], {
      role: 'user',
      content: `<compressed id="${range.id}" turns="${range.fromEntry}–${lastTurn.id}">${range.summary}</compressed>`,
      timestamp: 0,
    })
  }
  return messages.flatMap((message, i) =>
    replacements.has(i) ? [replacements.get(i)!] : removed.has(i) ? [] : [message],
  )
}
