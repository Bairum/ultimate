import { cn } from '@/sdk'
import { PASSES } from './types.ts'
import type { PassName } from './types.ts'
import type { PassState, Session } from './refs.ts'

/** How each pass reads to a person, in the journal's order. */
export const passLabels: Record<PassName, string> = {
  memory: 'Memory',
  failures: 'Failures',
  tools: 'Tools',
  corrections: 'Corrections & wishes',
  codify: 'Codify memories',
}

const words: Record<PassState['status'], string> = {
  waiting: 'waiting',
  running: 'dreaming',
  done: 'done',
  failed: 'failed',
}

/**
 * A pass as a moon phase: waiting is a new moon, running a waxing crescent that breathes slowly (still under reduced
 * motion), done a full moon, failed a dim moon with an error rim.
 */
export function Moon({ status, className }: { status: PassState['status']; className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn(
        'size-3 shrink-0',
        status === 'failed' ? 'text-error/70' : 'text-brand',
        status === 'waiting' && 'text-muted-foreground/50',
        className,
      )}
      viewBox="0 0 12 12"
    >
      <circle
        cx="6"
        cy="6"
        fill={status === 'done' ? 'currentColor' : 'none'}
        r="5"
        stroke="currentColor"
        strokeOpacity={status === 'done' ? 1 : 0.6}
        strokeWidth="1"
      />
      {status === 'running' && (
        // The lit right side: the outer rim's half, closed by a shallow inner curve.
        <path
          className="motion-safe:animate-pulse-dot"
          d="M6 1 A5 5 0 0 1 6 11 A2.4 5 0 0 0 6 1 Z"
          fill="currentColor"
          style={{ animationDuration: '2.8s' }}
        />
      )}
      {status === 'failed' && <circle cx="6" cy="6" fill="currentColor" opacity="0.25" r="5" />}
    </svg>
  )
}

/** The five passes of `session`: a moon, the pass's name and its one-line note. */
export function Passes({ session }: { session: Session }) {
  return (
    <ol className="space-y-1" data-dream-passes={session.id}>
      {PASSES.map((pass) => {
        const state = session.passes[pass]
        return (
          <li
            className="grid grid-cols-[0.75rem_9.5rem_minmax(0,1fr)] items-baseline gap-x-2 text-[12px] leading-5 max-sm:grid-cols-[0.75rem_minmax(0,1fr)]"
            data-pass={pass}
            data-status={state.status}
            key={pass}
          >
            <Moon className="translate-y-0.5 self-start" status={state.status} />
            <span
              className={cn(
                'truncate',
                state.status === 'waiting' ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {passLabels[pass]}
            </span>
            <span
              className={cn(
                'min-w-0 text-muted-foreground max-sm:col-start-2',
                state.status === 'failed' && 'text-error/90',
              )}
            >
              {state.note ?? words[state.status]}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** The five moons in a row, for a one-line readout. */
export function MoonRow({ session }: { session: Session }) {
  return (
    <span className="inline-flex items-center gap-1" title="Dream passes">
      {PASSES.map((pass) => (
        <Moon key={pass} status={session.passes[pass].status} />
      ))}
    </span>
  )
}
