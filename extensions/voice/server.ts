import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { MAX_AUDIO_BYTES, StatusAction, TranscribeAction } from './refs.ts'

/** The provider whose login transcribes: the ChatGPT subscription that runs the Codex models. */
const PROVIDER = 'openai-codex'
const NO_LOGIN = 'Voice needs a ChatGPT login: ⌘K → Log in to a provider'
const TIMEOUT_MS = 65_000

type VoiceHost = Pick<ExtensionHost, 'modelRuntime'>

/** The ChatGPT login's account, read from its access token's claims the way pi-ai's Codex provider does. */
function accountId(token: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const id: unknown = claims?.['https://api.openai.com/auth']?.chatgpt_account_id
    return typeof id === 'string' && id ? id : undefined
  } catch {
    // Not a JWT: no account to send, which the caller reports as a missing login.
    return undefined
  }
}

/**
 * ChatGPT's own transcription endpoint, as the ChatGPT apps and bb (getbb) call it. It is undocumented and may change;
 * this function is the one place that knows its URL, headers, form fields and answer.
 */
export async function chatgptTranscribe(
  credentials: { token: string; account: string },
  audio: Blob,
  signal: AbortSignal,
): Promise<{ status: number; text?: string; detail?: string }> {
  const form = new FormData()
  const extension = audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm'
  form.set('file', audio, `recording.${extension}`)
  form.set('model', 'gpt-transcribe')
  const response = await fetch('https://chatgpt.com/backend-api/transcribe', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'chatgpt-account-id': credentials.account,
      originator: 'pi',
      'User-Agent': 'ultimate',
    },
    body: form,
    signal,
  })
  const body = await response.text()
  if (!response.ok) return { status: response.status, detail: body.slice(0, 300) }
  try {
    const text: unknown = JSON.parse(body)?.text
    return typeof text === 'string'
      ? { status: response.status, text }
      : { status: 502, detail: 'no text in the answer' }
  } catch {
    // An HTML or truncated page instead of JSON: the endpoint changed or a proxy answered.
    return { status: 502, detail: 'the answer was not JSON' }
  }
}

/** The access token and account of Pi's `openai-codex` login, refreshed by Pi when needed; never logged or returned. */
async function credentials(host: VoiceHost, signal: AbortSignal) {
  if (!host.modelRuntime.getProviderAuthStatus(PROVIDER).configured) throw new Error(NO_LOGIN)
  const token = (await host.modelRuntime.getAuth(PROVIDER, { signal }))?.auth.apiKey
  const account = token && accountId(token)
  if (!token || !account) throw new Error(NO_LOGIN)
  return { token, account }
}

/** What the composer shows for a failed transcription, by the endpoint's HTTP status. */
function failure(status: number, detail: string | undefined) {
  if (status === 401 || status === 403)
    return 'ChatGPT rejected the login: log in again with ⌘K → Log in to a provider'
  if (status === 413) return 'The recording is too large to transcribe'
  if (status === 429) return 'ChatGPT is rate-limiting transcription: try again in a minute'
  return `Transcription failed (HTTP ${status})${detail ? `: ${detail}` : ''}`
}

export default defineExtension({ name: 'voice' })

export const actions = {
  /** `{ available }`, or `{ available: false, reason }` without an `openai-codex` login. */
  status: implementAction(StatusAction, (_args, { host }) =>
    host.modelRuntime.getProviderAuthStatus(PROVIDER).configured
      ? { available: true as const }
      : { available: false as const, reason: NO_LOGIN },
  ),
  /** `{ audio, mimeType }`: base64 audio as the browser recorded it (`audio/mp4` on iOS, `audio/webm` elsewhere). */
  transcribe: implementAction(TranscribeAction, async (args, { host, signal }) => {
    const { audio, mimeType } = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof audio !== 'string' || !audio || typeof mimeType !== 'string' || !mimeType)
      throw new Error('Expected { audio: base64, mimeType }')
    const bytes = Buffer.from(audio, 'base64')
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error(failure(413, undefined))
    const login = await credentials(host, signal)
    const answer = await chatgptTranscribe(
      login,
      new Blob([bytes], { type: mimeType }),
      AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    ).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new Error('Transcription timed out: try a shorter recording')
      throw new Error(`Transcription failed: ${error instanceof Error ? error.message : error}`)
    })
    if (answer.text === undefined) throw new Error(failure(answer.status, answer.detail))
    return { text: answer.text.trim() }
  }),
}
