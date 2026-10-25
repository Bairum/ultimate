/** Live voice actions and the standing Voice conversation. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

export type VoiceStatus = { available: true } | { available: false; reason: string }
export type VoiceSession = {
  phase: 'started' | 'ended'
  at: number
  seconds?: number
}
/**
 * One line of the Voice transcript. `user`: the cleaned request forwarded to @ultimate;
 * `live`: GPT-Live's backchannels; `ultimate`: Voice's speech, `re` the forwarded line it answers;
 * `notice`: an unanswered request; `note`: quiet context sent to GPT-Live. `at`: when a forwarded line went out.
 */
export type VoiceLine = {
  role: 'user' | 'live' | 'ultimate' | 'notice' | 'note'
  text: string
  forwarded?: true
  at?: number
  re?: number
  source?: { conversation: number; entry: number }
  speech?: true
}
export type VoiceUtterance = { text: string; line: number }
/** @ultimate's full answer to forwarded line `re`, as Voice received it; `source` is the answer in @ultimate. */
export type VoiceAnswer = {
  text: string
  re: number
  source?: { conversation: number; entry: number }
}

/** No arguments → API key availability, or a reason explaining how to enable it. */
export const StatusAction = actionRef<null, VoiceStatus>('voice-live', 'status')
/** `{ sdp }` offer → `{ sdp, conversation }` answer; creates a billable WebRTC session. */
export const StartAction = actionRef<{ sdp: string }, { sdp: string; conversation: number }>(
  'voice-live',
  'start',
)
/** A finished user transcript → input to the Voice agent, steering while busy. */
export const HeardAction = actionRef<{ text: string }, Record<string, never>>('voice-live', 'heard')
/** GPT-Live's own line or a notice. The user's lines use heard instead. */
export const LogAction = actionRef<{ role: 'live' | 'notice'; text: string }, { line: number }>(
  'voice-live',
  'log',
)
/** Record the ended divider after closing the data-channel session. */
export const EndAction = actionRef<{ seconds?: number }, Record<string, never>>('voice-live', 'end')
