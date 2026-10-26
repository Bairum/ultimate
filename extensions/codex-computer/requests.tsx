/**
 * What a Codex run waits on the user for: the project's screen-sharing acknowledgement, consent to one app, or another
 * budget. These actions are user-only, so these buttons are the only way to give them. The frame matches the
 * computer-use request cards: warning rule, mono header, facts, buttons.
 */
import { AppWindowIcon, EyeIcon, LoaderCircleIcon, TimerIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { api, cn, errorMessage, formatDuration, useNow } from '@/sdk'
import type { ActionRef } from '@/sdk'
import { AcknowledgeAction, ContinueAction, DenyAction, GrantAction } from './refs.ts'
import type { CodexState, GrantScope } from './refs.ts'

export type Pending = CodexState['pending'][number]

/** One button that calls a user-only action, spinning while it runs; a failure shows under the card. */
function Act<A>({
  action,
  args,
  children,
  primary,
  onError,
}: {
  action: ActionRef<A, unknown>
  args: A
  children: ReactNode
  primary?: boolean
  onError: (message: string | undefined) => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      className={cn(
        'h-7 font-sans text-[12px]',
        primary && 'border-brand/50 text-foreground hover:border-brand',
      )}
      disabled={busy}
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

function Frame({
  icon,
  title,
  aside,
  children,
  buttons,
  error,
  kind,
}: {
  icon: ReactNode
  title: string
  aside?: ReactNode
  children: ReactNode
  buttons: ReactNode
  error?: string
  kind: Pending['kind']
}) {
  return (
    <section
      className="min-w-0 rounded-md border border-border border-l-2 border-l-warning/70 bg-warning/[0.04] font-mono text-[12px]"
      data-codex-request={kind}
    >
      <header className="flex items-center gap-2 px-3 pt-2 text-[11px] text-muted-foreground">
        {icon}
        <span className="text-warning">Needs you</span>
        <span className="min-w-0 truncate">{title}</span>
        {aside}
      </header>
      <div className="space-y-1.5 px-3 pt-1.5">{children}</div>
      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 pb-2.5">{buttons}</div>
      {error && <p className="px-3 pb-2 break-words text-error">{error}</p>}
    </section>
  )
}

/** First use in a project: say plainly where the screens go before anything is sent. */
function Acknowledge({ conversation }: { conversation: number }) {
  const [error, setError] = useState<string>()
  return (
    <Frame
      buttons={
        <Act action={AcknowledgeAction} args={{ conversation }} onError={setError} primary>
          Allow for this project
        </Act>
      }
      error={error}
      icon={<EyeIcon className="size-3.5 text-warning" />}
      kind="acknowledge"
      title="screen sharing with OpenAI"
    >
      <p className="font-sans text-[13px] leading-snug">
        Codex sends screenshots and screen text of every app it uses to{' '}
        <span className="font-medium">OpenAI</span>, under your Codex account.
      </p>
      <p className="text-[11px] text-muted-foreground">
        Applies to this project only. Each app still asks before Codex may use it. The project’s
        settings must also set{' '}
        <span className="text-foreground/80">codexComputer.screensToOpenAI</span>.
      </p>
    </Frame>
  )
}

/** Time left before a waiting consent declines itself (five minutes from `at`). */
function Countdown({ at }: { at: number }) {
  const now = useNow(1000)
  const left = at + 5 * 60_000 - now
  return left > 0 ? (
    <span className="ml-auto shrink-0 tabular-nums">declines in {formatDuration(left)}</span>
  ) : (
    <span className="ml-auto shrink-0">declining…</span>
  )
}

function Consent({ request, conversation }: { request: Pending; conversation: number }) {
  const [error, setError] = useState<string>()
  const app = request.app ?? ''
  const grant = (scope: GrantScope) => ({ conversation, app, scope })
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
          <Act action={DenyAction} args={{ conversation, app }} onError={setError}>
            Deny
          </Act>
        </>
      }
      aside={<Countdown at={request.at} />}
      error={error}
      icon={<AppWindowIcon className="size-3.5 text-warning" />}
      kind="consent"
      title="app consent"
    >
      <p className="font-sans text-[13px] leading-snug">
        Codex wants to use <span className="font-medium">“{app}”</span> on this Mac
        <span className="ml-1.5 font-mono text-[10.5px] text-muted-foreground/60">
          name from Codex, untrusted
        </span>
      </p>
      <p className="text-[11px] text-muted-foreground">
        While Codex uses it, its screens go to OpenAI. Once covers this one request; the run waits
        for your answer.
      </p>
    </Frame>
  )
}

function Continue({
  conversation,
  counts,
}: {
  conversation: number
  counts?: { items: number; minutes: number }
}) {
  const [error, setError] = useState<string>()
  return (
    <Frame
      buttons={
        <Act action={ContinueAction} args={{ conversation }} onError={setError} primary>
          Continue
        </Act>
      }
      error={error}
      icon={<TimerIcon className="size-3.5 text-warning" />}
      kind="continue"
      title="budget used"
    >
      <p className="font-sans text-[13px] leading-snug">
        Codex paused at its budget of 50 steps or 30 minutes
        {counts && (
          <span className="text-muted-foreground">
            {' '}
            · used {counts.items} steps in {Math.round(counts.minutes)} min
          </span>
        )}
        .
      </p>
      <p className="text-[11px] text-muted-foreground">
        Continue gives it a fresh budget and resumes the same Codex session.
      </p>
    </Frame>
  )
}

/** Every request a run waits on, in the order they were raised. */
export function Requests({
  pending,
  conversation,
  counts,
}: {
  pending: readonly Pending[]
  conversation: number
  counts?: { items: number; minutes: number }
}) {
  if (!pending.length) return null
  return (
    <div className="space-y-2">
      {pending.map((request) =>
        request.kind === 'acknowledge' ? (
          <Acknowledge conversation={conversation} key="acknowledge" />
        ) : request.kind === 'consent' ? (
          <Consent
            conversation={conversation}
            key={`c:${request.id ?? request.app}`}
            request={request}
          />
        ) : (
          <Continue conversation={conversation} counts={counts} key="continue" />
        ),
      )}
    </div>
  )
}
