/** Context hygiene's browser-safe ledger types and document reference. */
import { docRef } from '../../shared/extension-api.ts'

export type Decision = {
  reason: 'superseded' | 'empty' | 'duplicate' | 'masked'
  by?: string
  path?: string
  tokens: number
  state: 'pending' | 'applied'
  at: number
}
export type LedgerState = {
  version: 1
  decisions: Record<string, Decision>
  stats: { appliedTokens: number; requests: number }
}
/** Elision decisions for the shown conversation. */
export const LedgerDoc = docRef<LedgerState>('context-hygiene.ledger')
