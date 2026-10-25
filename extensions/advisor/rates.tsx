import { cn } from '@/sdk'
import { ROLES } from './refs.ts'
import type { Role, StoredNote } from './refs.ts'
import { OUTCOMES, outcomeOf, outcomes } from './parts.tsx'
import type { Outcome } from './parts.tsx'

const heading = 'font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase'
const DAYS = 7

/**
 * What agents did with advice over the last week, per role: one bar of outcomes in a fixed order (acted on first,
 * never reached last), the addressed share as the headline, and user dismissals beside it since they're the user's
 * call, not the agent's.
 *
 * Counted here from the retained notes rather than through `StatsAction`: it's the same data, it updates the moment a
 * note changes or a bulk action lands, and it needs no round trip. Notes beyond the 500 the state keeps are the only
 * thing it can miss, and a week of advice stays well under that.
 */
export function Rates({ notes, now }: { notes: StoredNote[]; now: number }) {
  const since = now - DAYS * 86_400_000
  const rows = ROLES.map((role) => {
    const recent = notes.filter((n) => n.role === role && n.at >= since)
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>
    for (const n of recent) {
      const outcome = outcomeOf(n)
      if (outcome) counts[outcome]++
    }
    const tracked = OUTCOMES.reduce((sum, o) => sum + counts[o], 0)
    return {
      role,
      counts,
      tracked,
      cards: recent.filter((n) => n.delivered === 'card').length,
      dismissed: recent.filter((n) => n.status === 'dismissed' && n.closedBy === 'user').length,
    }
  }).filter((row) => row.tracked > 0)
  if (rows.length === 0) return null
  return (
    <section className="border-t border-border/60 px-3 pt-2.5 pb-2.5" data-advisor-rates>
      <h3 className={cn(heading, 'flex items-center pb-1.5')}>
        Responses
        <span className="ml-auto tracking-normal normal-case text-muted-foreground/60">
          last {DAYS} days
        </span>
      </h3>
      <div className="space-y-2">
        {rows.map((row) => (
          <RoleRate key={row.role} {...row} />
        ))}
      </div>
      <Legend />
    </section>
  )
}

function RoleRate({
  role,
  counts,
  tracked,
  cards,
  dismissed,
}: {
  role: Role
  counts: Record<Outcome, number>
  tracked: number
  cards: number
  dismissed: number
}) {
  const share = (n: number) => `${Math.round((n / tracked) * 100)}%`
  const breakdown = OUTCOMES.filter((o) => counts[o] > 0)
    .map((o) => `${counts[o]} ${outcomes[o].word} (${share(counts[o])})`)
    .join('\n')
  return (
    <div data-advisor-rate={role} title={breakdown}>
      <div className="flex items-baseline gap-2 font-mono text-[11.5px] tabular-nums">
        <span className="w-28 shrink-0 truncate text-foreground/85">
          {role === 'ultimate' ? '@ultimate' : role}
        </span>
        <span className="text-success">{share(counts.addressed)}</span>
        <span className="text-muted-foreground/60">addressed</span>
        <span className="ml-auto shrink-0 text-muted-foreground/70">
          {tracked} {tracked === 1 ? 'note' : 'notes'}
          {cards > 0 && <span className="text-muted-foreground/50"> +{cards} cards</span>}
        </span>
      </div>
      <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted">
        {OUTCOMES.map((o) =>
          counts[o] ? (
            <span
              className={cn(
                'h-full border-r border-background last:border-r-0',
                outcomes[o].bar,
                o === 'pending' &&
                  'bg-[repeating-linear-gradient(135deg,transparent_0_2px,var(--color-border)_2px_3px)]',
              )}
              key={o}
              style={{ width: `${(counts[o] / tracked) * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <p className="mt-1 flex flex-wrap gap-x-2 font-mono text-[10.5px] text-muted-foreground/70 tabular-nums">
        {OUTCOMES.filter((o) => o !== 'addressed' && counts[o] > 0).map((o) => (
          <span key={o}>
            <span className={outcomes[o].text}>{counts[o]}</span> {outcomes[o].word}
          </span>
        ))}
        {dismissed > 0 && (
          <span className="ml-auto" title="Notes you dismissed, apart from what the agent did">
            {dismissed} dismissed by you
          </span>
        )}
      </p>
    </div>
  )
}

function Legend() {
  return (
    <p className="mt-2 flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-muted-foreground/60">
      {OUTCOMES.map((o) => (
        <span className="flex items-center gap-1" key={o} title={outcomes[o].title}>
          <span
            className={cn(
              'size-1.5 rounded-full',
              o === 'pending' ? 'border border-muted-foreground/50' : outcomes[o].bar,
            )}
          />
          {outcomes[o].word}
        </span>
      ))}
    </p>
  )
}
