/**
 * Keep warm: Claude's one-hour prompt cache expires while @ultimate idles or a coordinator waits on a child or the
 * lander. Shortly before that hour ends, one request replays the conversation's context as its next request would
 * send it, plus a one-word question. It reads the whole prefix from the cache, which renews the hour, and leaves
 * nothing in any transcript; its tokens count toward that conversation's usage.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { copyJson } from '@earendil-works/chord'
import {
  defineDoc,
  defineExtension,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor } from '@earendil-works/pi-durable'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { PauseApi } from '../pause/api.ts'
import { Profile, Standing, Subagents } from '../subagents/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { ContextHygiene, Ledger } from '../context-hygiene/api.ts'
import { due, eligible, LEAD, TTL } from './due.ts'
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
const providers = ['claude-code', 'anthropic']
const QUESTION = 'Cache keep-warm check from Ultimate, not from the user. Reply with just: ok'

const read = async (host: ExtensionHost) =>
  (await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)) ?? {}

const ultimateOf = async (host: ExtensionHost) =>
  (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate

/** A response that read or wrote `model`'s cache: an answer that came back, with cache tokens. */
export const cached = (message: AssistantMessage, model: string) =>
  providers.includes(message.provider) &&
  message.model === model &&
  message.stopReason !== 'error' &&
  message.stopReason !== 'aborted' &&
  message.usage.cacheRead + message.usage.cacheWrite > 0

/**
 * When the conversation's own requests last renewed `model`'s cache (ms), and the context it cached (tokens): its newest
 * such response within the hour. A failed response or one of another model renews nothing, so it does not count.
 */
async function answeredAt(
  host: ExtensionHost,
  id: ConversationId,
  provider: string,
  model: string,
  now: number,
) {
  const conversation = (await host.harness().conversation(id, context))!
  let cursor: Cursor | undefined
  do {
    const page = await conversation.entries({}, 100, cursor, context)
    for (const entry of page.items) {
      const message = entry.model?.[0]
      if (message?.role !== 'assistant') continue
      if (now - message.timestamp >= TTL) return undefined
      if (message.provider === provider && cached(message, model)) {
        const { input, cacheRead, cacheWrite } = message.usage
        return { at: message.timestamp, tokens: input + cacheRead + cacheWrite }
      }
    }
    cursor = page.next
  } while (cursor)
  return undefined
}

/** Snapshot the eligibility signals; claim rechecks them transactionally before sending. */
async function target(
  host: ExtensionHost,
  id: ConversationId,
  standing: boolean,
  definition: string | undefined,
  queued: ReadonlySet<ConversationId>,
) {
  const harness = host.harness()
  const running = (await harness.snapshot(LiveDoc, id, context))?.run !== undefined
  let child = false
  if (!standing && !running && !queued.has(id))
    for (const agent of Object.values(
      (await harness.snapshot(Subagents, id, context))?.agents ?? {},
    ))
      if ((await harness.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined) {
        child = true
        break
      }
  return { standing, definition, running, child, submission: queued.has(id) }
}

/**
 * Current targets: @ultimate and the coordinators waiting on a child or the lander. Cheap signals first; the model
 * and the history paging only for a target that can be pinged, so the minute's scan stays small and the chip lists
 * only conversations that are warmed now.
 */
async function activity(host: ExtensionHost, doc: WarmDocState, now: number) {
  const found = []
  const harness = host.harness()
  const ultimate = await ultimateOf(host)
  const index = await harness.snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, context)
  const queued = new Set(
    (index?.queue ?? []).map((entry) => entry.conversationId as ConversationId),
  )
  for (const summary of host.conversations()) {
    const id = summary.id as ConversationId
    const standing = id === ultimate
    // Branches record the coordinator in metadata; configured children use Profile (as fast does).
    const definition = (await harness.snapshot(Profile, id, context))?.definition ?? summary.label
    if (!standing && definition !== 'coordinator') continue
    const signals = await target(host, id, standing, definition, queued)
    if (!standing && (signals.running || (!signals.child && !signals.submission))) continue
    const conversation = await harness.conversation(id, context)
    if (!conversation) continue
    const model = (await conversation.agent(context)).model
    if (!model || !providers.includes(model.provider)) continue
    const answered = await answeredAt(host, id, model.provider, model.modelId, now)
    const previous = doc.conversations?.[id]
    const last =
      previous?.provider === model.provider && previous.model === model.modelId
        ? previous
        : undefined
    const pinged = last && !last.error && (last.read ?? 0) + (last.write ?? 0) > 0 ? last.at : 0
    // The newer of the answer and the ping tells how much context the cache holds.
    const tokens =
      pinged > (answered?.at ?? 0) ? (last!.read ?? 0) + (last!.write ?? 0) : answered?.tokens
    found.push({
      ...signals,
      id,
      title: standing ? '@ultimate' : summary.title || `#${id}`,
      provider: model.provider,
      model: model.modelId,
      lastRequest: Math.max(answered?.at ?? 0, pinged) || undefined,
      tokens,
      failedAfter: previous?.error ? previous.at : undefined,
      pingAt: previous?.at,
      inputAt: doc.inputAt,
      paused: host.want(PauseApi)?.paused(),
    })
  }
  return found
}

