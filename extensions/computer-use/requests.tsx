/**
 * What the agent waits on the user for: consent to an app, one exact risky step, a task spec, a weaker criterion or a
 * wider scope, a foreground takeover. These actions are user-only, so these buttons are the only way to give them.
 */
import {
  AppWindowIcon,
  HandIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { api, cn, errorMessage } from '@/sdk'
import type { ActionRef } from '@/sdk'
import {
  ConfirmAction,
  ConfirmChangeAction,
  ConfirmTaskAction,
  DenyAction,
  GrantAction,
  ReleaseAction,
  TakeoverAction,
} from './refs.ts'
import type { Pending, Session } from './shared.tsx'

/** One button that calls a user-only action, spinning while it runs; a failure shows under the card. */
function Act<A>({
  action,
  args,
  children,
  primary,
  onError,
  disabled,
}: {
  action: ActionRef<A, unknown>
  args: A
  children: ReactNode
  primary?: boolean
  onError: (message: string | undefined) => void
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      className={cn(
        'h-7 font-sans text-[12px]',
        primary && 'border-brand/50 text-foreground hover:border-brand',
      )}
      disabled={busy || disabled}
      onClick={() => {
        setBusy(true)
        onError(undefined)
        api
          .action(action, args)
          .catch((error: unknown) => onError(errorMessage(error)))
          .finally(() => setBusy(false))
      }}
      size="sm"
      variant="outline"
    >
      {busy && <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />}
      {children}
    </Button>
  )
}

/** The frame of a request: warning rule on the left, a mono header saying what is asked, the facts, the buttons. */
function Frame({
  icon,
  title,
  children,
  buttons,
  error,
  kind,
}: {
  icon: ReactNode
  title: ReactNode
  children?: ReactNode
  buttons: ReactNode
  error?: string
  kind: string
}) {
  return (
    <section
      className="min-w-0 rounded-md border border-border border-l-2 border-l-warning/70 bg-warning/[0.04] font-mono text-[12px]"
      data-computer-request={kind}
    >
      <header className="flex items-center gap-2 px-3 pt-2 text-[11px] text-muted-foreground">
        {icon}
        <span className="text-warning">Needs you</span>
        <span className="min-w-0 truncate">{title}</span>
      </header>
      {children && <div className="space-y-1.5 px-3 pt-1.5">{children}</div>}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 pb-2.5">{buttons}</div>
      {error && <p className="px-3 pb-2 break-words text-error">{error}</p>}
    </section>
  )
}

/** A label: value row in the request's fact list. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2 leading-[1.6]">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
  )
}

function Consent({ request, conversation }: { request: Pending; conversation: number }) {
  const [error, setError] = useState<string>()
  const grant = (scope: 'once' | 'conversation' | 'project') => ({
    conversation,
    app: request.app,
    scope,
  })
  return (
    <Frame
      buttons={
        <>
          <Act action={GrantAction} args={grant('once')} onError={setError} primary>
            Allow once
          </Act>
          <Act action={GrantAction} args={grant('conversation')} onError={setError}>
            This conversation
          </Act>
          <Act action={GrantAction} args={grant('project')} onError={setError}>
            This project
          </Act>
          {/* NEXT(server): `deny` gains a scope; offer "Deny once" vs "Never in this project" then. */}
          <span className="flex-1" />
          <Act action={DenyAction} args={{ conversation, app: request.app }} onError={setError}>
            Deny
          </Act>
        </>
      }
      error={error}
      icon={<AppWindowIcon className="size-3.5 text-warning" />}
      kind="consent"
      title="app consent"
    >
      <p className="font-sans text-[13px] leading-snug">
        Let the agent operate <span className="font-medium">{request.app}</span> on this Mac?
      </p>
      <p className="text-[11px] text-muted-foreground">
        Once covers one delivered step. It works in the background; you can Stop any time from the
        status line.
      </p>
    </Frame>
  )
}

