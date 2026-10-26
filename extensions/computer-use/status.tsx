/**
 * The status-line item: visible whenever an agent controls, waits to control, or was stopped from controlling this
 * Mac. Stop is one click from anywhere; Force stop, which ends every Driver session on the Mac, is the clear second
 * level inside the popover. It watches the newest computer-operator conversations: only that agent has the computer
 * tools, and it usually runs as a subagent the user is not looking at.
 */
import {
  CircleStopIcon,
  LoaderCircleIcon,
  MonitorIcon,
  PlayIcon,
  ShieldOffIcon,
  ZapOffIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  errorMessage,
  formatAgo,
  useAction,
  useConversation,
  useConversations,
  useDocOf,
  useNow,
  useUltimate,
} from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { GuardsAction, HardStopAction, ResumeAction, SessionDoc, StopAction } from './refs.ts'
import type { Session } from './shared.tsx'
import { TeachStatus } from './teach-live.tsx'

const statusButton =
  '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent'

/**
 * What a conversation's session means for the user right now, or `undefined` when there is nothing to show. Stop is
 * project-wide: `stopped` is the flag on conversation 1.
 */
function phase(session: Session | null | undefined, busy: boolean, stopped: boolean) {
  if (!session) return undefined
  const task = session.task
  if (stopped) return 'stopped' as const
  if (session.pending.length) return 'needs' as const
  if (task?.status === 'active' && busy) return 'running' as const
  if (task && ['awaiting_confirmation', 'paused_by_user', 'stopped'].includes(task.status))
    return 'needs' as const
  return undefined
}

/** The app the agent controls: its latest step's, else the task's first. */
const appOf = (session: Session) =>
  session.pending[0]?.app ??
  session.journal.at(-1)?.app ??
  session.task?.spec.scope.apps[0] ??
  'the Mac'

function Action({
  run,
  children,
  className,
  title,
  danger,
}: {
  run: () => Promise<unknown>
  children: React.ReactNode
  className?: string
  title?: string
  danger?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        className={cn(
          'h-7 font-sans text-[12px]',
          danger && 'border-error/40 text-error hover:bg-error/10 hover:text-error',
          className,
        )}
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          run()
            .catch((failure: unknown) => setError(errorMessage(failure)))
            .finally(() => setBusy(false))
        }}
        size="sm"
        title={title}
        variant="outline"
      >
        {busy && <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />}
        {children}
      </Button>
      {error && <span className="max-w-60 text-right text-[11px] text-error">{error}</span>}
    </span>
  )
}