/** Not paused (also by a rate limit) and the cache still within its hour; synchronous, so nothing slips in after it. */
export const open = (paused: boolean | undefined, lastRequest: number, now: number) =>
  !paused && now - lastRequest < TTL

/**
 * In one commit: record the attempt as interrupted, only while it is still on, the target has no run and no other
 * attempt was recorded since the tick read `previous`. A crash mid-request then counts as a failure, never a retry.
 */
async function claim(host: ExtensionHost, id: ConversationId, attempt: Ping, previous?: number) {
  return host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    const previousPing = doc.conversations?.[id]
    if (
      doc.off ||
      previousPing?.at !== previous ||
      (previousPing && attempt.at - previousPing.at < LEAD) ||
      (await tx.doc(LiveDoc, id)).run !== undefined
    )
      return false
    const standing = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate === id
    if (!standing) {
      const definition =
        (await tx.doc(Profile, id)).definition ?? (await tx.doc(host.metadata, id)).label
      if (definition !== 'coordinator') return false
      const children = await tx.doc(Subagents, id)
      let child = false
      for (const agent of Object.values(children.agents))
        if ((await tx.doc(LiveDoc, agent.conversationId)).run !== undefined) child = true
      const index = await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)
      if (!child && !index.queue.some((entry) => entry.conversationId === id)) return false
    }
    ;(doc.conversations ??= {})[id] = attempt
    doc.pings = (doc.pings ?? 0) + 1
    return true
  }, context)
}

/** Store the attempt's outcome and usage on the pinged conversation in one commit. */
async function record(
  host: ExtensionHost,
  id: ConversationId,
  last: Ping,
  answer?: AssistantMessage,
) {
  await host.harness().commit(async (tx) => {
    ;((await tx.doc(State, ROOT_CONVERSATION_ID)).conversations ??= {})[id] = last
    if (answer)
      await host.need(ConversationsApi).accountResponse(tx, id, {
        provider: answer.provider,
        model: answer.model,
        usage: copyJson(answer.usage, {
          omitUndefinedProperties: true,
        }) as ResponseReceipt['usage'],
        text: '',
        stopReason: answer.stopReason,
      })
  }, context)
}

/**
 * One request with the target's next context and the question, unless something changed while it was prepared. It is
 * recorded as interrupted before it is sent, so a crash never leads to a second try.
 */
