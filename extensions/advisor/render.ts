import type { EntryRecord } from '@earendil-works/pi-durable'
import { isInput } from '../../lib/entries.ts'
import type { Role, StoredNote, Severity } from './refs.ts'
import { SEVERITIES } from './refs.ts'

export const rank = (s: Severity) => SEVERITIES.indexOf(s)
export function textOf(entry: EntryRecord | undefined) {
  return (entry?.model ?? [])
    .flatMap((m) =>
      typeof m.content === 'string'
        ? [m.content]
        : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])),
    )
    .join('\n')
}
export const isContinuation = (entry: EntryRecord, continuations: readonly string[]) =>
  entry.kind === 'pi.user' && continuations.includes(textOf(entry))
export function renderInput(
  entries: readonly EntryRecord[],
  role: Role,
  rubric: string,
  agents: string,
  signal?: string,
  ledger?: unknown,
  latest?: string,
  compact = false,
  continuations: readonly string[] = [],
  raised: readonly StoredNote[] = [],
) {
  const clean = entries.filter(
    (e) => e.kind !== 'advisor.note' && !isContinuation(e, continuations),
  )
  const results = new Map(
    clean.flatMap((e) =>
      (e.model ?? []).flatMap((m) =>
        m.role === 'toolResult'
          ? [
              [
                m.toolCallId,
                {
                  entry: e.id,
                  text: JSON.stringify(m.content).slice(0, compact ? 400 : 1600),
                  error: m.isError,
                },
              ] as const,
            ]
          : [],
      ),
    ),
  )
  const calls = clean.flatMap((e) =>
    (e.model ?? []).flatMap((m) =>
      m.role === 'assistant'
        ? m.content.flatMap((b) =>
            b.type === 'toolCall'
              ? [
                  {
                    entry: e.id,
                    name: b.name,
                    arguments: JSON.stringify(b.arguments).slice(0, compact ? 200 : 1200),
                    result: results.get(b.id),
                  },
                ]
              : [],
          )
        : [],
    ),
  )
  return JSON.stringify({
    role,
    rubric: rubric.slice(0, 20_480),
    signal,
    agents: agents.slice(0, 8192),
    request: textOf(clean.find(isInput)).slice(0, compact ? 1500 : 8000),
    latest:
      latest?.slice(0, compact ? 1500 : 8000) ??
      clean
        .filter((e) => e.model?.some((m) => m.role === 'assistant'))
        .slice(-1)
        .map((e) => ({ entry: e.id, text: textOf(e).slice(0, compact ? 1500 : 8000) })),
    ledger: ledger === undefined ? undefined : JSON.stringify(ledger).slice(0, 8192),
    // Notes routed here from finished children: the agent already has them, so never raise them again.
    alreadyRaised: raised.length
      ? raised.slice(-10).map((n) => `${n.severity}: ${n.note.slice(0, 300)}`)
      : undefined,
    recentTools: calls.slice(compact ? -10 : -25),
  }).slice(0, compact ? 12_000 : 90_000)
}
export type ReviewNote = { severity: Severity; note: string; evidence: string }
export const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()
export function parseNotes(
  value: unknown,
  maxNotes: number,
  previous: StoredNote[],
  conversation: number,
  now: number,
): ReviewNote[] {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some((k) => !['notes', 'ledger'].includes(k)) ||
    !Array.isArray((value as { notes?: unknown }).notes)
  )
    throw new Error('Invalid review JSON')
  const notes: ReviewNote[] = []
  let regular = 0
  for (const n of (value as { notes: unknown[] }).notes) {
    if (!n || typeof n !== 'object') continue
    const raw = n as ReviewNote
    if (
      Object.keys(raw).some((k) => !['severity', 'note', 'evidence'].includes(k)) ||
      !SEVERITIES.includes(raw.severity) ||
      typeof raw.note !== 'string' ||
      !raw.note.trim() ||
      typeof raw.evidence !== 'string' ||
      !raw.evidence.trim()
    )
      continue
    // The offline trial lost 4 of 54 substantive notes to the length limits; clip instead of dropping them.
    const clip = (text: string, size: number) =>
      text.length > size ? `${text.slice(0, size - 1)}…` : text
    const v = {
      severity: raw.severity,
      note: clip(raw.note, 500),
      evidence: clip(raw.evidence, 300),
    }
    if (
      previous.some(
        (p) =>
          (p.conversation === conversation || p.routedTo === conversation) &&
          p.at >= now - 86_400_000 &&
          normalize(p.note) === normalize(v.note) &&
          rank(p.severity) >= rank(v.severity),
      ) ||
      notes.some(
        (p) => normalize(p.note) === normalize(v.note) && rank(p.severity) >= rank(v.severity),
      )
    )
      continue
    if (v.severity !== 'blocker' && ++regular > maxNotes) continue
    notes.push(v)
  }
  return notes
}
export function advisory(advisor: string, notes: (ReviewNote & { ref?: string })[]) {
  const escape = (v: string) =>
    v
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  return (
    notes
      .map(
        (n) =>
          `<advisory${n.ref ? ` id="${escape(n.ref)}"` : ''} advisor="${escape(advisor)}" severity="${n.severity}" guidance="weigh, don't blindly obey">${escape(n.note)} (evidence: ${escape(n.evidence)})</advisory>`,
      )
      .join('\n') +
    (notes.some((n) => n.ref)
      ? `\nAnswer each advisory in your next reply with a line: advisor ${notes
          .map((n) => n.ref)
          .filter(Boolean)
          .join('|')}: addressed|deferred|disputed — reason.`
      : '')
  )
}
