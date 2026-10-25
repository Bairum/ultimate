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
import { predicate } from './shared.tsx'
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
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-foreground">{children}</span>
    </div>
  )
}

/** Text read off the screen: plain text with the same marker as the accessibility tree. */
function Screen({ children }: { children: string }) {
  return (
    <>
      “{children}”
      <span className="ml-1.5 text-[10.5px] text-muted-foreground/60">screen text, untrusted</span>
    </>
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
      {request.window !== undefined && (
        <Fact label="window">
          <Screen>{request.window}</Screen>
        </Fact>
      )}
      {request.label !== undefined && (
        <Fact label="control">
          {request.label ? <Screen>{request.label}</Screen> : '(unlabelled)'}
        </Fact>
      )}
      {request.x !== undefined && request.y !== undefined && (
        <Fact label="point">
          {request.x}, {request.y}
          <span className="ml-1.5 text-[10.5px] text-muted-foreground/60">screenshot px</span>
        </Fact>
      )}
      {request.payload ? (
        <Fact label="sends">
          <pre className="max-h-40 overflow-auto rounded-sm bg-terminal px-2 py-1.5 text-[11.5px] leading-[1.5] break-words whitespace-pre-wrap">
            {visible(request.payload)}
          </pre>
          <span className="text-[10.5px] text-muted-foreground/70">
            {request.payload.length} characters
          </span>
        </Fact>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        Confirming allows this one step, once, within 5 minutes. A repeat or a later try asks again.
      </p>
    </Frame>
  )
}

/** Show invisible and direction-changing characters as escapes, so the user sees every character they confirm. */
const visible = (payload: string) =>
  payload.replace(
    /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  )

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

type Criterion = NonNullable<Session['task']>['spec']['criteria'][number]
const checkText = (check: Criterion['check']) =>
  check === 'evidence' ? 'judged from evidence' : check.map(predicate).join(' · ')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What a list gains: the items of `after` not in `before`. */
const added = (before: readonly string[] = [], after?: readonly string[]) =>
  after?.filter((item) => !before.includes(item)) ?? []

/**
 * A replan that weakens the task or widens its scope, diffed whole: every criterion dropped, added or changed (text
 * and check, before → after; a switch to "judged from evidence" in warning colour), and every app, action and risky
 * label it adds to the scope. Nothing that weakens or widens may hide.
 */
function Change({ session, conversation }: { session: Session; conversation: number }) {
  const [error, setError] = useState<string>()
  const task = session.task
  const change = task?.pendingChange
  const old = task?.spec.criteria ?? []
  const next = change?.criteria
  const dropped = next ? old.filter((c) => !next.some((n) => n.id === c.id)) : []
  const fresh = next?.filter((c) => !old.some((o) => o.id === c.id)) ?? []
  const changed = next
    ? next.flatMap((c) => {
        const before = old.find((o) => o.id === c.id)
        return before && !same(before, c) ? [{ before, after: c }] : []
      })
    : []
  const scope = change?.scope
  const widen = scope
    ? {
        apps: added(task?.spec.scope.apps, scope.apps),
        actions: added(task?.spec.scope.actions, scope.actions),
        risky: added(task?.spec.scope.consequential, scope.consequential),
      }
    : { apps: [], actions: [], risky: [] }
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
      title="weaker task or wider scope"
    >
      {change && <p className="font-sans text-[13px] leading-snug">{change.reason}</p>}
      {dropped.map((criterion) => (
        <Fact key={criterion.id} label="drops">
          <span className="text-diff-del line-through decoration-diff-del/40">
            {criterion.text}
          </span>
        </Fact>
      ))}
      {changed.map(({ before, after }) => (
        <Fact key={after.id} label="changes">
          <span className="block">
            {before.text === after.text ? (
              after.text
            ) : (
              <>
                <span className="text-diff-del line-through decoration-diff-del/40">
                  {before.text}
                </span>{' '}
                → {after.text}
              </>
            )}
          </span>
          {!same(before.check, after.check) && (
            <span className="block text-[11px]">
              <span className="text-muted-foreground">{checkText(before.check)}</span> →{' '}
              <span className={after.check === 'evidence' ? 'text-warning' : undefined}>
                {checkText(after.check)}
              </span>
            </span>
          )}
        </Fact>
      ))}
      {fresh.map((criterion) => (
        <Fact key={criterion.id} label="adds">
          {criterion.text}
          <span
            className={cn(
              'block text-[11px]',
              criterion.check === 'evidence' ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            {checkText(criterion.check)}
          </span>
        </Fact>
      ))}
      {widen.apps.length > 0 && (
        <Fact label="+apps">
          <span className="text-warning">{widen.apps.join(', ')}</span>
        </Fact>
      )}
      {widen.actions.length > 0 && (
        <Fact label="+actions">
          <span className="text-warning">{widen.actions.join(' ')}</span>
        </Fact>
      )}
      {widen.risky.length > 0 && (
        <Fact label="+risky">
          <span className="text-warning">{widen.risky.join(', ')}</span>
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
        {denied
          ? grant.denyScope === 'project'
            ? ' for this project'
            : ' in this conversation'
          : grant.scope === 'once'
            ? grant.used
              ? ' once · used'
              : ' once'
            : ` for this ${grant.scope}`}
      </span>
    </div>
  )
}
