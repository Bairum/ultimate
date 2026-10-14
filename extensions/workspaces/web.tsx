import { ChevronRightIcon, CopyIcon, GitBranchIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  cn,
  useComposer,
  useUiState,
  defineWebExtension,
  formatBytes,
  useAction,
  useConversation,
  useTasks,
  useUltimate,
} from '@/sdk'
import {
  stateLabel,
  useLanderQueue,
  useWorkspaceAction,
  useWorkspaceConversations as useConversations,
  useWorkspaces,
} from './data.tsx'
import type { WorkspaceConversation as ConversationSummary } from './data.tsx'
import { LandingCard } from './landing.tsx'
import { LanderAskEntry, LanderLogEntry, LanderReport, WorkspaceCall } from './log.tsx'
import type { WorkspaceDisk, WorkspaceInfo, WorkspaceStats } from './types.ts'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { Row, Rows } from '../info/rows.tsx'

/** The lander's note in the root: the landing's card, from the note's own data. */
function LandingNote({ entry }: { entry: EntryRecord }) {
  const { from, sha, target, title, summary, feature, commits, paths, more, pushed } =
    entry.data as {
      from: number
      sha: string
      target: string
      title?: string
      summary?: string
      feature?: string
      commits: { sha: string; subject: string }[]
      paths: string[]
      more: number
      pushed?: string
    }
  return (
    <div data-lineage-note="lander">
      <LandingCard
        from={from}
        headline={`Landed ${sha.slice(0, 7)} on ${target}${pushed ? ` · pushed to ${pushed}` : ''}`}
        subject={{
          ...(title ? { title } : {}),
          ...(summary ? { summary } : {}),
          ...(feature ? { feature } : {}),
        }}
        tone="landed"
      >
        <ul className="space-y-0.5">
          {commits.map((commit) => (
            <li className="truncate" key={commit.sha} title={commit.subject}>
              <span className="text-muted-foreground">{commit.sha.slice(0, 7)}</span>{' '}
              {commit.subject}
            </li>
          ))}
          {more > 0 && <li className="text-muted-foreground">and {more} more</li>}
        </ul>
        {paths.length > 0 && (
          <p className="break-words text-muted-foreground">Changed: {paths.join(', ')}</p>
        )}
      </LandingCard>
    </div>
  )
}

