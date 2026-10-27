/** Codex computer: card data, the paired-browser Stop and the user's guidance to a running turn. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

export type UntrustedText = { text: string; untrusted: true }
export type CodexDetails = {
  status:
    | 'done'
    | 'failed'
    | 'budget'
    | 'stopped'
    | 'codex_missing'
    | 'codex_unsigned'
    | 'computer_use_missing'
    | 'declined'
  session?: string
  apps: {
    app: UntrustedText
    consent: 'accepted' | 'declined' | 'declined (unrecognised)' | 'timeout'
  }[]
  steps: { tool: UntrustedText; status: UntrustedText; at: number }[]
  approvals: { kind: string; app?: UntrustedText; decision: 'accept' | 'decline' | 'error' }[]
  screenshots: string[]
  /** Codex's final answer: its `summary` when it answered in the result schema, else its whole text. */
  answer: UntrustedText
  /** Codex's answer in the result schema, with each finding's capture numbers resolved to saved screenshots. */
  result?: CodexResult
  counts: { items: number; minutes: number }
  /** Times Codex said it was reconnecting to OpenAI and would retry; the run carried on. */
  retries?: number
  /** Times the run continued its thread in a new turn after Codex gave up reconnecting. */
  resumes?: number
  /** Each time the window Codex's state reports changed during the run: window titles, from Codex, untrusted. */
  windows?: { from: UntrustedText; to: UntrustedText; at: number }[]
  /** Guidance sent into the run while it worked; `restarted` when Codex refused a steer and the turn was restarted with it. */
  guidance: {
    from: 'user' | 'operator'
    /** Who sent it, in words: "the user, via the card" or "parent conversation #16427". */
    by: string
    text: string
    at: number
    delivery: 'steered' | 'restarted'
  }[]
  error?: string
}
export type CodexResult = {
  status: 'done' | 'blocked' | 'partial'
  findings: { claim: UntrustedText; quote: UntrustedText; screenshots: string[] }[]
  actions: UntrustedText[]
  remaining: UntrustedText[]
}
export type CodexState = { last?: CodexDetails }
/** A conversation's last Codex outcome. Forks start fresh. */
export const StateDoc = docRef<CodexState>('codex-computer.state')
/** `{conversation?}` → `{stopped}`: stop matching runs, or all runs when omitted. User-only. */
export const StopAction = actionRef<{ conversation?: number }, { stopped: number }>(
  'codex-computer',
  'stop',
)
/** `{conversation, text}` → `{delivery}`: send the user's guidance into that conversation's active Codex turn. User-only. */
export const SteerAction = actionRef<
  { conversation: number; text: string },
  { delivery: 'steered' | 'restarted' }
>('codex-computer', 'steer')
