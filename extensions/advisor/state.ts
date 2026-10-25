import { defineDoc } from '@earendil-works/pi-durable'
import { AdvisorState, AdvisorLedger } from './refs.ts'
import type { AdvisorStateDoc, Role, RoleProfile, LedgerItem } from './refs.ts'

export const State = defineDoc<AdvisorStateDoc>({
  kind: AdvisorState.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ conversations: {}, notes: [], spend: {} }),
})
export const Ledger = defineDoc<{ items: LedgerItem[] }>({
  kind: AdvisorLedger.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ items: [] }),
})
/** Operational latches are separate from the public state contract. */
export const Runs = defineDoc<{
  conversations: Record<
    string,
    {
      run?: number
      continued?: boolean
      rounds: number
      pending?: number
      lastActivity?: number
      lastInput?: number
      idleReviewed?: number
      signals: string[]
    }
  >
  settled: string[]
  deliveries: Record<string, import('./refs.ts').AdvisorNoteEntry>
}>({
  kind: 'advisor.runs',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ conversations: {}, settled: [], deliveries: {} }),
})
export const docs = [State, Ledger, Runs]
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)
export function budgetExceeded(
  state: AdvisorStateDoc,
  role: Role,
  profile: RoleProfile,
  dayUsd: number,
  now: number,
) {
  const spend = state.spend[utcDay(now)]
  return (
    (spend?.total ?? 0) >= dayUsd ||
    (profile.dayUsd !== undefined && (spend?.roles[role] ?? 0) >= profile.dayUsd)
  )
}
