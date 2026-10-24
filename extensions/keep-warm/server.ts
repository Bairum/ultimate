/**
 * Keep warm: Claude Code caches @ultimate's prompt for an hour after each request. Shortly before that hour ends, with
 * @ultimate idle and the user away less than 8 hours, one request replays @ultimate's context as its next request would
 * send it, plus a one-word question. It reads the whole prefix from the cache, which renews the hour, and leaves
 * nothing in any transcript; its tokens count toward @ultimate's usage.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { copyJson } from '@earendil-works/chord'
import type { ResponseReceipt } from '../conversations/summary.ts'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { PauseApi } from '../pause/api.ts'
import { Standing } from '../subagents/api.ts'
import { due, IDLE_STOP, LEAD } from './due.ts'
import { SetAction, StateAction, WarmDoc } from './refs.ts'
import type { Ping, WarmDocState, WarmState } from './refs.ts'

const State = defineDoc<WarmDocState>({
  kind: WarmDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [State]

/** How often the timer looks; a ping lands within a minute after `LEAD`, well inside the hour. */
const TICK = 60_000
/** Only Claude Code asks for the hour-long cache (`ttl: "1h"`); other providers cache for minutes or not at all. */
const PROVIDER = 'claude-code'
const QUESTION = 'Cache keep-warm check from Ultimate, not from the user. Reply with just: ok'

const read = async (host: ExtensionHost) =>
  (await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)) ?? {}

const ultimateOf = async (host: ExtensionHost) =>
  (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate

/** The user's latest input to @ultimate (ms): typed, or an answer to its questions. Looks back `IDLE_STOP` at most. */
async function userInputAt(host: ExtensionHost, id: ConversationId, now: number) {
  const conversation = await host.harness().conversation(id, context)
  let cursor: Cursor | undefined
  do {
    const page = await conversation!.entries({}, 200, cursor, context)
    for (const entry of page.items) {
      const at = entry.model?.[0]?.timestamp
      if (at !== undefined && now - at > IDLE_STOP) return undefined
      const data = entry.data as { from?: unknown } | undefined
      if (
        (entry.kind === 'pi.user' && entry.input) ||
        (entry.kind === 'board.message' && data?.from === 'user')
      )
        return at
    }
    cursor = page.next
  } while (cursor)
  return undefined
}

/**
 * @ultimate and the times that decide a ping; undefined while it is not on Claude Code. `scan` false skips reading the
 * user's last input while no ping can be due.
 */
async function activity(host: ExtensionHost, doc: WarmDocState, now: number, scan = true) {
  const id = await ultimateOf(host)
  const summary = host.conversations().find((conversation) => conversation.id === id)
  if (id === undefined || !summary) return undefined
  const agent = await (await host.harness().conversation(id, context))!.agent(context)
  if (agent.model?.provider !== PROVIDER) return undefined
  const pinged = doc.last && !doc.last.error ? doc.last.at : undefined
  const lastRequest = Math.max(summary.answerAt ?? 0, pinged ?? 0) || undefined
  return {
    id,
    busy: summary.busy,
    lastRequest,
    failedAfter: doc.last?.error ? doc.last.at : undefined,
    inputAt: scan ? await userInputAt(host, id, now) : undefined,
  }
}

/** One request with @ultimate's next context and the question; what it read and wrote, or why it failed. */
async function ping(host: ExtensionHost, id: ConversationId): Promise<Ping> {
  const at = Date.now()
  const conversation = (await host.harness().conversation(id, context))!
  const agent = await conversation.agent(context)
  const model = host.modelRuntime.getModel(agent.model!.provider, agent.model!.modelId)
  if (!model)
    return { at, error: `${agent.model!.provider}/${agent.model!.modelId} is unavailable` }
  let messages: Message[] = [...(await conversation.context(context)).messages]
  // As conversations' beforeRequest hook sends it (extensions/conversations/server.ts): the identity leads, once.
  const identity = `You are conversation #${id}.`
  if (!messages.some((message) => message.role === 'user' && message.content === identity))
    messages = [{ role: 'user', content: identity, timestamp: 0 }, ...messages]
  messages.push({ role: 'user', content: QUESTION, timestamp: at })
  // No sessionId: a one-shot Claude Code process, so @ultimate's own warm process never sees this turn.
  const answer = await host.modelRuntime
    .streamSimple(
      model,
      { messages },
      {
        ...(agent.thinkingLevel === 'off' ? {} : { reasoning: agent.thinkingLevel }),
        signal: AbortSignal.timeout(180_000),
      },
    )
    .result()
  await host.harness().commit(
    (tx) =>
      host.need(ConversationsApi).accountResponse(tx, id, {
        provider: answer.provider,
        model: answer.model,
        usage: copyJson(answer.usage, {
          omitUndefinedProperties: true,
        }) as ResponseReceipt['usage'],
        text: '',
        stopReason: answer.stopReason,
      }),
    context,
  )
  if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
    return { at, error: answer.errorMessage ?? answer.stopReason }
  return { at, read: answer.usage.cacheRead, write: answer.usage.cacheWrite }
}

async function record(host: ExtensionHost, last: Ping) {
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    doc.last = last
    doc.pings = (doc.pings ?? 0) + 1
  }, context)
}

