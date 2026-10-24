/** Context hygiene: durable elision decisions and the deterministic request rewrite service. */
import { defineDoc } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import { defineApi } from '../../shared/extension-api.ts'

import type { LedgerState } from './refs.ts'
export type { Decision, LedgerState } from './refs.ts'
export type Thresholds = {
  cacheTtlMs: number
  protectTokens: number
  suffixTokens: number
  suffixSavings: number
  pressureRatio: number
  pressureSavings: number
}
export type GateInput = {
  now: number
  lastAssistant?: number
  newContext: boolean
  suffixTokens: number
  savings: number
  requestTokens: number
  contextWindow: number
}
/** Rewind and forks track decisions at the same point as their transcript. */
export const Ledger = defineDoc<LedgerState>({
  kind: 'context-hygiene.ledger',
  version: 1,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ version: 1, decisions: {}, stats: { appliedTokens: 0, requests: 0 } }),
})
export type ContextHygieneService = {
  /** Whether pending savings justify breaking the cached prefix. */
  gateOpen(input: GateInput, thresholds: Thresholds): boolean
  /** Replace only applied tool-result text, preserving pairing and order. */
  rewrite(messages: readonly Message[], decisions: LedgerState['decisions']): readonly Message[]
}
/** Optional service for subsequent context compression phases. */
export const ContextHygiene = defineApi<ContextHygieneService>()('context-hygiene')
