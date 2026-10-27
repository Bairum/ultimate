import { defineDoc } from '@earendil-works/pi-durable'
import { AdvisorState, AdvisorLedger } from './refs.ts'
import type { AdvisorStateDoc, Role, RoleProfile, LedgerItem } from './refs.ts'
import type { SignalState } from './signals.ts'

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
      /** The reviewed answer (its `answerAt`) whose blocker last woke the parent: one wake per answer. */
      woke?: number
      rounds: number
      lastRound?: number
      pending?: number
      lastActivity?: number
      lastInput?: number
      idleReviewed?: number
      signals: string[]
      continuations?: string[]
      deliveries?: string[]
      scan?: SignalState
    }
  >
  settled: string[]
  settledAt?: Record<string, number>
  deliveries: Record<string, import('./refs.ts').AdvisorNoteEntry>
  readRuns?: Record<string, number>
  closeouts?: Record<string, number>
  nextRef?: number
  /** Review durations for latency stats, newest last; kept 14 days. */
  timings?: import('./refs.ts').Timing[]
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
/** Operational history is short-lived; public notes and spend have their own retention. */
export function pruneRuns(
  runs: ReturnType<typeof Runs.definition.initial>,
  concluded: ReadonlySet<number>,
  now: number,
) {
  const cutoff = now - 86_400_000
  runs.settled = runs.settled.filter((id) => (runs.settledAt?.[id] ?? 0) >= cutoff)
  const retained = new Set(runs.settled)
  for (const id of Object.keys(runs.settledAt ?? {}))
    if (!retained.has(id)) delete runs.settledAt![id]
  for (const id of Object.keys(runs.deliveries)) if (!retained.has(id)) delete runs.deliveries[id]
  if (runs.timings) runs.timings = runs.timings.filter((t) => t.at >= now - 14 * 86_400_000)
  for (const [id, row] of Object.entries(runs.conversations)) {
    if (concluded.has(Number(id))) {
      for (const delivery of row.deliveries ?? []) delete runs.deliveries[delivery]
      delete runs.conversations[id]
    } else if (row.deliveries)
      row.deliveries = row.deliveries.filter((key) => runs.deliveries[key] !== undefined)
  }
}
