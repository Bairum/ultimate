/** The `computer.session` document in the Documents tab: what waits on you, which apps you allowed, the latest steps. */
import { useState } from 'react'
import { api, errorMessage, formatTime } from '@/sdk'
import type { DocumentProps } from '@/sdk'
import { Requests } from './requests.tsx'
import { DenyAction } from './refs.ts'
import { Mark } from './shared.tsx'
import type { Outcome, Session } from './shared.tsx'

function Heading({ children }: { children: string }) {
  return (
    <h3 className="pt-3 pb-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
      {children}
    </h3>
  )
}

export function SessionView({ value, conversationId }: DocumentProps) {
  const session = value as unknown as Session
  const [error, setError] = useState<string>()
  const allowed = new Map<string, Session['grants'][number]>()
  for (const grant of session.grants) allowed.set(grant.app.toLowerCase(), grant)
  const grants = [...allowed.values()].filter(
    (g) => g.scope !== 'deny' && !(g.scope === 'once' && g.used),
  )
  return (
    <div className="space-y-1 font-mono text-[12px]">
      {session.pending.length > 0 && conversationId !== undefined && (
        <>
          <Heading>Needs you</Heading>
          <Requests conversation={conversationId} session={session} />
        </>
      )}
      <Heading>Allowed apps</Heading>
      {grants.length ? (
        <ul className="space-y-1">
          {grants.map((grant) => (
            <li className="flex items-center gap-2" key={grant.app}>
              <span className="min-w-0 flex-1 truncate text-foreground">{grant.app}</span>
              <span className="text-muted-foreground">{grant.scope}</span>
              <button
                className="cursor-pointer text-[11px] text-error hover:underline"
                onClick={() =>
                  conversationId !== undefined &&
                  api
                    .action(DenyAction, { conversation: conversationId, app: grant.app })
                    .catch((failure: unknown) => setError(errorMessage(failure)))
                }
                type="button"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">None in this conversation.</p>
      )}
      {error && <p className="text-error">{error}</p>}
      {session.stopped && (
        <p className="pt-2 text-error">Stopped: nothing is sent until you resume.</p>
      )}
      <Heading>Latest steps</Heading>
      {session.journal.length ? (
        <ul>
          {session.journal
            .filter((entry) => entry.status !== 'decision')
            .slice(-12)
            .map((entry, index) => (
              <li className="flex min-w-0 items-baseline gap-2 leading-[1.7]" key={index}>
                <Mark
                  outcome={(entry.status === 'sending' ? 'unknown' : entry.status) as Outcome}
                />
                <span className="w-12 shrink-0 text-muted-foreground tabular-nums">
                  {formatTime(entry.at)}
                </span>
                <span className="w-16 shrink-0 text-foreground/90">{entry.kind}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {entry.app}
                  {entry.label ? ` · “${entry.label}”` : ''}
                  {entry.length !== undefined ? ` · ${entry.length} chars` : ''}
                </span>
              </li>
            ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">Nothing sent yet.</p>
      )}
    </div>
  )
}