function Item({ conversation, stopped }: { conversation: number; stopped: boolean }) {
  const session = useDocOf(conversation, SessionDoc)
  const busy = useConversations().find((c) => c.id === conversation)?.busy ?? false
  const now = useNow(5000, !!session)
  const { switchConversation } = useUltimate()
  const shown = useConversation((c) => c.id)
  const state = phase(session, busy, stopped)
  if (!session || !state) return null
  const app = appOf(session)
  const task = session.task
  const last = session.journal.findLast((entry) => entry.status !== 'decision')
  const stop = () => api.action(StopAction, { conversation })
  return (
    <span className="flex items-center gap-2.5" data-computer-status={state}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            className={cn(
              statusButton,
              state === 'running'
                ? 'text-brand'
                : state === 'needs'
                  ? 'text-warning'
                  : 'text-error',
            )}
            title="Computer use on this Mac"
            type="button"
          >
            {state === 'running' ? (
              <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />
            ) : (
              <MonitorIcon className="size-3" />
            )}
            {state === 'running' ? 'Controlling' : state === 'needs' ? 'Needs you' : 'Stopped'}
            <span className="max-md:hidden"> · {app}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[24rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
          side="top"
        >
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2 text-[10.5px] tracking-wider text-muted-foreground uppercase">
            Computer use
            <button
              className="ml-auto min-w-0 cursor-pointer truncate normal-case hover:text-foreground"
              onClick={() => switchConversation(conversation)}
              title="Open the conversation"
              type="button"
            >
              <ConversationRef id={conversation} />
            </button>
          </div>
          <div className="space-y-1.5 px-3 py-2 text-[11.5px] leading-[1.55]">
            {task && <p className="font-sans text-[12.5px] leading-snug">“{task.spec.intent}”</p>}
            <p className="text-muted-foreground">
              {state === 'running' ? (
                <span className="text-brand">Controlling {app}</span>
              ) : state === 'needs' ? (
                <span className="text-warning">
                  Waiting for you
                  {session.pending.length > 0 &&
                    `: ${session.pending.map((p) => (p.kind === 'consent' ? `allow ${p.app}` : p.kind === 'confirm' ? 'confirm a step' : p.kind === 'task' ? 'check the task' : 'approve a change')).join(', ')}`}
                </span>
              ) : (
                <span className="text-error">
                  Stopped for this project · nothing is sent until you resume
                </span>
              )}
            </p>
            {task && (
              <p className="text-muted-foreground">
                {task.subgoals.filter((s) => s.status === 'done').length}/{task.subgoals.length}{' '}
                sub-goals · {task.criteriaMet?.length ?? 0}/{task.spec.criteria.length} criteria ·
                steps {task.counters.steps}/{task.spec.stop.steps}
              </p>
            )}
            {last && (
              <p className="truncate text-muted-foreground">
                last: {last.kind}
                {last.label ? ` “${last.label}”` : ''} ·{' '}
                <span
                  className={
                    last.status === 'delivered'
                      ? 'text-success'
                      : last.status === 'unknown' || last.status === 'sending'
                        ? 'text-warning'
                        : 'text-error'
                  }
                >
                  {last.status}
                </span>{' '}
                · {formatAgo(last.at, now)}
              </p>
            )}
            {state === 'needs' && shown !== conversation && (
              <button
                className="cursor-pointer text-brand hover:underline"
                onClick={() => switchConversation(conversation)}
                type="button"
              >
                Answer in its conversation →
              </button>
            )}
          </div>
          <div className="flex items-start justify-between gap-2 border-t border-border/70 px-3 py-1.5">
            <Action
              className="border-transparent bg-transparent text-muted-foreground shadow-none hover:border-error/40 hover:bg-error/10 hover:text-error dark:bg-transparent"
              run={() => api.action(HardStopAction, {})}
              title="Kills the Cua Driver daemon: ends every Driver session on this Mac, including other apps' and conversations'"
            >
              <ZapOffIcon className="size-3" />
              Force stop
            </Action>
            {state === 'stopped' ? (
              <Action run={() => api.action(ResumeAction, { conversation })}>
                <PlayIcon className="size-3" />
                Resume
              </Action>
            ) : (
              <Action danger run={stop} title="No further step is sent; a step in flight finishes">
                <CircleStopIcon className="size-3" />
                Stop
              </Action>
            )}
          </div>
          <p className="px-3 pb-2 text-[10.5px] leading-snug text-muted-foreground/80">
            Stop blocks the next step in every conversation of this project. Force stop also ends
            every Driver session on this Mac.
          </p>
        </PopoverContent>
      </Popover>
      {state === 'running' && <Quick run={stop} />}
    </span>
  )
}

/** Stop beside the item while it runs: one click, no popover. */
function Quick({ run }: { run: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={cn(statusButton, 'text-error')}
      data-computer-quick-stop
      disabled={busy}
      onClick={() => {
        setBusy(true)
        run()
          .catch((error: unknown) => console.error(errorMessage(error)))
          .finally(() => setBusy(false))
      }}
      title="Stop computer use: no further step is sent"
      type="button"
    >
      <CircleStopIcon className="size-3" />
      Stop
    </button>
  )
}

/**
 * `computerUse.guards: false` in settings: no task, consent, confirmation or takeover gate applies, so say so for as
 * long as it lasts. Settings change without a reload, so it reads them again every 30 s.
 */
function GuardsOff() {
  const { data, refetch } = useAction(GuardsAction, {}, { onError: () => {} })
  useEffect(() => {
    const timer = setInterval(() => void refetch(), 30_000)
    return () => clearInterval(timer)
  }, [refetch])
  if (data?.guards !== false) return null
  return (
    <span
      className="flex items-center gap-1.5 text-warning"
      data-computer-guards-off
      title="Computer-use guards are off (computerUse.guards: false): agents act without a task, app consent, confirmations or a foreground takeover. Stop still works. Remove the setting to turn them back on."
    >
      <ShieldOffIcon className="size-3" />
      guards off
    </span>
  )
}

/**
 * The three newest computer operators; watching a session creates it, so ordinary conversations are left alone. While
 * the project is stopped, only the newest operator shows: one Stopped item with Resume, not one per conversation.
 */
export function ComputerStatus() {
  const conversations = useConversations()
  const stopped = useDocOf(1, SessionDoc)?.stopped === true
  const key = conversations
    .filter((c) => c.label === 'computer-operator')
    .map((c) => c.id)
    .toSorted((a, b) => b - a)
    .slice(0, stopped ? 1 : 3)
    .join(',')
  const watched = useMemo(() => (key ? key.split(',').map(Number) : []), [key])
  return (
    <>
      <GuardsOff />
      {watched.map((id) => (
        <span className="flex items-center gap-2.5" key={id}>
          <TeachStatus conversation={id} />
          <Item conversation={id} stopped={stopped} />
        </span>
      ))}
    </>
  )
}
