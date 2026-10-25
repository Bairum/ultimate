/** Live voice actions and the standing Voice conversation. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

export type VoiceStatus = { available: true } | { available: false; reason: string }
export type VoiceState = { conversation?: number }
export type VoiceSession = { phase: 'started' | 'ended'; at: number; seconds?: number }
export type VoiceLine = {
  role: 'daniel' | 'ultimate'
  text: string
  delegation?: string
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
/** A finished utterance → its Daniel voice.line entry id. The answer arrives as another voice.line. */
export const SayAction = actionRef<{ text: string; delegation?: string }, { line: number }>(
  'voice-live',
  'say',
)
/** Record the ended divider after closing the data-channel session. */
export const EndAction = actionRef<{ seconds?: number }, Record<string, never>>('voice-live', 'end')