async function tick(host: ExtensionHost) {
  // Paused, also by a rate limit: no request starts until Play.
  if (host.want(PauseApi)?.paused()) return
  const doc = await read(host)
  if (doc.off) return
  const now = Date.now()
  const quick = await activity(host, doc, now, false)
  if (!quick?.lastRequest || !due({ now, ...quick, inputAt: now })) return
  const found = await activity(host, doc, now)
  // A busy @ultimate renews its own cache.
  if (!found || found.busy || !due({ now, ...found })) return
  // A failure is kept and blocks pings until @ultimate's next request: a limit or an outage is never retried.
  const last = await ping(host, found.id).catch((error: unknown) => ({
    at: now,
    error: error instanceof Error ? error.message : String(error),
  }))
  await record(host, last)
}

async function state(host: ExtensionHost): Promise<WarmState> {
  const doc = await read(host)
  const now = Date.now()
  const found = await activity(host, doc, now)
  const on = !doc.off
  const base = { on, pings: doc.pings ?? 0, ...(doc.last ? { last: doc.last } : {}) }
  if (!found) return base
  const nextAt = found.lastRequest === undefined ? undefined : found.lastRequest + LEAD
  const will = on && nextAt !== undefined && due({ ...found, now: Math.max(now, nextAt) })
  return {
    ...base,
    ...(found.lastRequest === undefined ? {} : { lastRequest: found.lastRequest }),
    ...(found.inputAt === undefined ? {} : { inputAt: found.inputAt }),
    ...(will ? { nextAt } : {}),
  }
}

export default function keepWarm(host: ExtensionHost) {
  // Resolved where they are called; declared here so the catalogue lists them.
  host.need(ConversationsApi)
  host.want(PauseApi)
  const shared = host.resource('keep-warm.timer', () => ({
    running: undefined as Promise<void> | undefined,
  }))
  const timer = setInterval(() => {
    shared.running ??= tick(host)
      .catch((error: unknown) => host.notice(`Keep warm: ${String(error)}`))
      .finally(() => {
        shared.running = undefined
      })
  }, TICK)
  host.onClose(async () => {
    clearInterval(timer)
    await shared.running
  })
  return defineExtension({ name: 'keep-warm' })
}

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => state(host)),
  set: implementAction(SetAction, async (args, { host }) => {
    const on = (args as { on?: unknown } | null)?.on
    if (typeof on !== 'boolean') throw new Error('Expected { on: boolean }')
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
      if (on) delete doc.off
      else doc.off = true
    }, context)
    return state(host)
  }),
}
/** Pings spend the user's plan; only they turn them on or off. */
export const userActions = ['set']