function IsolationToggle() {
  const { target, isolated: isolation } = useComposer()
  const [creation, setCreation] = useUiState<string>('ext.conversations.creationType', 'isolated')
  if (target !== 'new') return null
  const isolated = isolation ?? creation !== 'shared'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label
          className={cn(
            'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors',
            isolated
              ? 'border-brand/60 bg-brand/15 text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          data-isolated={isolated}
        >
          <GitBranchIcon className={cn('size-3.5', isolated && 'text-brand')} />
          Isolated
          <Switch
            aria-label="Isolated"
            checked={isolated}
            disabled={isolation !== undefined}
            className="ml-0.5"
            onCheckedChange={(on) => setCreation(on ? 'isolated' : 'shared')}
          />
        </label>
      </TooltipTrigger>
      <TooltipContent>
        {isolated
          ? 'New isolated conversation: its own Git checkout'
          : 'New shared conversation, in this checkout'}
      </TooltipContent>
    </Tooltip>
  )
}

function WorkspaceCard({ conversation }: { conversation: ConversationSummary }) {
  const actions = useUltimate()
  const shown = useConversation().id === conversation.id
  const [open, setOpen] = useState(shown)
  const [confirming, setConfirming] = useState(false)
  const tasks = useTasks()
  const busy =
    conversation.busy ||
    Object.values(tasks?.tasks ?? {}).some(
      (task) => task.conversationId === conversation.id && !task.background,
    )
  const info = useAction<WorkspaceInfo | null>(
    'workspaces',
    'info',
    { id: conversation.id },
    {
      enabled: false,
      onError: () => undefined,
    },
  )
  const { pending, outcome, land, submit, remove } = useWorkspaceAction(
    conversation.id,
    info.refetch,
  )
  const queued = useLanderQueue().find((item) => item.conversationId === conversation.id)
  const recorded = conversation.workspace!
  const workspace =
    info.data && info.data.state === recorded.state && info.data.landed === recorded.landed
      ? info.data
      : recorded
  useEffect(() => {
    if (shown) setOpen(true)
  }, [shown])
  useEffect(() => {
    if (open) void info.refetch()
  }, [recorded.state, recorded.landed, conversation.busy, open, info.refetch])
  const disabled =
    busy ||
    pending !== undefined ||
    workspace.state === 'removed' ||
    workspace.state === 'preparing'
  const ahead = info.data?.ahead
  const fields = [
    ['Path', workspace.path],
    ['Branch', workspace.branch],
    ['Target', `${workspace.target} in ${workspace.source}`],
    ...(typeof ahead === 'number' ? [['Ahead', `${ahead} commit${ahead === 1 ? '' : 's'}`]] : []),
    ...(workspace.landed ? [['Last landed', workspace.landed.slice(0, 7)]] : []),
  ]
  const error = outcome?.error ? outcome.text : info.error?.message
  return (
    <Collapsible
      className="border-b border-border/60"
      data-workspace={conversation.id}
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        className="group flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-xs"
        aria-label={`Workspace #${conversation.id}`}
      >
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <span className="shrink-0 font-mono">#{conversation.id}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {conversation.title ?? 'Isolated draft'}
        </span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground">
          {queued ? (queued.state === 'landing' ? 'Landing…' : 'Queued') : stateLabel(recorded)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-4 pb-4 text-xs">
        <div className="flex items-center gap-2">
          <Button
            className="cursor-pointer"
            onClick={() => actions.switchConversation(conversation.id)}
            size="sm"
            variant="outline"
          >
            Open conversation
          </Button>
          <Button
            aria-label={`Refresh #${conversation.id}`}
            className="ml-auto cursor-pointer"
            disabled={info.loading}
            onClick={() => void info.refetch()}
            size="icon"
            variant="ghost"
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        <dl className="space-y-2">
          {fields.map(([label, value]) => (
            <div key={label}>
              <dt className="text-[10.5px] text-muted-foreground">{label}</dt>
              <dd className="flex items-start gap-2">
                <span className="min-w-0 flex-1 font-mono text-[11px] break-all select-text">
                  {value}
                </span>
                {(label === 'Path' || label === 'Branch') && (
                  <button
                    aria-label={`Copy ${label.toLowerCase()} of #${conversation.id}`}
                    className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => void navigator.clipboard.writeText(value)}
                    type="button"
                  >
                    <CopyIcon className="size-3" />
                  </button>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {busy && (
          <p role="status" className="text-muted-foreground">
            Conversation is running.
          </p>
        )}
        {workspace.state === 'failed' && (
          <p role="alert" className="break-words whitespace-pre-wrap text-error">
            {workspace.error}
          </p>
        )}
        {error && (
          <p role="alert" className="break-words whitespace-pre-wrap text-error">
            {error}
          </p>
        )}
        {outcome && !outcome.error && (
          <p role="status" className="text-muted-foreground">
            {outcome.text}
          </p>
        )}
        {workspace.state !== 'removed' &&
          (confirming ? (
            <div className="space-y-2 rounded-md border border-border/70 p-3">
              <p>Remove this checkout? Its branch and commits stay.</p>
              <div className="flex gap-2">
                <Button
                  className="cursor-pointer"
                  onClick={() => setConfirming(false)}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  className="cursor-pointer"
                  disabled={disabled}
                  onClick={() => {
                    setConfirming(false)
                    void remove()
                  }}
                  size="sm"
                  variant="outline"
                >
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!conversation.parentConversationId && conversation.ownerTaskId === undefined && (
                <Button
                  className="cursor-pointer"
                  disabled={
                    pending !== undefined || workspace.state !== 'ready' || queued !== undefined
                  }
                  onClick={() => void submit()}
                  size="sm"
                  variant="outline"
                >
                  {pending === 'submit' ? 'Submitting…' : 'Submit'}
                </Button>
              )}
              <Button
                className="cursor-pointer"
                disabled={disabled || workspace.state !== 'ready'}
                onClick={() => void land()}
                size="sm"
                variant="ghost"
              >
                {pending === 'land' ? 'Landing…' : 'Land'}
              </Button>
              <Button
                className="cursor-pointer"
                disabled={disabled}
                onClick={() => setConfirming(true)}
                size="sm"
                variant="ghost"
              >
                {pending === 'discard' ? 'Removing…' : 'Remove…'}
              </Button>
            </div>
          ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The lander's queue, oldest first: what each submission waits for or is doing now. */
function LanderQueue() {
  const queue = useLanderQueue()
  if (!queue.length) return null
  return (
    <section aria-label="Lander queue" className="border-b border-border/60 px-4 py-3 text-xs">
      <h3 className="mb-2 text-[10.5px] text-muted-foreground">Lander queue</h3>
      <ol className="space-y-1">
        {queue.map((item) => (
          <li className="flex items-center gap-2" key={item.id}>
            <span className="shrink-0 font-mono">#{item.conversationId}</span>
            <span className="shrink-0 font-mono text-muted-foreground">{item.tip.slice(0, 7)}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {item.state === 'landing' ? (item.step ?? 'landing') : `queued for ${item.target}`}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

const parts = (entries: [number, string][]) =>
  entries
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(' · ') || 'none'

/** How many checkouts there are, what their commits are, and the disk they take. */
function Stats() {
  const records = useWorkspaces()
  const { data, error, refetch } = useAction<WorkspaceStats>('workspaces', 'stats')
  const disk = useAction<WorkspaceDisk>('workspaces', 'disk')
  const states = Object.entries(records)
    .map(([id, workspace]) => `${id}:${workspace.state}:${workspace.landed ?? ''}`)
    .join()
  useEffect(() => {
    void refetch()
  }, [states, refetch])
  useEffect(() => {
    const refresh = () => {
      void refetch()
      void disk.refetch()
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refetch, disk.refetch])
  if (error) return <p className="px-4 py-3 text-xs text-error">{error.message}</p>
  if (!data) return null
  return (
    <section aria-label="Workspace statistics" className="border-b border-border/60 px-4 py-3">
      <Rows>
        <Row label="checkouts">
          <span className="truncate">
            {data.total - data.removed}
            {data.removed > 0 && (
              <span className="text-muted-foreground/70"> · {data.removed} removed</span>
            )}
          </span>
        </Row>
        <Row label="state">
          <span className="truncate">
            {parts([
              [data.ready, 'ready'],
              [data.preparing, 'setting up'],
              [data.failed, 'failed'],
            ])}
          </span>
        </Row>
        <Row label="commits">
          <span className="truncate">
            {parts([
              [data.landed, 'landed'],
              [data.ahead, 'ahead'],
              [data.fresh, 'none yet'],
            ])}
          </span>
        </Row>
        <Row label="uncommitted">{data.dirty}</Row>
        <Row label="disk">
          <span
            className="truncate"
            title="Each checkout's blocks added up; copy-on-write checkouts share many of them"
          >
            {disk.data ? (
              disk.data.bytes === null ? (
                'unknown'
              ) : (
                formatBytes(disk.data.bytes)
              )
            ) : (
              <span className="text-muted-foreground/70">measuring…</span>
            )}
          </span>
        </Row>
        {disk.data?.real != null && (
          <Row label="real">
            <span className="truncate" title="Blocks shared between checkouts counted once (btrfs)">
              {formatBytes(disk.data.real)}
            </span>
          </Row>
        )}
      </Rows>
    </section>
  )
}

/** The lander queue, the statistics, and the shown conversation's checkout with its actions. */
function WorkspacesPanel() {
  const shownId = useConversation().id
  const shown = useConversations().find(
    (conversation) => conversation.id === shownId && conversation.workspace,
  )
  return (
    <div className="flex flex-col pb-4">
      <LanderQueue />
      <Stats />
      {shown ? (
        <WorkspaceCard conversation={shown} key={shown.id} />
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          The shown conversation has no checkout of its own.
        </p>
      )}
    </div>
  )
}

export default defineWebExtension({
  slots: { 'composer.toolbar': [IsolationToggle] },
  tools: { workspace: WorkspaceCall },
  entries: {
    'lineage.note': ({ entry, core }) =>
      (entry.data as { source?: string })?.source === 'lander' ? (
        <LandingNote entry={entry} />
      ) : (
        core
      ),
    'ultimate.lander': LanderLogEntry,
    'ultimate.lander-ask': LanderAskEntry,
    'workspaces.lander-report': LanderReport,
  },
  panels: [
    {
      id: 'workspaces',
      title: 'Workspaces',
      icon: GitBranchIcon,
      component: WorkspacesPanel,
      order: -7,
    },
  ],
})