export async function ping(
  host: ExtensionHost,
  found: {
    id: ConversationId
    provider: string
    model: string
    lastRequest: number
    previous?: number
  },
) {
  const paused = () => host.want(PauseApi)?.paused()
  const { id } = found
  const conversation = (await host.harness().conversation(id, context))!
  const agent = await conversation.agent(context)
  const model = host.modelRuntime.getModel(found.provider, found.model)
  if (!model) return
  let messages: Message[] = [...(await conversation.context(context)).messages]
  const hygiene = host.want(ContextHygiene)
  if (hygiene) {
    const ledger = await host.harness().snapshot(Ledger, id, context)
    const applied = Object.fromEntries(
      Object.entries(ledger?.decisions ?? {}).filter(
        ([, decision]) => decision.state === 'applied',
      ),
    )
    messages = [...hygiene.rewrite(messages, applied)]
  }
  // As conversations' beforeRequest hook sends it (extensions/conversations/server.ts): the identity leads, once.
  const identity = `You are conversation #${id}.`
  if (!messages.some((message) => message.role === 'user' && message.content === identity))
    messages = [{ role: 'user', content: identity, timestamp: 0 }, ...messages]
  const at = Date.now()
  const attempt = { at, provider: found.provider, model: found.model }
  messages.push({ role: 'user', content: QUESTION, timestamp: at })
  // Preparing awaited: a pause, a new run or the switch may have come in meanwhile. The claim checks the switch and the
  // run in its commit; pause and the hour are checked again after it, with nothing awaited before the request starts.
  if (!open(paused(), found.lastRequest, Date.now())) return
  if (!(await claim(host, id, { ...attempt, error: 'interrupted' }, found.previous))) return
  if (!open(paused(), found.lastRequest, Date.now())) {
    await record(host, id, { ...attempt, error: 'skipped: paused or expired' })
    return
  }
  let answer: AssistantMessage
  try {
    // No sessionId: Claude Code uses a one-shot process, leaving the target's own warm process untouched.
    answer = await host.modelRuntime
      .streamSimple(
        model,
        { messages },
        {
          cacheRetention: 'long',
          ...(agent.thinkingLevel === 'off' ? {} : { reasoning: agent.thinkingLevel }),
          signal: AbortSignal.timeout(180_000),
        },
      )
      .result()
  } catch (error) {
    // A failure blocks this conversation until its next real request; never retry an outage in a loop.
    await record(host, id, {
      ...attempt,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }
  const failed = answer.stopReason === 'error' || answer.stopReason === 'aborted'
  await record(
    host,
    id,
    failed
      ? { ...attempt, error: answer.errorMessage ?? answer.stopReason }
      : { ...attempt, read: answer.usage.cacheRead, write: answer.usage.cacheWrite },
    answer,
  )
}

async function tick(host: ExtensionHost) {
  // Paused, also by a rate limit: no request starts until Play.
  if (host.want(PauseApi)?.paused()) return
  const doc = await read(host)
  if (doc.off) return
  const now = Date.now()
  for (const found of await activity(host, doc, now)) {
    if (!found.lastRequest || !due({ now: Date.now(), ...found })) continue
    await ping(host, {
      ...found,
      lastRequest: found.lastRequest,
      previous: doc.conversations?.[found.id]?.at,
    })
  }
}

async function state(host: ExtensionHost): Promise<WarmState> {
  const doc = await read(host)
  const now = Date.now()
  const found = await activity(host, doc, now)
  const on = !doc.off
  return {
    on,
    pings: doc.pings ?? 0,
    ...(doc.inputAt === undefined ? {} : { inputAt: doc.inputAt }),
    conversations: found
      .filter((item) => eligible(item) || doc.conversations?.[item.id])
      .map((item) => {
        const nextAt =
          item.lastRequest === undefined
            ? undefined
            : Math.max(item.lastRequest + LEAD, (item.pingAt ?? 0) + LEAD)
        const will = on && nextAt !== undefined && due({ ...item, now: Math.max(now, nextAt) })
        return {
          id: item.id,
          title: item.title,
          ...(item.lastRequest === undefined ? {} : { lastRequest: item.lastRequest }),
          ...(will ? { nextAt } : {}),
          ...(doc.conversations?.[item.id] ? { last: doc.conversations[item.id] } : {}),
        }
      }),
  }
}

export default function keepWarm(host: ExtensionHost) {
  // Resolved where they are called; declared here so the catalogue lists them.
  host.need(ConversationsApi)
  host.want(PauseApi)
  host.need(WorkspacesApi)
  host.want(ContextHygiene)
  // The user's latest input to @ultimate: typed, or an answer to its question.
  host.react(
    'user-input',
    [UserInputEvent],
    async (tx, { data, at }) => {
      if ((await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate !== data.conversation) return
      ;(await tx.doc(State, ROOT_CONVERSATION_ID)).inputAt = Date.parse(at)
    },
    { from: 'now' },
  )
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
