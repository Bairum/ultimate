/** Computer use: durable session state and the user's consent, confirmation and stop controls. */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { JevDecision } from './types.ts'

export type Session = {
  grants: {
    app: string
    scope: 'once' | 'conversation' | 'project' | 'deny'
    at: number
    used?: boolean
    always?: boolean
  }[]
  confirmed: string[]
  pending: {
    kind: 'consent' | 'confirm'
    app: string
    step?: number
    key?: string
    at: number
    window?: string
    label?: string
  }[]
  journal: {
    call: string
    step: number
    kind: string
    app: string
    role?: string
    label?: string
    length?: number
    status: 'sending' | 'delivered' | 'refused' | 'failed' | 'unknown' | 'decision'
    at: number
    decision?: Omit<JevDecision, 'chose'> & { chose?: string }
  }[]
  stopped: boolean
  lastObservedAt: number
  takeovers: { app: string; at: number }[]
  budget: { steps: number; startedAt: number }
}
/** Per-conversation state; conversation 1 also stores project grants. Journal keeps the latest 200 entries. */
export const SessionDoc = docRef<Session>('computer.session')
/** `{conversation, app, scope, always?}` → session; user-only consent. `always` is required for deny-listed apps. */
export const GrantAction = actionRef<
  {
    conversation: number
    app: string
    scope: 'once' | 'conversation' | 'project'
    always?: boolean
  },
  Session
>('computer-use', 'grant')
/** `{conversation, app}` → session; user-only revocation. */
export const DenyAction = actionRef<{ conversation: number; app: string }, Session>(
  'computer-use',
  'deny',
)
/** `{conversation, key}` → session; user-only confirmation of an exact pending action. */
export const ConfirmAction = actionRef<{ conversation: number; key: string }, Session>(
  'computer-use',
  'confirm',
)
/** `{conversation}` → session; stop between steps, killing the daemon on a second stop or after 1 s in flight. */
export const StopAction = actionRef<{ conversation: number }, Session>('computer-use', 'stop')
/** `{}` → `{stopped:true}`; user-only immediate daemon kill (all sessions on this Mac). */
export const HardStopAction = actionRef<Record<string, never>, { stopped: true }>(
  'computer-use',
  'hardStop',
)
/** `{conversation}` → session; unblock and wake the conversation. */
export const ResumeAction = actionRef<{ conversation: number }, Session>('computer-use', 'resume')
/** `{conversation}` → session; read-only. */
export const StateAction = actionRef<{ conversation: number }, Session>('computer-use', 'state')
/** `{conversation, app}` → session; user-only foreground takeover until stop/release (later: task end). */
export const TakeoverAction = actionRef<{ conversation: number; app: string }, Session>(
  'computer-use',
  'takeover',
)
/** `{conversation, app}` → session; user-only foreground takeover revocation. */
export const ReleaseAction = actionRef<{ conversation: number; app: string }, Session>(
  'computer-use',
  'release',
)
