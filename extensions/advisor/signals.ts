import { isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { parse } from 'unbash'
import type { Command, Word } from 'unbash'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { textOf } from './render.ts'

const cleanupPattern = /\brm\s+-rf\b|\bclean\s+-fd\b/g

function cleanupPath(word: Word) {
  let value = word.value
  if (!word.text.startsWith("'")) value = value.replace(/^\$(?:TMPDIR\b|\{TMPDIR\})/, tmpdir())
  // Unknown expansions, command substitutions and brace alternatives are not proven temp-only.
  return /[$`{}]/.test(value) ? undefined : value
}
function tempPath(word: Word, cwd: string | undefined) {
  const value = cleanupPath(word)
  if (value === undefined || (!isAbsolute(value) && cwd === undefined)) return false
  const path = isAbsolute(value) ? resolve(value) : resolve(cwd!, value)
  return inTemp(path)
}
function inTemp(path: string) {
  return ['/tmp', tmpdir()].some((temp) => {
    const suffix = relative(resolve(temp), path)
    return suffix !== '' && suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix)
  })
}

function tempCleanup(command: Command, cwd: string | undefined, position: number) {
  if (command.prefix.length || command.args.some((a) => a.type !== 'Word')) return false
  const words = command.args as readonly Word[]
  let args = words
  if (command.name?.value === 'git') {
    const clean = words.findIndex((w) => w.value === 'clean' && w.pos === position)
    if (clean < 0) return false
    // Only -C changes the checkout here; unknown global options keep the signal.
    for (let i = 0; i < clean; i += 2) {
      if (words[i]?.value !== '-C' || !words[i + 1]) return false
      const directory = cleanupPath(words[i + 1])
      if (directory === undefined || (!isAbsolute(directory) && cwd === undefined)) return false
      cwd = isAbsolute(directory) ? resolve(directory) : resolve(cwd!, directory)
    }
    args = words.slice(clean + 1)
  } else if (command.name?.value !== 'rm' || command.name.pos !== position) return false
  let options = true
  const targets: Word[] = []
  for (const arg of args) {
    if (options && arg.value === '--') {
      options = false
      continue
    }
    if (options && arg.value.startsWith('-')) continue
    targets.push(arg)
  }
  if (!targets.length) return command.name?.value === 'git' && cwd !== undefined && inTemp(cwd)
  return targets.every((target) => tempPath(target, cwd))
}

function destructiveShell(source: string, root: string) {
  if (/\bgit\s+push\b[^\n]*(?:--force\b|(?:^|\s)-f\b)|\breset\s+--hard\b/.test(source)) return true
  const cleanups = [...source.matchAll(cleanupPattern)]
  if (!cleanups.length) return false
  if (/\b(?:TMPDIR|TMP|TEMP)=/.test(source) && /\$(?:TMPDIR\b|\{TMPDIR\})/.test(source)) return true
  const script = parse(source)
  if (script.errors?.length) return true
  const commands: Command[] = []
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if ((node as { type?: string }).type === 'Command') commands.push(node as Command)
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object') visit(child)
    }
  }
  visit(script)
  // Every risky occurrence must be an understood cleanup with only temp targets.
  const cwd = /\b(?:cd|pushd|popd)\b/.test(source) ? undefined : root
  return cleanups.some(
    (match) => !commands.some((command) => tempCleanup(command, cwd, match.index)),
  )
}

export type SignalState = {
  cursor: number
  counts: Record<string, number>
  failures: number
  rounds: number
  checks: Record<string, boolean>
  lastCheckFailed: boolean
  seen: string[]
}
export const initialSignals = (): SignalState => ({
  cursor: 0,
  counts: {},
  failures: 0,
  rounds: 0,
  checks: {},
  lastCheckFailed: false,
  seen: [],
})
/** Deterministic hints, not verdicts: the reviewer decides whether they matter. */
export function signals(
  entries: readonly EntryRecord[],
  root: string,
  final = '',
  state = initialSignals(),
) {
  const clean = entries.filter((e) => e.kind !== 'advisor.note' && e.id > state.cursor)
  const calls = clean.flatMap((e) =>
    (e.model ?? []).flatMap((m) =>
      m.role === 'assistant' ? m.content.filter((b) => b.type === 'toolCall') : [],
    ),
  )
  const results = clean.flatMap((e) =>
    (e.model ?? []).flatMap((m) => (m.role === 'toolResult' ? [{ entry: e, message: m }] : [])),
  )
  const found = new Set<string>(state.seen)
  for (const c of calls) {
    const key = createHash('sha256')
      .update(JSON.stringify([c.name, c.arguments]))
      .digest('hex')
    state.counts[key] = (state.counts[key] ?? 0) + 1
    if (state.counts[key] >= 3) found.add('repeated tool call')
    state.checks[c.id] =
      c.name === 'bash' &&
      /test|check|vitest|lint|build/.test(
        typeof c.arguments.command === 'string' ? c.arguments.command : '',
      )
    if (
      c.name === 'bash' &&
      destructiveShell(typeof c.arguments.command === 'string' ? c.arguments.command : '', root)
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
  for (const { entry, message } of results) {
    state.failures = message.isError ? state.failures + 1 : 0
    if (state.failures >= 3) found.add('three consecutive failing tools')
    state.lastCheckFailed = false
    if (
      state.checks[message.toolCallId] &&
      (message.isError || /(?:FAIL|failed|exit code [1-9])/i.test(textOf(entry)))
    )
      state.lastCheckFailed = true
    delete state.checks[message.toolCallId]
  }
  state.rounds += clean.filter((e) =>
    e.model?.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'toolCall')),
  ).length
  if (final && /\b(done|passing|passed|complete|finished)\b/i.test(final) && state.lastCheckFailed)
    found.add('claimed done after failing check')
  if (state.rounds > 40) found.add('more than 40 tool rounds')
  for (const entry of clean) state.cursor = Math.max(state.cursor, entry.id)
  state.seen = [...found]
  return [...found]
}
