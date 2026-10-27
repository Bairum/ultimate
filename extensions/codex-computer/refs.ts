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
  /**
   * Guidance sent into the run: `steered` into the live turn; `restarted` when Codex refused a steer and the turn was
   * restarted with it; `queued` when no turn ran when it was sent, so the next turn started with it; `answered` when it
   * answered Codex's open ask_operator question.
   */
  guidance: {
    from: 'user' | 'operator'
    /** Who sent it, in words: "the user, via the card" or "parent conversation #16427". */
    by: string
    text: string
    at: number
    delivery: Delivery
  }[]
  error?: string
  /** Milestones Codex reported with report_progress, in order; from Codex, untrusted. */
  progress?: { text: UntrustedText; at: number }[]
}
export type CodexResult = {
  status: 'done' | 'blocked' | 'partial'
  findings: { claim: UntrustedText; quote: UntrustedText; screenshots: string[] }[]
  actions: UntrustedText[]
  remaining: UntrustedText[]
}
/** How guidance reached Codex; see `CodexDetails.guidance`. */
export type Delivery = 'steered' | 'restarted' | 'queued' | 'answered'
/** Guidance sent while no Codex run worked in the conversation: its next run starts with it. */
export type QueuedGuidance = { from: 'user' | 'operator'; by: string; text: string }
export type CodexState = {
  last?: CodexDetails
  /**
   * The ask_operator question Codex waits on: its number in the run, a key unique across runs, its text, and `until`,
   * when Codex stops waiting (after that nobody does, even if a crash left it here).
   */
  question?: { id: number; key: string; text: UntrustedText; at: number; until: number }
  queued?: QueuedGuidance[]
}
/**
 * Data of a `codex-computer.question` entry in the parent's transcript: Codex in `conversation` asks (untrusted `text`);
 * `key` is unique across runs and matches the open `CodexState.question`.
 */
export type QuestionEntry = { conversation: number; question: number; key: string; text: string }
/** A conversation's last Codex outcome. Forks start fresh. */
export const StateDoc = docRef<CodexState>('codex-computer.state')
/** `{conversation?}` → `{stopped}`: stop matching runs, or all runs when omitted. User-only. */
export const StopAction = actionRef<{ conversation?: number }, { stopped: number }>(
  'codex-computer',
  'stop',
)
/**
 * `{conversation, text}` → `{delivery}`: the user's guidance for that conversation's Codex run. It answers Codex's open
 * question, else steers the active turn, else waits for the next turn or run. User-only.
 */
export const SteerAction = actionRef<
  { conversation: number; text: string },
  { delivery: Delivery }
>('codex-computer', 'steer')