function Confirm({ request, conversation }: { request: Pending; conversation: number }) {
  const [error, setError] = useState<string>()
  return (
    <Frame
      buttons={
        <Act
          action={ConfirmAction}
          args={{ conversation, key: request.key ?? '' }}
          disabled={!request.key}
          onError={setError}
          primary
        >
          Confirm this step
        </Act>
      }
      error={error}
      icon={<ShieldAlertIcon className="size-3.5 text-warning" />}
      kind="confirm"
      title="risky step"
    >
      <Fact label="app">{request.app}</Fact>
      {request.window !== undefined && <Fact label="window">“{request.window}”</Fact>}
      {request.label !== undefined && (
        <Fact label="control">{request.label || '(unlabelled)'}</Fact>
      )}
      {/* NEXT(server): pending confirmations carry a display payload (text, value, chord or menu path, ≤200 chars);
          show it here as a `sends` fact so the user sees exactly what they confirm. */}
      <p className="text-[11px] text-muted-foreground">
        {/* NEXT(server): confirmations become one-shot; drop "every identical step" then. */}
        Confirming allows every identical step on this control in this window, not just this one.
      </p>
    </Frame>
  )
}

/**
 * The task spec the agent wrote, to confirm before it acts. `compact` inside the task card, which already shows the
 * intent and criteria: only why it asks, the scope, and the button.
 */
