/** Keep-warm settings and per-conversation cache status. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** Claimed as interrupted before sending, so a crash counts as a failure. */
export type Ping = {
  at: number
  provider: string
  model: string
  read?: number
  write?: number
  error?: string
}

/** On conversation 1; inputAt is the latest user input to @ultimate. Old `last` fields are ignored. */
export type WarmDocState = {
  off?: true
  inputAt?: number
  conversations?: Record<string, Ping>
  pings?: number
}

export type WarmConversation = {
  id: number
  title: string
  lastRequest?: number
  nextAt?: number
  last?: Ping
}
export type WarmState = {
  on: boolean
  inputAt?: number
  pings: number
  conversations: WarmConversation[]
}

/** Root settings, attempt count and last ping per conversation. */
export const WarmDoc = docRef<WarmDocState>('keep-warm.state')
/** No arguments → settings and cache status of each target. */
export const StateAction = actionRef<null, WarmState>('keep-warm', 'state')
/** User-only `{ on }`: keep eligible caches warm, or stop. */
export const SetAction = actionRef<{ on: boolean }, WarmState>('keep-warm', 'set')
