/** The `computer.session` document in the Documents tab: what waits on you, teaching, which apps you allowed, the latest steps. */
import { useState } from 'react'
import { api, errorMessage, formatTime, useConversations, useDocOf } from '@/sdk'
import type { DocumentProps } from '@/sdk'
import { Requests } from './requests.tsx'
import { DenyAction, SessionDoc } from './refs.ts'
import { Mark } from './shared.tsx'
import type { Outcome, Session } from './shared.tsx'
import { TeachSection } from './teach-cards.tsx'

function Heading({ children }: { children: string }) {
  return (
    <h3 className="pt-3 pb-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
      {children}
    </h3>
  )
}

type Grant = Session['grants'][number]
/** The grants still in force, newest per app: project ones from conversation 1, then this conversation's. */
function standing(project: readonly Grant[], local: readonly Grant[]) {
  const latest = new Map<string, Grant>()
  for (const grant of [...project, ...local].toSorted((a, b) => a.at - b.at))
    latest.set(grant.app.toLowerCase(), grant)
  return [...latest.values()].filter((g) => g.scope !== 'deny' && !(g.scope === 'once' && g.used))
}

export function SessionView({ value, conversationId }: DocumentProps) {
  const session = value as unknown as Session
  const root = useDocOf(1, SessionDoc)
  const [error, setError] = useState<string>()
  const project =
    conversationId === 1
      ? []
      : (root?.grants.filter(
          (g) => g.scope === 'project' || (g.scope === 'deny' && g.denyScope === 'project'),
        ) ?? [])
  const grants = standing(project, session.grants)
  const operator = useConversations().some(
    (c) => c.id === conversationId && c.label === 'computer-operator',
  )
  return (
    <div className="space-y-1 font-mono text-[12px]">
      {session.pending.length > 0 && (
        <>
          <Heading>Needs you</Heading>
          <Requests conversation={conversationId} session={session} />
        </>
      )}
      {operator && (
        <>
          <Heading>Teach</Heading>
          <TeachSection conversation={conversationId} />
        </>
      )}
      <Heading>Allowed apps</Heading>
      {grants.length ? (
        <ul className="space-y-1">
          {grants.map((grant) => (
            <li className="flex items-center gap-2" key={grant.app}>
              <span className="min-w-0 flex-1 truncate text-foreground">{grant.app}</span>
              <span className="text-muted-foreground">
                {grant.scope === 'once' ? 'once' : `this ${grant.scope}`}
              </span>
              <button
                className="cursor-pointer text-[11px] text-error hover:underline"
                onClick={() =>
                  void api
                    .action(DenyAction, {
                      conversation: conversationId,
                      app: grant.app,
                      // A project grant is revoked for the project; any other only here.
                      scope: grant.scope === 'project' ? 'project' : 'conversation',
                    })
                    .catch((failure: unknown) => setError(errorMessage(failure)))
                }
                title={
                  grant.scope === 'project'
                    ? `Deny ${grant.app} in every conversation of this project`
                    : `Deny ${grant.app} in this conversation`
                }
                type="button"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">None.</p>
      )}
      {error && <p className="text-error">{error}</p>}
      {(root?.stopped ?? session.stopped) && (
        <p className="pt-2 text-error">
          Stopped for this project: nothing is sent until you resume.
        </p>
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
