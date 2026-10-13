// Pi upstream: @earendil-works/pi-durable@1.2.0 src/tools/edit.ts — internal untyped details.patch counts an edit's lines. Drop when Pi exports structured diff rows for rendering.
import { isAbsolute, relative } from 'node:path'
import type { JsonValue } from '@earendil-works/chord'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import { AssistantEntry, ToolResultEntry } from '@earendil-works/pi-durable'
import type { AgentState, EntryRecord, LiveState, UsageState } from '@earendil-works/pi-durable'
import { lastAssistant, promptTokens, usageTotals } from '../status-line/context.ts'
import type { CanvasAgent, CanvasUsage } from './types.ts'

const TOOLS = 8
const EDITS = 4
const THINKING = 240
const WRITING = 400
const LABEL = 80

type Args = Record<string, JsonValue>
/** What a result or a waiting call still needs from its call. */
type Call = { name: string; path?: string; lines?: number; action?: string }
/** One agent's row, and the calls of its current tool round. */
export type Feed = { agent: CanvasAgent; calls: Map<string, Call> }
/** Paths show relative to the conversation's cwd, else with `~` for the home. */
export type Place = { cwd: string; home: string }

export const newFeed = (): Feed => ({
  agent: { tools: [], edits: [], updatedAt: 0 },
  calls: new Map(),
})
/** Whether the row has anything to show. */
export const active = (agent: CanvasAgent) =>
  agent.tools.length > 0 ||
  agent.edits.length > 0 ||
  agent.thinking !== undefined ||
  agent.writing !== undefined

const text = (value: JsonValue | undefined) => (typeof value === 'string' ? value : '')
const firstLine = (value: string) =>
  value.split('\n').find((line) => line.trim() && !line.startsWith('// @options')) ?? ''
