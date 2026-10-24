/** Voice input in the browser: whether a ChatGPT login can transcribe, and the transcription action. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** Whether voice input works: `available` with an `openai-codex` (ChatGPT) login, else `reason` says what to do. */
export type VoiceStatus = { available: true } | { available: false; reason: string }

/** The largest recording `transcribe` takes, in bytes before base64: what fits the 12 MB action request. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024

/** No arguments → whether a ChatGPT login exists to transcribe with. */
export const StatusAction = actionRef<null, VoiceStatus>('voice', 'status')
/** `{ audio: base64, mimeType }` → the transcribed text. Fails with a message the composer shows as is. */
export const TranscribeAction = actionRef<{ audio: string; mimeType: string }, { text: string }>(
  'voice',
  'transcribe',
)
