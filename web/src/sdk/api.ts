import type { AuthType } from '@earendil-works/pi-ai'
import type {
  CompactResponse,
  ConfigureRequest,
  CreateConversationRequest,
  CreateConversationResponse,
  EmptyResponse,
  LoginResponse,
  SubmitRequest,
  SubmitResponse,
  UiUpdateRequest,
} from '../../../shared/protocol.ts'
import type { Store } from './store.ts'

/** The root conversation's id (`ROOT_CONVERSATION_ID` in Pi Durable). */
const ROOT = 1

/** Commands as `fetch` POSTs. Conversation commands default to the shown conversation. */
export function createApi(store: Store, options: { base?: string; fetch?: typeof fetch } = {}) {
  const base = options.base ?? ''
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  async function post<T>(path: string, body: object = {}): Promise<T> {
    const response = await request(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error =
        data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error
          : `${response.status} ${response.statusText}`
      throw new Error(error)
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
    configure: (change: ConfigureRequest, id?: number) =>
      post<EmptyResponse>(conversation(id, 'configure'), change),
    compact: (instructions?: string, id?: number) =>
      post<CompactResponse>(conversation(id, 'compact'), { instructions }),
    createConversation: (create: CreateConversationRequest = {}) =>
      post<CreateConversationResponse>('/api/conversations', create),
    login: (provider: string, type: AuthType) =>
      post<LoginResponse>('/api/auth/login', { provider, type }),
    answer: async (flowId: string, value: string) => {
      store.clearAuthPrompt(flowId)
      return post<EmptyResponse>(`/api/auth/flows/${encodeURIComponent(flowId)}/answer`, { value })
    },
    cancel: (flowId: string) =>
      post<EmptyResponse>(`/api/auth/flows/${encodeURIComponent(flowId)}/cancel`),
    logout: (provider: string) => post<EmptyResponse>('/api/auth/logout', { provider }),
    restart: () => post<unknown>('/api/restart'),
    /** Write durable UI state; prefer `useUiState`, which batches and applies writes at once. */
    updateUi: (change: UiUpdateRequest) => post<EmptyResponse>('/api/ui', change),
  }
}
export type Api = ReturnType<typeof createApi>