function TaskConfirm({
  session,
  conversation,
  compact,
  reasons,
}: {
  session: Session
  conversation: number
  compact?: boolean
  reasons?: string[]
}) {
  const [error, setError] = useState<string>()
  const task = session.task
  const why = reasons?.length
    ? reasons.join(' · ')
    : task?.ledger.findLast((entry) => entry.kind === 'start')?.reason
  return (
    <Frame
      buttons={
        <Act action={ConfirmTaskAction} args={{ conversation }} onError={setError} primary>
          Confirm task
        </Act>
      }
      error={error}
      icon={<ListChecksIcon className="size-3.5 text-warning" />}
      kind="task"
      title={why ? `check the task · ${why}` : 'check the task'}
    >
      {task && (
        <>
          {!compact && (
            <>
              <p className="font-sans text-[13px] leading-snug">“{task.spec.intent}”</p>
              <Fact label="done when">
                <ul>
                  {task.spec.criteria.map((criterion) => (
                    <li key={criterion.id}>
                      {criterion.text}
                      {criterion.check === 'evidence' && (
                        <span className="text-warning"> · judged from evidence</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Fact>
            </>
          )}
          <Fact label="apps">{task.spec.scope.apps.join(', ')}</Fact>
          <Fact label="actions">{task.spec.scope.actions.join(' ')}</Fact>
          {task.spec.scope.consequential.length > 0 && (
            <Fact label="risky">
              <span className="text-warning">{task.spec.scope.consequential.join(', ')}</span>
            </Fact>
          )}
          {compact && task.spec.criteria.some((c) => c.check === 'evidence') && (
            <p className="text-[11px] text-muted-foreground">
              A criterion judged from evidence cannot be checked on screen; confirm it says what you
              mean.
            </p>
          )}
        </>
      )}
    </Frame>
  )
}

function Change({ session, conversation }: { session: Session; conversation: number }) {
  const [error, setError] = useState<string>()
  const task = session.task
  const change = task?.pendingChange
  const kept = new Set(change?.criteria?.map((c) => `${c.id}\n${c.text}`) ?? [])
  const dropped = change?.criteria
    ? (task?.spec.criteria.filter((c) => !kept.has(`${c.id}\n${c.text}`)) ?? [])
    : []
  const before = new Set(task?.spec.scope.apps ?? [])
  const added = change?.scope?.apps.filter((app) => !before.has(app)) ?? []
  return (
    <Frame
      buttons={
        <Act action={ConfirmChangeAction} args={{ conversation }} onError={setError} primary>
          Approve change
        </Act>
      }
      error={error}
      icon={<ListChecksIcon className="size-3.5 text-warning" />}
      kind="change"
      title="weaker task"
    >
      {change && <p className="font-sans text-[13px] leading-snug">{change.reason}</p>}
      {dropped.map((criterion) => (
        <Fact key={criterion.id} label="drops">
          <span className="text-diff-del line-through decoration-diff-del/40">
            {criterion.text}
          </span>
        </Fact>
      ))}
      {change?.criteria
        ?.filter((c) => !task?.spec.criteria.some((old) => old.id === c.id && old.text === c.text))
        .map((criterion) => (
          <Fact key={criterion.id} label="now">
            {criterion.text}
          </Fact>
        ))}
      {added.length > 0 && (
        <Fact label="adds">
          <span className="text-warning">{added.join(', ')}</span>
        </Fact>
      )}
      <p className="text-[11px] text-muted-foreground">
        The task waits until you approve. Without approval it can only finish as partial.
      </p>
    </Frame>
  )
}

/** A takeover the agent asked for by being refused `user_active`, or one already granted (Release). */
export function Takeover({
  app,
  conversation,
  granted,
}: {
  app: string
  conversation: number
  granted: boolean
}) {
  const [error, setError] = useState<string>()
  if (granted)
    return (
      <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
        <HandIcon className="size-3 text-warning" />
        <span className="min-w-0 flex-1">
          Agent may type into <span className="text-foreground">{app}</span> while it is in front
        </span>
        <Act action={ReleaseAction} args={{ conversation, app }} onError={setError}>
          Release
        </Act>
        {error && <span className="text-error">{error}</span>}
      </div>
    )
  return (
    <Frame
      buttons={
        <Act action={TakeoverAction} args={{ conversation, app }} onError={setError} primary>
          Let it type into {app}
        </Act>
      }
      error={error}
      icon={<HandIcon className="size-3.5 text-warning" />}
      kind="takeover"
      title="foreground takeover"
    >
      <p className="font-sans text-[13px] leading-snug">
        <span className="font-medium">{app}</span> is the app you are in, so the agent will not type
        into it.
      </p>
      <p className="text-[11px] text-muted-foreground">
        Allowing it lets keystrokes go to {app} while it is in front, until you Stop or Release.
        Step away from the keyboard first.
      </p>
    </Frame>
  )
}

/** Every request the session waits on, newest last. */
export function Requests({
  session,
  conversation,
  only,
  compact,
  reasons,
}: {
  session: Session
  conversation: number
  /** Show only requests for this app (an inline card under the call that raised them). */
  only?: (request: Pending) => boolean
  /** Inside the task card: leave out what it already shows. */
  compact?: boolean
  /** Why the task needs confirming, from the start result. */
  reasons?: string[]
}) {
  const pending = session.pending.filter(only ?? (() => true))
  if (!pending.length) return null
  return (
    <div className="space-y-2">
      {pending.map((request) =>
        request.kind === 'consent' ? (
          <Consent conversation={conversation} key={`c:${request.app}`} request={request} />
        ) : request.kind === 'confirm' ? (
          <Confirm conversation={conversation} key={`k:${request.key}`} request={request} />
        ) : request.kind === 'task' ? (
          <TaskConfirm
            compact={compact}
            conversation={conversation}
            key="task"
            reasons={reasons}
            session={session}
          />
        ) : (
          <Change conversation={conversation} key="change" session={session} />
        ),
      )}
    </div>
  )
}

/** After the user answered: one quiet line saying what they decided. `grants` include project grants (conversation 1). */
export function Answered({ grants, app }: { grants: Session['grants']; app: string }) {
  const grant = grants
    .filter((g) => g.app.toLowerCase() === app.toLowerCase())
    .reduce<Session['grants'][number] | undefined>(
      (latest, g) => (!latest || g.at >= latest.at ? g : latest),
      undefined,
    )
  if (!grant) return null
  const denied = grant.scope === 'deny'
  return (
    <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      {denied ? (
        <ShieldAlertIcon className="size-3 text-error" />
      ) : (
        <ShieldCheckIcon className="size-3 text-success" />
      )}
      <span>
        You {denied ? 'denied' : 'allowed'} <span className="text-foreground">{app}</span>
        {!denied &&
          (grant.scope === 'once'
            ? grant.used
              ? ' once · used'
              : ' once'
            : ` for this ${grant.scope}`)}
      </span>
    </div>
  )
}
