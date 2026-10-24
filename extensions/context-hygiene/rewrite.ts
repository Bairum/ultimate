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
      return '[Elided from context: superseded by a later read of the same path. Read it again if you need it.]'
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
  return messages.map((message) => {
    const decision = message.role === 'toolResult' ? decisions[message.toolCallId] : undefined
    if (message.role !== 'toolResult' || decision?.state !== 'applied' || !safe(message))
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
function range(call: ToolCall) {
  const start = typeof call.arguments.offset === 'number' ? call.arguments.offset : 1
  const end = typeof call.arguments.limit === 'number' ? start + call.arguments.limit : Infinity
  return {
    start,
    end,
    whole: call.arguments.offset === undefined && call.arguments.limit === undefined,
  }
}
export function candidates(messages: readonly Message[], cwd: string, now: number) {
  const calls = new Map<string, { call: ToolCall; index: number }>()
  messages.forEach((message, index) => {
    if (message.role === 'assistant')
      for (const part of message.content)
        if (part.type === 'toolCall') calls.set(part.id, { call: part, index })
  })
  const decisions: LedgerState['decisions'] = {}
  messages.forEach((message, index) => {
    if (message.role !== 'toolResult' || !safe(message)) return
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
      if (later.role !== 'toolResult' || !safe(later)) continue
      const next = calls.get(later.toolCallId)
      if (!next) continue
      if (
        message.toolName === later.toolName &&
        canonical(own.call.arguments) === canonical(next.call.arguments) &&
        text(message) === text(later)
      ) {
        reason = 'duplicate'
        by = later.toolCallId
      }
      if (own.call.name !== 'read' || next.call.name !== 'read') continue
      const path = pathOf(own.call, cwd)
      if (!path || path !== pathOf(next.call, cwd)) continue
      const a = range(own.call),
        b = range(next.call)
      const edited = [...calls.values()].some(
        ({ call, index: at }) =>
          at > own.index &&
          at < next.index &&
          (call.name === 'edit' || call.name === 'write') &&
          pathOf(call, cwd) === path,
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
