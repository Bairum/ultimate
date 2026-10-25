/** Live voice actions and the standing Voice conversation. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

export type VoiceStatus = { available: true } | { available: false; reason: string }
export type VoiceState = { conversation?: number }
export type VoiceSession = { phase: 'started' | 'ended'; at: number; seconds?: number }
/**
 * One line of the Voice transcript. `daniel`: what he said, `forwarded` when it is the request passed to @ultimate;
 * `live`: GPT-Live's own speech (small talk, clarifying); `ultimate`: an answer read out, `re` the forwarded line it
 * answers; `notice`: the relay's own word (nothing was sent, @ultimate did not answer).
 */
export type VoiceLine = {
  role: 'daniel' | 'live' | 'ultimate' | 'notice'
  text: string
  delegation?: string
  forwarded?: true
  re?: number
  source?: { conversation: number; entry: number }
  speech?: true
}
export type VoiceUtterance = { text: string; line: number }

/** On root (conversation 1): the ownerless Voice conversation, created by start. */
export const VoiceDoc = docRef<VoiceState>('voice-live')
/** No arguments → API key availability, or a reason explaining how to enable it. */
export const StatusAction = actionRef<null, VoiceStatus>('voice-live', 'status')
/** `{ sdp }` offer → `{ sdp, conversation }` answer; creates a billable WebRTC session. */
export const StartAction = actionRef<{ sdp: string }, { sdp: string; conversation: number }>(
  'voice-live',
  'start',
)
/** A confirmed request → its forwarded Daniel voice.line entry id. The answer arrives as another voice.line. */
export const SayAction = actionRef<{ text: string; delegation?: string }, { line: number }>(
  'voice-live',
  'say',
)
/** A line that stays in Voice: Daniel's talk, GPT-Live's own, or a relay notice. Never reaches @ultimate. */
export const LogAction = actionRef<
  { role: 'daniel' | 'live' | 'notice'; text: string },
  { line: number }
>('voice-live', 'log')
/** Record the ended divider after closing the data-channel session. */
export const EndAction = actionRef<{ seconds?: number }, Record<string, never>>('voice-live', 'end')
