import {
  ChevronRightIcon,
  CircleAlertIcon,
  EllipsisIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SquareArrowOutUpRightIcon,
  TimerIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import {
  api,
  cn,
  errorMessage,
  formatDuration,
  useAction,
  useCommands,
  useConversations,
  useExtensionUiState,
  useNow,
  useTasks,
  useUltimate,
} from '@/sdk'
import { AutomationForm } from './form.tsx'
import {
  BusyDot,
  Heading,
  RunIcon,
  Tag,
  ago,
  clock,
  full,
  spent,
  statusLabel,
  until,
  words,
} from './parts.tsx'
import {
  DeleteAction,
  DescribeAction,
  ListAction,
  PauseAction,
  ResumeAction,
  RunAction,
} from './refs.ts'
import type { Automation, Run, Schedule } from './refs.ts'

/**
 * Refetches when automation work changes: a scheduler or run task in the live task graph, or a run conversation
 * appearing or settling (a quick run can start and finish between two graph updates). The session document itself is
 * not streamed, so this is how fires show up live. A next run left in the past means a fire went unseen, such as a
 * skipped one, so it refetches every two seconds until the time moves on.
 */
export function useLive(refetch: () => unknown, overdue: boolean, now: number) {
  const graph = useTasks()
  const conversations = useConversations()
  const signature = [
    ...Object.values(graph?.tasks ?? {})
      .filter((task) => task.kind.startsWith('ultimate.automation-'))
      .map(
        (task) =>
          `${task.id}:${task.state.status}:${'phase' in task.state ? task.state.phase : ''}:${task.conversations.join(',')}`,
      ),
    ...conversations
      .filter((conversation) => conversation.label === 'automation')
      .map((conversation) => `#${conversation.id}:${conversation.busy}`),
  ].join(' ')
  const seen = useRef(signature)
  useEffect(() => {
    if (seen.current === signature) return undefined
    seen.current = signature
    const timer = setTimeout(() => void refetch(), 100)
    return () => clearTimeout(timer)
  }, [signature, refetch])
  const polled = useRef(0)
  useEffect(() => {
    if (!overdue || now - polled.current < 2000) return
    polled.current = now
    void refetch()
  }, [overdue, now, refetch])
  useEffect(() => {
    const refresh = () => void refetch()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refetch])
}

const raw = (schedule: Schedule) =>
  schedule.kind === 'cron'
    ? `cron "${schedule.expr}" ${schedule.tz}`
    : schedule.kind === 'at'
      ? `at ${schedule.time}`
      : `every ${schedule.ms / 1000}s`

/** The schedule in words, from the backend's `describe`; a one-shot needs only its time. */
function useWords(schedule: Schedule, now: number) {
  const { data } = useAction(
    DescribeAction,
    { schedule },
    { enabled: schedule.kind !== 'at', onError: () => {} },
  )
  return words(schedule, data?.description ?? raw(schedule), now)
}

/** The answer's first line without its Markdown marks: `## Complete` reads as `Complete`. */
const plain = (line: string) => line.replace(/^[\s#>*+-]+/, '').replace(/[*_`]+/g, '')

/** One past run: status, fire time, the first line of its answer, and a way into its conversation. */
function RunRow({ run, now }: { run: Run; now: number }) {
  const { conversationId, switchConversation } = useUltimate()
  const conversation = useConversations().find((summary) => summary.id === run.conversationId)
  const working = run.status === 'running'
  const shown = run.conversationId !== undefined && run.conversationId === conversationId
  const took =
    run.finishedAt !== undefined && run.status !== 'skipped'
      ? ` · took ${formatDuration(run.finishedAt - run.firedAt)}`
      : ''
  const line = working ? (
    <span className="flex items-center gap-1.5 text-brand">
      <BusyDot />
      {conversation?.busy === false ? 'finishing' : 'working'} ·{' '}
      {formatDuration(Math.max(0, now - run.firedAt))}
    </span>
  ) : run.status === 'skipped' ? (
    'skipped: the previous run was still working'
  ) : run.answer ? (
    <span className={cn(run.status === 'failed' && 'text-error/90')}>{plain(run.answer)}</span>
  ) : (
    statusLabel(run.status)
  )
  return (
    <li
      className={cn(
        'flex h-6 min-w-0 items-center gap-1.5 rounded-sm pr-0.5 pl-1.5',
        shown && 'bg-accent/70',
      )}
      data-run={run.id}
    >
      <RunIcon status={run.status} />
      <span
        className="shrink-0 font-mono text-[11px] text-foreground/80 tabular-nums"
        title={`${full(run.firedAt)}\n${statusLabel(run.status)}${took}`}
      >
        {clock(run.firedAt, now)}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
        title={typeof line === 'string' ? line : run.answer}
      >
        {line}
      </span>
      {run.conversationId !== undefined && (
        <Button
          className="h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => switchConversation(run.conversationId!)}
          size="xs"
          title={`Show the run's conversation #${run.conversationId}`}
          variant="ghost"
        >
          <SquareArrowOutUpRightIcon className="size-3" />
          open #{run.conversationId}
        </Button>
      )}
    </li>
  )
}

const FIRST = 8

/** Past runs, newest first; the backend keeps the last 50. */
function Runs({ runs, now }: { runs: Run[]; now: number }) {
  const [all, setAll] = useState(false)
  if (runs.length === 0)
    return (
      <p className="pb-2 pl-8 text-[12px] text-muted-foreground/80">
        No runs yet: Run now starts one.
      </p>
    )
  const newest = runs.toReversed()
  return (
    <div className="pr-1.5 pb-2 pl-6">
      <ol aria-label="Runs">
        {(all ? newest : newest.slice(0, FIRST)).map((run) => (
          <RunRow key={run.id} now={now} run={run} />
        ))}
      </ol>
      {newest.length > FIRST && (
        <button
          className="mt-0.5 ml-1.5 font-mono text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
          onClick={() => setAll(!all)}
          type="button"
        >
          {all ? 'Show fewer' : `Show ${newest.length - FIRST} more`}
        </button>
      )}
    </div>
  )
}

/** When it runs next, or why it does not. */
function Next({ automation, now }: { automation: Automation; now: number }) {
  if (automation.enabled)
    return automation.nextAt !== undefined ? (
      <span title={full(automation.nextAt)}>
        next <span className="text-foreground/85">{until(automation.nextAt, now)}</span>
      </span>
    ) : (
      <span>scheduling…</span>
    )
  if (spent(automation, now))
    return <span>{automation.runs.length ? 'ran once' : 'time passed'}</span>
  return <span className="text-warning/90">paused</span>
}

function Last({ run, now }: { run?: Run; now: number }) {
  if (!run) return <span className="text-muted-foreground/70">no runs yet</span>
  return (
    <span className="flex min-w-0 items-center gap-1" title={full(run.firedAt)}>
      <RunIcon status={run.status} />
      <span className="truncate">
        {run.status === 'running'
          ? `running · ${formatDuration(Math.max(0, now - run.firedAt))}`
          : `${statusLabel(run.status)} ${ago(run.finishedAt ?? run.firedAt, now)}`}
      </span>
    </span>
  )
}

function AutomationRow({
  automation,
  now,
  expanded,
  onExpand,
  onEdit,
  onDeleted,
  refetch,
}: {
  automation: Automation
  now: number
  expanded: boolean
  onExpand: (expanded: boolean) => void
  onEdit: (opener: HTMLElement | null) => void
  onDeleted: () => void
  refetch: () => unknown
}) {
  const [pending, setPending] = useState<boolean>()
  const [busy, setBusy] = useState<'run' | 'delete'>()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string>()
  const menu = useRef<HTMLButtonElement>(null)
  const afterMenu = useRef<() => void>(undefined)
  const described = useWords(automation.schedule, now)
  const running = automation.runs.some((run) => run.status === 'running')
  const kept = automation.runs.filter((run) => run.conversationId !== undefined).length
  const passed = !automation.enabled && spent(automation, now)
  const act = async (work: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await work()
    } catch (failure) {
      setError(errorMessage(failure).replace(/^automations\/\w+: /, ''))
    }
    await refetch()
  }
  const toggle = (enabled: boolean) => {
    setPending(enabled)
    void act(() => api.action(enabled ? ResumeAction : PauseAction, { id: automation.id })).finally(
      () => setPending(undefined),
    )
  }
  const runNow = () => {
    setBusy('run')
    onExpand(true)
    void act(() => api.action(RunAction, { id: automation.id })).finally(() => setBusy(undefined))
  }
  const remove = () => {
    setBusy('delete')
    void act(async () => {
      await api.action(DeleteAction, { id: automation.id })
      onDeleted()
    }).finally(() => setBusy(undefined))
  }
  const checked = pending ?? automation.enabled
  return (
    <li
      aria-label={automation.name}
      className="border-b border-border/50 last:border-b-0"
      data-automation={automation.id}
    >
      <div className="flex items-start gap-3 px-3 pt-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span
              className={cn(
                'truncate text-[13px]',
                automation.enabled ? 'text-foreground' : 'text-foreground/70',
              )}
              title={automation.prompt}
            >
              {automation.name}
            </span>
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/60">
              {automation.id}
            </span>
            {automation.agent && <Tag>{automation.agent}</Tag>}
          </div>
          <p
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={raw(automation.schedule)}
          >
            {described}
          </p>
        </div>
        <span className="mt-0.5">
          <Switch
            busy={pending !== undefined}
            checked={checked}
            disabled={passed}
            aria-label={`Enable ${automation.name}`}
            onCheckedChange={toggle}
            title={
              passed
                ? 'Its one time has passed: edit the time, then switch it on'
                : checked
                  ? 'Pause: no new runs until resumed; a running run finishes'
                  : 'Resume the schedule'
            }
          />
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 px-3 pt-0.5 font-mono text-[11px] text-muted-foreground">
        <Next automation={automation} now={now} />
        <span className="text-muted-foreground/40">·</span>
        <Last now={now} run={automation.runs.at(-1)} />
      </div>
      <div className="flex items-center gap-0.5 px-1.5 pt-1 pb-1.5">
        <Button
          aria-expanded={expanded}
          className="h-6 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => onExpand(!expanded)}
          size="xs"
          variant="ghost"
        >
          <ChevronRightIcon
            className={cn('size-3 transition-transform', expanded && 'rotate-90')}
          />
          {automation.runs.length} run{automation.runs.length === 1 ? '' : 's'}
          {running && <BusyDot className="ml-0.5" />}
        </Button>
        <Button
          className="ml-auto h-6 gap-1 px-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
          disabled={busy !== undefined || running}
          onClick={runNow}
          size="xs"
          title={
            running ? 'A run is still working' : 'Start a run now; the schedule stays as it is'
          }
          variant="ghost"
        >
          <PlayIcon className="size-3" />
          {busy === 'run' ? 'Starting…' : 'Run now'}
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`More for ${automation.name}`}
              className="size-6 text-muted-foreground hover:text-foreground data-[state=open]:bg-accent"
              ref={menu}
              size="icon-xs"
              variant="ghost"
            >
              <EllipsisIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40"
            onCloseAutoFocus={(event) => {
              const next = afterMenu.current
              afterMenu.current = undefined
              if (!next) return
              event.preventDefault()
              next()
            }}
          >
            <DropdownMenuItem
              className="text-[12.5px]"
              onSelect={() => (afterMenu.current = () => onEdit(menu.current))}
            >
              <PencilIcon />
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-[12.5px]"
              onSelect={() => (afterMenu.current = () => setConfirming(true))}
              variant="destructive"
            >
              <Trash2Icon />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {confirming && (
        <div
          className="mx-3 mb-2 flex flex-col gap-1.5 rounded-md border border-error/40 bg-error/6 px-2.5 py-2"
          role="group"
          aria-label={`Delete ${automation.name}`}
        >
          <p className="text-[12px] leading-snug text-foreground/90">
            Delete <span className="font-medium">{automation.name}</span>? Future runs stop.{' '}
            {kept
              ? `Its ${kept} run conversation${kept === 1 ? ' is' : 's are'} kept.`
              : 'Run conversations are always kept.'}
          </p>
          <div className="flex justify-end gap-1.5">
            <Button
              autoFocus
              className="h-6 text-[11.5px]"
              onClick={() => {
                setConfirming(false)
                menu.current?.focus()
              }}
              size="xs"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              className="h-6 text-[11.5px] text-error hover:bg-error/10 hover:text-error"
              disabled={busy === 'delete'}
              onClick={remove}
              size="xs"
              variant="outline"
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="flex items-start gap-1.5 px-3 pb-2 font-mono text-[11px] leading-snug text-error">
          <CircleAlertIcon className="mt-px size-3 shrink-0" />
          {error}
        </p>
      )}
      {expanded && <Runs now={now} runs={automation.runs} />}
    </li>
  )
}

/**
 * Every automation of the project, newest first: its schedule in words, next and last run, an enable switch, Run now,
 * Edit and Delete, and its past runs, each a conversation to open. Refetched as the automation tasks change.
 */
export function AutomationsPanel() {
  const list = useAction(ListAction, null, { onError: () => {} })
  const { refetch } = list
  const ui = useUltimate()
  const extensionsPanel = useCommands().some((command) => command.id === 'onboarding.extensions')
  const [expanded, setExpanded] = useExtensionUiState<string[]>('expanded', [])
  const [form, setForm] = useState<{ open: boolean; key: number; automation?: Automation }>({
    open: false,
    key: 0,
  })
  const newButton = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const automations = (list.data ?? []).toSorted((a, b) => b.createdAt - a.createdAt)
  // A second's resolution while something is about to fire or running, else a quieter clock.
  const soon = automations.some(
    (automation) =>
      automation.runs.some((run) => run.status === 'running') ||
      (automation.nextAt !== undefined && automation.nextAt - Date.now() < 120000),
  )
  const now = useNow(soon ? 1000 : 15000)
  useLive(
    refetch,
    automations.some(
      (automation) =>
        automation.enabled && automation.nextAt !== undefined && now - automation.nextAt > 1500,
    ),
    now,
  )
  const create = (from: HTMLElement | null) => {
    opener.current = from
    setForm((previous) => ({ open: true, key: previous.key + 1 }))
  }
  const paused = automations.filter(
    (automation) => !automation.enabled && !spent(automation, now),
  ).length
  return (
    <div className="pb-4">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
        <Heading
          className="min-w-0 flex-1"
          meta={
            automations.length > 0 && (
              <>
                {automations.length}
                {paused > 0 && ` · ${paused} paused`}
              </>
            )
          }
        >
          Automations
        </Heading>
        {automations.length > 0 && (
          <Button
            className="-mr-1.5 h-6 gap-1 px-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
            onClick={(event) => create(event.currentTarget)}
            ref={newButton}
            size="xs"
            variant="ghost"
          >
            <PlusIcon className="size-3.5" />
            New
          </Button>
        )}
      </div>
      {list.error && !list.data ? (
        <div className="px-3 py-3">
          <p className="flex items-start gap-1.5 font-mono text-[11.5px] leading-snug text-error">
            <CircleAlertIcon className="mt-px size-3 shrink-0" />
            {list.error.message.replace(/^automations\/list: /, '')}
          </p>
          {/subagents/.test(list.error.message) && extensionsPanel && (
            <Button
              className="mt-2 h-7 text-[12px]"
              onClick={() => ui.openPanel('extensions')}
              size="sm"
              variant="outline"
            >
              Open Extensions
            </Button>
          )}
        </div>
      ) : !list.data ? (
        <p className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">loading…</p>
      ) : automations.length === 0 ? (
        <div className="flex flex-col items-center px-6 pt-8 pb-6 text-center">
          <TimerIcon className="size-5 text-muted-foreground/60" />
          <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
            Automations run a prompt on a schedule, and every run is a conversation you can open.
          </p>
          <Button
            className="mt-3.5 h-7 gap-1.5 text-[12px]"
            onClick={(event) => create(event.currentTarget)}
            ref={newButton}
            size="sm"
            variant="outline"
          >
            <PlusIcon className="size-3.5" />
            New automation
          </Button>
        </div>
      ) : (
        <ul className="border-t border-border/50">
          {automations.map((automation) => (
            <AutomationRow
              automation={automation}
              expanded={expanded.includes(automation.id)}
              key={automation.id}
              now={now}
              onDeleted={() => {
                setExpanded((previous) => previous.filter((id) => id !== automation.id))
                requestAnimationFrame(() => newButton.current?.focus())
              }}
              onEdit={(from) => {
                opener.current = from
                setForm((previous) => ({ open: true, key: previous.key + 1, automation }))
              }}
              onExpand={(open) =>
                setExpanded((previous) =>
                  open
                    ? [...new Set([...previous, automation.id])]
                    : previous.filter((id) => id !== automation.id),
                )
              }
              refetch={refetch}
            />
          ))}
        </ul>
      )}
      <AutomationForm
        automation={form.automation}
        key={form.key}
        onClosed={() => {
          const target = opener.current?.isConnected ? opener.current : newButton.current
          target?.focus()
        }}
        onOpenChange={(open) => setForm((previous) => ({ ...previous, open }))}
        onSaved={() => void refetch()}
        open={form.open}
      />
    </div>
  )
}
