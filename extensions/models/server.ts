import { randomUUID } from 'node:crypto'
import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

/** A Pi type as a document holds it: plain JSON, arrays mutable. */
type Json<T> = T extends readonly (infer U)[]
  ? Json<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Json<T[K]> }
    : T
type WirePrompt<T> = T extends AuthPrompt ? Omit<T, 'signal'> : never
/** One login flow as the browser sees it. Answers and credentials never enter it. */
export type LoginFlow = {
  provider: string
  type: AuthType
  status: 'running' | 'complete' | 'cancel' | 'error'
  /** The prompt waiting for an answer. */
  prompt?: Json<WirePrompt<AuthPrompt>>
  events: Json<AuthEvent>[]
  error?: string
}
/** The login flows started from a conversation, by flow id; the login dialog streams it with `useDoc`. */
export const Logins = defineDoc<{ flows: Record<string, LoginFlow> }>({
  kind: 'models.login',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ flows: {} }),
})
export const docs = [Logins]

/** A running flow: process-local, so a flow the document shows running without one here died with its process. */
interface Flow {
  controller: AbortController
  answer?: (value: string) => void
  /** Document changes, applied in order. */
  writes: Promise<void>
}
/** Finished flows a conversation's document keeps. */
const kept = 10

function liveFlows(host: ExtensionHost) {
  return host.resource('models.login', () => {
    const live = new Map<string, Flow>()
    host.onOpen(async () => {
      const harness = host.harness()
      const ids: ConversationId[] = []
      let cursor: Cursor | undefined
      do {
        const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context)
        ids.push(...page.items.map((record) => record.id))
        cursor = page.next
      } while (cursor !== undefined)
      for (const id of ids) {
        const dead = (records: Readonly<Record<string, LoginFlow>>) =>
          Object.keys(records).filter(
            (flowId) => records[flowId].status === 'running' && !live.has(flowId),
          )
        if (!dead((await harness.snapshot(Logins, id, context))?.flows ?? {}).length) continue
        await harness.commit(async (tx) => {
          const { flows } = await tx.doc(Logins, id)
          for (const flowId of dead(flows)) {
            flows[flowId].status = 'cancel'
            delete flows[flowId].prompt
          }
        }, context)
      }
    })
    host.onClose(async () => {
      for (const flow of live.values()) flow.controller.abort()
    })
    return live
  })
}

const field = (args: JsonValue, name: string) =>
  args && typeof args === 'object' && !Array.isArray(args) ? args[name] : undefined
function text(args: JsonValue, name: string) {
  const value = field(args, name)
  if (typeof value !== 'string' || !value) throw new Error(`Expected ${name}`)
  return value
}
function running(host: ExtensionHost, args: JsonValue) {
  const flow = liveFlows(host).get(text(args, 'flowId'))
  if (!flow) throw new Error('Unknown login flow')
  return flow
}
/** Prompts and events as plain JSON: a document holds no `undefined`. */
const json = <T>(value: T): Json<T> => JSON.parse(JSON.stringify(value))

export const userActions = ['login', 'answer', 'cancel', 'logout']

export const actions = {
  /** Start a login flow for the calling conversation and resolve with its id; the document shows its progress. */
  async login(args: JsonValue, { host, conversationId }: ActionContext) {
    const provider = text(args, 'provider')
    const type = field(args, 'type')
    if (type !== 'api_key' && type !== 'oauth') throw new Error('Invalid auth type')
    if (
      !host.modelRuntime.getProvider(provider)?.auth[type === 'oauth' ? 'oauth' : 'apiKey']?.login
    )
      throw new Error('Unsupported provider or login type')
    const live = liveFlows(host)
    const harness = host.harness()
    const id = (conversationId ?? ROOT_CONVERSATION_ID) as ConversationId
    const flowId = randomUUID()
    await harness.commit(async (tx) => {
      if (!(await tx.conversation(id))) throw new Error('Unknown conversation')
      const { flows } = await tx.doc(Logins, id)
      const finished = Object.keys(flows).filter((key) => flows[key].status !== 'running')
      for (const key of finished.slice(0, -kept)) delete flows[key]
      flows[flowId] = { provider, type, status: 'running', events: [] }
    }, context)
    const flow: Flow = { controller: new AbortController(), writes: Promise.resolve() }
    const update = (change: (state: LoginFlow) => void) => {
      flow.writes = flow.writes
        .then(() =>
          host.harness().commit(async (tx) => {
            const state = (await tx.doc(Logins, id)).flows[flowId]
            if (state) change(state)
          }, context),
        )
        // The harness closes only with the process; the next start marks the flow cancelled.
        .catch((error: unknown) => console.error('models: login document not updated:', error))
      return flow.writes
    }
    live.set(flowId, flow)
    const { signal } = flow.controller
    void host.modelRuntime
      .login(provider, type, {
        signal,
        prompt: (prompt: AuthPrompt) =>
          new Promise<string>((resolve, reject) => {
            const signals = [signal, prompt.signal].filter((item): item is AbortSignal => !!item)
            const cleanup = () => {
              for (const item of signals) item.removeEventListener('abort', abort)
              delete flow.answer
              void update((state) => delete state.prompt)
            }
            const abort = () => {
              cleanup()
              reject(new Error('Login cancelled'))
            }
            flow.answer = (value) => {
              cleanup()
              resolve(value)
            }
            for (const item of signals) {
              if (item.aborted) {
                abort()
                return
              }
              item.addEventListener('abort', abort, { once: true })
            }
            const { signal: _signal, ...wire } = prompt
            void update((state) => {
              state.prompt = json(wire)
            })
          }),
        notify: (event) => void update((state) => state.events.push(json(event))),
      })
      .then(
        () => (signal.aborted ? 'cancel' : 'complete'),
        // Provider errors may include secrets or callback codes; never forward them.
        () => (signal.aborted ? 'cancel' : 'error'),
      )
      .then((status) => {
        live.delete(flowId)
        return update((state) => {
          state.status = status
          delete state.prompt
          if (status === 'error') state.error = 'Login failed'
        })
      })
    return { flowId }
  },
  /** Answer the flow's pending prompt; an empty answer is allowed. */
  async answer(args: JsonValue, { host }: ActionContext) {
    const flow = running(host, args)
    const value = field(args, 'value')
    if (typeof value !== 'string') throw new Error('Expected value')
    if (!flow.answer) throw new Error('No pending prompt for flow')
    flow.answer(value)
    // The prompt leaves the document before the UI hears back.
    await flow.writes
    return null
  },
  async cancel(args: JsonValue, { host }: ActionContext) {
    running(host, args).controller.abort()
    return null
  },
  /** Remove the provider's stored credential, which pi shares. */
  async logout(args: JsonValue, { host }: ActionContext) {
    await host.modelRuntime.logout(text(args, 'provider'))
    return null
  },
}

export default function models(host: ExtensionHost) {
  // At load, so the next start marks flows of the previous process cancelled.
  liveFlows(host)
  return defineExtension({ name: 'models' })
}
