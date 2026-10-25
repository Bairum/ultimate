import { isAbsolute, relative, resolve } from 'node:path'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { textOf } from './render.ts'

/** Deterministic hints, not verdicts: the reviewer decides whether they matter. */
export function signals(entries: readonly EntryRecord[], root: string, final = '') {
  const clean = entries.filter((e) => e.kind !== 'advisor.note')
  const calls = clean.flatMap((e) =>
    (e.model ?? []).flatMap((m) =>
      m.role === 'assistant' ? m.content.filter((b) => b.type === 'toolCall') : [],
    ),
  )
  const results = clean.flatMap((e) =>
    (e.model ?? []).flatMap((m) => (m.role === 'toolResult' ? [{ entry: e, message: m }] : [])),
  )
  const found = new Set<string>()
  const counts = new Map<string, number>()
  for (const c of calls) {
    const key = JSON.stringify([c.name, c.arguments])
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (counts.get(key)! >= 3) found.add('repeated tool call')
    if (
      c.name === 'bash' &&
      /\bgit\s+push\b[^\n]*(?:--force\b|(?:^|\s)-f\b)|\breset\s+--hard\b|\brm\s+-rf\b|\bclean\s+-fd\b/.test(
        typeof c.arguments.command === 'string' ? c.arguments.command : '',
      )
    )
      found.add('destructive shell command')
    if (['edit', 'write'].includes(c.name)) {
      const paths = typeof c.arguments.path === 'string' ? [c.arguments.path] : []
      if (c.name === 'edit' && typeof c.arguments.input === 'string')
        for (const match of c.arguments.input.matchAll(/^\[([^\]\n]+)#[^\]\n]+\]/gm))
          paths.push(match[1])
      for (const candidate of paths) {
        const path = relative(root, resolve(root, candidate))
        if (path === '..' || path.startsWith('../') || isAbsolute(path))
          found.add('write outside checkout')
      }
    }
  }
  if (results.slice(-3).length === 3 && results.slice(-3).every((r) => r.message.isError))
    found.add('three consecutive failing tools')
  const last = results.at(-1)
  if (
    final &&
    /\b(done|passing|passed|complete|finished)\b/i.test(final) &&
    last &&
    (last.message.isError || /(?:FAIL|failed|exit code [1-9])/i.test(textOf(last.entry)))
  ) {
    const call = calls.find((c) => c.id === last.message.toolCallId)
    if (
      call?.name === 'bash' &&
      /test|check|vitest|lint|build/.test(
        typeof call.arguments.command === 'string' ? call.arguments.command : '',
      )
    )
      found.add('claimed done after failing check')
  }
  if (
    clean.filter((e) =>
      e.model?.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'toolCall')),
    ).length > 40
  )
    found.add('more than 40 tool rounds')
  return [...found]
}
