import { resolve } from 'node:path'
import type { Message, ToolCall } from '@earendil-works/pi-ai'
import { estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { Decision, GateInput, LedgerState, Thresholds } from './api.ts'

export const defaults: Thresholds = {
  cacheTtlMs: 300_000,
  protectTokens: 16_000,
  suffixTokens: 8_000,
  suffixSavings: 2_000,
  pressureRatio: 0.6,
  pressureSavings: 8_000,
}
export const estimate = estimateMessageTokens
const text = (message: Extract<Message, { role: 'toolResult' }>) =>
  message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
const safe = (message: Extract<Message, { role: 'toolResult' }>) =>
  !message.isError && message.content.every((part) => part.type === 'text')

export function gateOpen(input: GateInput, thresholds: Thresholds): boolean {
  return (
    input.newContext ||
    (input.lastAssistant !== undefined &&
      input.now - input.lastAssistant > thresholds.cacheTtlMs) ||
    (input.suffixTokens <= thresholds.suffixTokens && input.savings >= thresholds.suffixSavings) ||
    (input.contextWindow > 0 &&
      input.requestTokens > thresholds.pressureRatio * input.contextWindow &&
      input.savings >= thresholds.pressureSavings)
  )
}
function placeholder(decision: Decision): string {
  switch (decision.reason) {
    case 'superseded':
      return `[Elided from context: superseded by a later read of ${decision.path}. Read it again if you need it.]`
    case 'empty':
      return '[Elided: empty result]'
    case 'duplicate':
      return '[Elided: duplicate of a later identical result]'
    default:
      throw new Error('Unknown context hygiene decision')
  }
}
export function rewrite(
  messages: readonly Message[],
  decisions: LedgerState['decisions'],
): readonly Message[] {
  const counts = resultCounts(messages)
  return messages.map((message) => {
    const decision = message.role === 'toolResult' ? decisions[message.toolCallId] : undefined
    if (
      message.role !== 'toolResult' ||
      !message.toolCallId ||
      counts.get(message.toolCallId) !== 1 ||
      decision?.state !== 'applied' ||
      !safe(message)
    )
      return message
    return { ...message, content: [{ type: 'text', text: placeholder(decision) }] }
  })
}
// Canonical argument order makes object key insertion order irrelevant to duplicate detection.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function pathOf(call: ToolCall, cwd: string) {
  return typeof call.arguments.path === 'string' ? resolve(cwd, call.arguments.path) : undefined
}
function resultCounts(messages: readonly Message[]) {
  const counts = new Map<string, number>()
  for (const message of messages)
    if (message.role === 'toolResult')
      counts.set(message.toolCallId, (counts.get(message.toolCallId) ?? 0) + 1)
  return counts
}
function range(call: ToolCall, result: Extract<Message, { role: 'toolResult' }>) {
  const start = typeof call.arguments.offset === 'number' ? Math.max(1, call.arguments.offset) : 1
  const details = result.details
  // Hashline's read records exactly which rows it displayed; its text output adds a [path#TAG] header row.
  const shown =
    details && typeof details === 'object' && 'hashline' in details ? details.hashline : undefined
  if (shown && typeof shown === 'object' && 'text' in shown && 'startLine' in shown) {
    if (typeof shown.text !== 'string' || typeof shown.startLine !== 'number') return undefined
    return {
      start: shown.startLine,
      end: shown.startLine + shown.text.split('\n').length,
      whole: 'full' in shown && shown.full === true,
    }
  }
  const truncation =
    details && typeof details === 'object' && 'truncation' in details
      ? details.truncation
      : undefined
  if (truncation !== undefined) {
    if (
      !truncation ||
      typeof truncation !== 'object' ||
      !('outputLines' in truncation) ||
      typeof truncation.outputLines !== 'number' ||
      !Number.isSafeInteger(truncation.outputLines) ||
      truncation.outputLines <= 0 ||
      ('firstLineExceedsLimit' in truncation && truncation.firstLineExceedsLimit === true)
    )
      return undefined
    if (!('truncated' in truncation) || typeof truncation.truncated !== 'boolean') return undefined
    return {
      start,
      end: start + truncation.outputLines,
      whole:
        !truncation.truncated &&
        call.arguments.offset === undefined &&
        call.arguments.limit === undefined,
    }
  }
  // Pi omits details for untruncated text. Remove its user-limit continuation notice.
  const output = text(result).replace(
    /\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/,
    '',
  )
  if (!output || /\[Showing lines |exceeds .* limit\. Use bash:/.test(output)) return undefined
  return {
    start,
    end: start + output.split('\n').length,
    whole: call.arguments.offset === undefined && call.arguments.limit === undefined,
  }
}
export function candidates(
  messages: readonly Message[],
  cwd: string,
  now: number,
  decided: LedgerState['decisions'] = {},
) {
  const calls = new Map<string, { call: ToolCall; index: number }>()
  const callCounts = new Map<string, number>()
  const results = resultCounts(messages)
  const canonicalArgs = new Map<string, string>()
  messages.forEach((message, index) => {
    if (message.role === 'assistant')
      for (const part of message.content)
        if (part.type === 'toolCall') {
          calls.set(part.id, { call: part, index })
          callCounts.set(part.id, (callCounts.get(part.id) ?? 0) + 1)
          canonicalArgs.set(part.id, canonical(part.arguments))
        }
  })
  const unique = (id: string) => id !== '' && callCounts.get(id) === 1 && results.get(id) === 1
  const decisions: LedgerState['decisions'] = {}
  messages.forEach((message, index) => {
    if (
      message.role !== 'toolResult' ||
      !safe(message) ||
      !unique(message.toolCallId) ||
      decided[message.toolCallId]
    )
      return
    const own = calls.get(message.toolCallId)
    if (!own) return
    let reason: Decision['reason'] | undefined
    let by: string | undefined
    if (
      message.details &&
      typeof message.details === 'object' &&
      !Array.isArray(message.details) &&
      'useless' in message.details &&
      message.details.useless === true
    )
      reason = 'empty'
    for (let j = index + 1; j < messages.length; j++) {
      const later = messages[j]
      if (later.role !== 'toolResult' || !safe(later) || !unique(later.toolCallId)) continue
      const next = calls.get(later.toolCallId)
      if (!next) continue
      if (
        message.toolName === later.toolName &&
        canonicalArgs.get(message.toolCallId) === canonicalArgs.get(later.toolCallId) &&
        text(message) === text(later)
      ) {
        reason = 'duplicate'
        by = later.toolCallId
      }
      if (own.call.name !== 'read' || next.call.name !== 'read') continue
      const path = pathOf(own.call, cwd)
      if (!path || path !== pathOf(next.call, cwd)) continue
      const a = range(own.call, message),
        b = range(next.call, later)
      if (!a || !b) continue
      const edited = [...calls.values()].some(
        ({ call, index: at }) =>
          at >= own.index && at <= next.index && !['read', 'grep'].includes(call.name),
      )
      if (b.whole || (!edited && b.start <= a.start && b.end >= a.end)) {
        reason = 'superseded'
        by = later.toolCallId
      }
    }
    if (reason) {
      const decision: Decision = {
        reason,
        ...(by ? { by } : {}),
        ...(reason === 'superseded' && typeof own.call.arguments.path === 'string'
          ? { path: own.call.arguments.path }
          : {}),
        tokens: 0,
        state: 'pending',
        at: now,
      }
      decision.tokens = Math.max(
        0,
        estimateTextTokens(text(message)) - estimateTextTokens(placeholder(decision)),
      )
      decisions[message.toolCallId] = decision
    }
  })
  return decisions
}