function lineCount(value: string) {
  if (!value) return 0
  return value.split('\n').length - (value.endsWith('\n') ? 1 : 0)
}
/** A path relative to the cwd when inside it, else with `~` for the home. */
export function shorten(path: string, { cwd, home }: Place) {
  if (!isAbsolute(path)) return path
  const inner = relative(cwd, path)
  if (inner && !inner.startsWith('..') && !isAbsolute(inner)) return inner
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** A call in a few words, as its transcript renderer titles it. */
function label(name: string, args: Args, place: Place) {
  const path = shorten(text(args.path), place)
  const id = typeof args.id === 'number' ? `#${args.id}` : '#?'
  let summary: string
  if (name === 'read') {
    const offset = typeof args.offset === 'number' ? args.offset : undefined
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    const range =
      offset || limit ? `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : '+'}` : ''
    summary = `read ${path}${range}`
  } else if (name === 'edit' || name === 'write') summary = `${name} ${path}`
  else if (name === 'bash') summary = `$ ${firstLine(text(args.command))}`
  else if (name === 'subagent') {
    const action = text(args.action) || 'start'
    summary =
      action === 'start'
        ? `start ${text(args.agent)}: ${firstLine(text(args.task))}`
        : action === 'list'
          ? 'list children'
          : action === 'message'
            ? `message ${id}: ${firstLine(text(args.text))}`
            : `${action} ${id}`
  } else if (name === 'codemode') summary = `codemode: ${firstLine(text(args.code))}`
  else if (name === 'plan')
    summary = `plan ${text(args.action)} ${text(args.title) || text(args.key) || text(args.epic)}`
  else if (name === 'workspace') summary = `workspace ${text(args.action)}`
  else if (name === 'browser' || name === 'screenshot')
    summary = `${name} ${text(args.url) ? text(args.url) + text(args.path) : text(args.path) || 'this UI'}`
  else
    summary = `${name} ${Object.entries(args)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ')}`
  summary = summary.replace(/\s+/g, ' ').trim()
  return summary.length > LABEL ? `${summary.slice(0, LABEL - 1)}…` : summary
}

function tail(value: string, limit: number) {
  if (value.length <= limit) return value
  const cut = value.slice(value.length - limit + 1)
  // Never start with the second half of a surrogate pair.
  return `…${/^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut}`
}

/** Lines added and removed by an edit, from the unified `details.patch` of Pi's edit tool. */
function counted(details: unknown) {
  const patch = (details as { patch?: unknown } | undefined)?.patch
  let added = 0
  let removed = 0
  let hunk = false
  for (const line of typeof patch === 'string' ? patch.split('\n') : []) {
    if (line.startsWith('@@')) hunk = true
    else if (hunk && line.startsWith('+')) added++
    else if (hunk && line.startsWith('-')) removed++
  }
  return { added, removed }
}

function applyTexts(agent: CanvasAgent, content: AssistantMessage['content'], now: number) {
  let changed = false
  const thinking = content
    .flatMap((part) => (part.type === 'thinking' ? [part.thinking] : []))
    .join('\n\n')
    .trim()
  const writing = content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
    .trim()
  for (const [key, value, limit] of [
    ['thinking', thinking, THINKING],
    ['writing', writing, WRITING],
  ] as const) {
    if (!value) continue
    const shown = tail(value, limit)
    if (agent[key]?.text === shown) continue
    agent[key] = { text: shown, at: now }
    changed = true
  }
  return changed
}

const usageOf = (agent: CanvasAgent): CanvasUsage =>
  (agent.usage ??= { input: 0, output: 0, cacheRead: 0, cost: 0 })

/** Set `fields` of the row's usage; returns whether any changed. */
function setUsage(agent: CanvasAgent, fields: Partial<CanvasUsage>) {
  const usage = usageOf(agent)
  let changed = false
  for (const [key, value] of Object.entries(fields) as [keyof CanvasUsage, never][]) {
    if (usage[key] === value) continue
    if (value === undefined) delete usage[key]
    else usage[key] = value
    changed = true
  }
  return changed
}

/** Apply the conversation's `pi.usage`: its totals over every model and tool. */
export function applyUsage(feed: Feed, state: Readonly<UsageState>) {
  const { input, output, cacheRead, cost } = usageTotals(state)
  return setUsage(feed.agent, { input, output, cacheRead, cost })
}

/** Apply the conversation's `pi.agent`: its model. */
export function applyAgent(feed: Feed, state: Readonly<AgentState>) {
  return setUsage(feed.agent, { provider: state.model?.provider, model: state.model?.modelId })
}

/** Apply a committed answer (its texts and tool calls) or tool result; returns whether the row changed. */
export function applyEntry(feed: Feed, entry: EntryRecord, now: number, place: () => Place) {
  const { agent, calls } = feed
  // The context, as the status line counts it: the latest answer's prompt, unknown after a compaction or reset.
  const { message: answer, stale } = lastAssistant([entry])
  let changed =
    answer || stale
      ? setUsage(agent, { context: answer ? promptTokens(answer.usage) : undefined })
      : false
  if (AssistantEntry.is(entry)) {
    const message = entry.model?.[0]
    if (message?.role !== 'assistant') return changed
    changed = applyTexts(agent, message.content, now) || changed
    for (const part of message.content) {
      if (part.type !== 'toolCall' || agent.tools.some((tool) => tool.id === part.id)) continue
      const args = part.arguments as Args
      const where = place()
      agent.tools.push({
        id: part.id,
        name: part.name,
        label: label(part.name, args, where),
        status: 'running',
        at: now,
      })
      agent.tools.splice(0, Math.max(0, agent.tools.length - TOOLS))
      calls.set(part.id, {
        name: part.name,
        ...(part.name === 'edit' || part.name === 'write'
          ? { path: shorten(text(args.path), where) }
          : {}),
        ...(part.name === 'write' ? { lines: lineCount(text(args.content)) } : {}),
        ...(part.name === 'subagent' ? { action: text(args.action) || 'start' } : {}),
      })
      changed = true
    }
  } else if (ToolResultEntry.is(entry)) {
    const message = entry.model?.[0] as ToolResultMessage | undefined
    if (message?.role !== 'toolResult') return changed
    const status = message.isError ? 'error' : 'done'
    const tool = agent.tools.find((candidate) => candidate.id === message.toolCallId)
    if (tool && tool.status !== status) {
      tool.status = status
      changed = true
    }
    const call = calls.get(message.toolCallId)
    calls.delete(message.toolCallId)
    if (call?.path && !message.isError) {
      agent.edits.push({
        path: call.path,
        ...(call.name === 'write'
          ? { added: call.lines ?? 0, removed: 0 }
          : counted(message.details)),
        at: now,
      })
      agent.edits.splice(0, Math.max(0, agent.edits.length - EDITS))
      changed = true
    }
  }
  if (changed) agent.updatedAt = now
  return changed
}

/** Apply the live state: the streaming answer, and the statuses and waits of the current tool round. */
export function applyLive(feed: Feed, live: Readonly<LiveState>, now: number) {
  const { agent, calls } = feed
  const partial = live.generation?.message as AssistantMessage | undefined
  let changed = partial ? applyTexts(agent, partial.content, now) : false
  const slots = live.tools ?? []
  // A running call that left the round, or ended without a result entry, was interrupted.
  for (const tool of agent.tools) {
    if (tool.status !== 'running') continue
    const slot = slots.find((candidate) => candidate.callId === tool.id)
    if (slot && (slot.status !== 'done' || slot.entry !== undefined)) continue
    tool.status = 'error'
    changed = true
  }
  for (const id of calls.keys()) if (!slots.some((slot) => slot.callId === id)) calls.delete(id)
  // A subagent call names its child in details; a background start or message returns at once.
  const waiting = [
    ...new Set(
      slots.flatMap((slot) => {
        const details = slot.details as { conversationId?: unknown; background?: unknown }
        const action = calls.get(slot.callId)?.action
        return slot.status === 'running' &&
          typeof details?.conversationId === 'number' &&
          (action === 'wait' ||
            ((action === 'start' || action === 'message') && details.background !== true))
          ? [details.conversationId]
          : []
      }),
    ),
  ]
  if (waiting.join() !== (agent.waitingOn ?? []).join()) {
    if (waiting.length) agent.waitingOn = waiting
    else delete agent.waitingOn
    changed = true
  }
  if (changed) agent.updatedAt = now
  return changed
}
