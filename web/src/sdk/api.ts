import type {
  CompactResponse,
  ConfigureRequest,
  CreateConversationRequest,
  CreateConversationResponse,
  EmptyResponse,
  HistoryResponse,
  ExtensionActionRequest,
  ExtensionActionResponse,
  SubmitRequest,
  SubmitResponse,
  UiUpdateRequest,
  UiUpdateResponse,
} from '../../../shared/protocol.ts'
import type { ActionRef } from '../../../shared/extension-api.ts'
import { errorMessage } from './format.ts'
import { refusedForPairing } from './pairing.ts'
import type { Whoami } from './pairing.ts'
import type { Store } from './store.ts'

/** Per-call options of `api.action`. */
export type ActionOptions = { conversationId?: number; signal?: AbortSignal; keepalive?: boolean }

/** How a call passes an action's arguments: optional when the action takes `null`, required otherwise. */
export type ActionArgs<Args, Options> = null extends Args
  ? [args?: Args, options?: Options]
  : [args: Args, options?: Options]

/** The root conversation's id (`ROOT_CONVERSATION_ID` in Pi Durable): Ultimate's one ongoing conversation. */
export const ROOT = 1

const maxUploadBytes = 50 * 1024 * 1024

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

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Commands as `fetch` POSTs. Conversation commands default to the shown conversation. `onRefused` hears of every call
 * the server refused because this browser is not paired.
 */
export function createApi(
  store: Store,
  options: { fetch?: typeof fetch; onRefused?: () => void } = {},
) {
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  async function post<T>(
    path: string,
    body: object = {},
    { keepalive = false, signal }: { keepalive?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    const response = await request(path, {
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
      const failure = new HttpError(response.status, error)
      if (refusedForPairing(failure)) options.onRefused?.()
      throw failure
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
    /** Saves a dropped file under the project home and returns its path. */
    upload: async (id: number | undefined, file: File): Promise<string> => {
      if (file.size > maxUploadBytes) throw new HttpError(413, 'File exceeds 50 MiB')
      const response = await request(
        `${conversation(id, 'upload')}?${new URLSearchParams({ name: file.name })}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
      )
      const data = (await response.json().catch(() => ({}))) as { path?: string; error?: string }
      if (!response.ok || !data.path)
        throw new HttpError(
          response.status,
          data.error ?? `${response.status} ${response.statusText}`,
        )
      return data.path
    },
    submit: (
      text: string,
      whenBusy?: SubmitRequest['whenBusy'],
      id?: number,
      images?: SubmitRequest['images'],
    ) =>
      post<SubmitResponse>(conversation(id, 'submit'), {
        text,
        whenBusy,
        images,
      } satisfies SubmitRequest),
    /** Stored entries of `id` below `before`, newest first; with `after`, only those from `after` on, in larger pages. */
    history: async (
      id: number,
      before: number,
      signal?: AbortSignal,
      after?: number,
    ): Promise<HistoryResponse> => {
      const query = new URLSearchParams({ before: String(before) })
      if (after !== undefined) query.set('after', String(after))
      const response = await request(conversation(id, `history?${query}`), { signal })
      const data = await response.json()
      if (!response.ok) throw new HttpError(response.status, data.error ?? 'Could not load history')
      return data as HistoryResponse
    },
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
    /** Whether this browser is paired (`host`) and may act as the user (`user`). */
    whoami: async (): Promise<Whoami> => {
      const response = await request('/api/whoami')
      if (!response.ok) throw new HttpError(response.status, 'Could not read pairing')
      return (await response.json()) as Whoami
    },
    /** Ask the server to open a pairing link in this machine's browser; 429 within 10 s, 403 from another device. */
    pair: () => post<{ ok: true }>('/api/pair'),
    /** A single-use link that pairs another device within 10 minutes, at `origin` (default: this server's). */
    pairLink: (origin?: string) => post<{ url: string }>('/api/pair/link', { origin }),
    /**
     * Call the action `ref` names (`export const actions` in its extension's `server.ts`, typed in its `refs.ts`)
     * with JSON `args`, on behalf of the shown conversation, and resolve with its result. Rejects
     * with `ActionError`; an uncaught rejection shows as a notice. Aborting `signal` aborts the action's processes too; `keepalive` lets the call outlive the page, such as
     * one sent on `pagehide`.
     */
    action: async <Args, Result>(
      ref: ActionRef<Args, Result>,
      ...[args, call = {}]: ActionArgs<Args, ActionOptions>
    ): Promise<Result> => {
      const { extension, name } = ref
      const { conversationId, signal, keepalive } = call
      const path = `/api/extensions/${encodeURIComponent(extension)}/actions/${encodeURIComponent(name)}`
      const body: ExtensionActionRequest = {
        args: args ?? null,
        conversationId: conversationId ?? shown(),
      }
      try {
        const { result } = await post<ExtensionActionResponse>(path, body, { signal, keepalive })
        return result as Result
      } catch (error) {
        if (signal?.aborted) throw error
        throw new ActionError(
          extension,
          name,
          error instanceof HttpError ? error.status : 0,
          errorMessage(error),
        )
      }
    },
    /** Write durable UI state; prefer `useUiState`, which batches and applies writes at once. */
    updateUi: (change: UiUpdateRequest) => post<UiUpdateResponse>('/api/ui', change),
  }
}
export type Api = ReturnType<typeof createApi>
