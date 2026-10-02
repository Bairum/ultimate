import type { JsonValue } from '@earendil-works/chord'
import type {
  CompactResponse,
  ConfigureRequest,
  CreateConversationRequest,
  CreateConversationResponse,
  EmptyResponse,
  ExtensionActionRequest,
  ExtensionActionResponse,
  SubmitRequest,
  SubmitResponse,
  UiUpdateRequest,
} from '../../../shared/protocol.ts'
import type { Store } from './store.ts'

/** The root conversation's id (`ROOT_CONVERSATION_ID` in Pi Durable): Ultimate's one ongoing conversation. */
export const ROOT = 1

/** A failed `api.action()`; one nobody catches becomes a notice. */
export class ActionError extends Error {
  readonly extension: string
  readonly action: string
  /** HTTP status: 404 for an unknown action, 500 when it threw. */
  readonly status: number
  constructor(extension: string, action: string, status: number, message: string) {
    super(message)
    this.name = 'ActionError'
    this.extension = extension
    this.action = action
    this.status = status
  }
}

/** `extension/action: message`, as a notice shows it. */
export const actionMessage = (error: ActionError) =>
  `${error.extension}/${error.action}: ${error.message}`

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Commands as `fetch` POSTs. Conversation commands default to the shown conversation. */
export function createApi(store: Store, options: { base?: string; fetch?: typeof fetch } = {}) {
  const base = options.base ?? ''
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  async function post<T>(
    path: string,
    body: object = {},
    { keepalive = false, signal }: { keepalive?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    const response = await request(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Lets a small request outlive the page, such as an action cancelling work when the tab closes.
      keepalive,
      signal,
    })
    const data: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error =
        data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error
          : `${response.status} ${response.statusText}`
      throw new HttpError(response.status, error)
    }
    return data as T
  }
  const shown = () => {
    const state = store.getState()
    return state.view?.conversation.id ?? state.requested ?? ROOT
  }
  const conversation = (id: number | undefined, action: string) =>
    `/api/conversations/${id ?? shown()}/${action}`

  return {
    submit: (text: string, whenBusy?: SubmitRequest['whenBusy'], id?: number) =>
      post<SubmitResponse>(conversation(id, 'submit'), { text, whenBusy } satisfies SubmitRequest),
    abort: (id?: number) => post<EmptyResponse>(conversation(id, 'abort')),
    cancelSubmission: (submissionId: number, id?: number) =>
      post<EmptyResponse>(conversation(id, `inbox/${submissionId}/cancel`)),
    configure: (change: ConfigureRequest, id?: number) =>
      post<EmptyResponse>(conversation(id, 'configure'), change),
    compact: (instructions?: string, id?: number) =>
      post<CompactResponse>(conversation(id, 'compact'), { instructions }),
    createConversation: (create: CreateConversationRequest = {}) =>
      post<CreateConversationResponse>('/api/conversations', create),
    restart: () => post<unknown>('/api/restart'),
    /**
     * Call action `name` of `extension`'s server facet (`export const actions` in its `server.ts`) with JSON `args`,
     * on behalf of the shown conversation, and resolve with its result. Rejects with an `ActionError`; one you do not
     * catch shows as a notice. Aborting `signal` aborts the action's processes too; `keepalive` lets the call outlive
     * the page, such as one sent on `pagehide`.
     */
    action: async <T = JsonValue>(
      extension: string,
      name: string,
      args: JsonValue = null,
      {
        conversationId,
        signal,
        keepalive,
      }: { conversationId?: number; signal?: AbortSignal; keepalive?: boolean } = {},
    ): Promise<T> => {
      const path = `/api/extensions/${encodeURIComponent(extension)}/actions/${encodeURIComponent(name)}`
      const body: ExtensionActionRequest = { args, conversationId: conversationId ?? shown() }
      try {
        const { result } = await post<ExtensionActionResponse>(path, body, { signal, keepalive })
        return result as T
      } catch (error) {
        if (signal?.aborted) throw error
        throw new ActionError(
          extension,
          name,
          error instanceof HttpError ? error.status : 0,
          error instanceof Error ? error.message : String(error),
        )
      }
    },
    /** Write durable UI state; prefer `useUiState`, which batches and applies writes at once. */
    updateUi: (change: UiUpdateRequest) => post<EmptyResponse>('/api/ui', change),
  }
}
export type Api = ReturnType<typeof createApi>
