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
  useEvent,
  useUltimate,
} from '@/sdk'
import {
  stateLabel,
  useLanderQueue,
  useWorkspaceConversations as useConversations,
  useWorkspaces,
} from './data.tsx'
import type { WorkspaceConversation as ConversationSummary } from './data.tsx'
import { LandingCard } from './landing.tsx'
import { LanderAskEntry, LanderLogEntry, LanderReport, WorkspaceCall } from './log.tsx'
import type { WorkspaceDisk, WorkspaceInfo, WorkspaceStats } from './types.ts'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { ConversationRef } from '../conversations/feature.tsx'
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
  const ui = useUltimate()
  const check = useAction<{ reason?: string }>('workspaces', 'isolation', {})
  useEvent('onboarding:git', () => void check.refetch())
  const { reason } = check.data ?? {}
  if (target !== 'new') return null
  const isolated = isolation ?? (!reason && creation !== 'shared')
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
          // Without Git the switch cannot turn on; the label opens onboarding's Git card instead.
          onClick={reason ? () => ui.open('onboarding.git') : undefined}
        >
          <GitBranchIcon className={cn('size-3.5', isolated && 'text-brand')} />
          Isolated
          <Switch
            aria-label="Isolated"
            checked={isolated}
            disabled={isolation !== undefined || !!reason}
            className="ml-0.5"
            onCheckedChange={(on) => setCreation(on ? 'isolated' : 'shared')}
          />
        </label>
      </TooltipTrigger>
      <TooltipContent>
        {reason
          ? isolated
            ? reason
            : `${reason}, so it shares this folder · click to set up`
          : isolated
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
  const info = useAction<WorkspaceInfo | null>(
    'workspaces',
    'info',
    { id: conversation.id },
    {
      enabled: false,
      onError: () => undefined,
    },
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
  const { refetch } = info
  useEffect(() => {
    if (open) void refetch()
  }, [recorded.state, recorded.landed, conversation.busy, open, refetch])
  const ahead = info.data?.ahead
  const fields = [
    ['Path', workspace.path],
    ['Branch', workspace.branch],
    ['Target', `${workspace.target} in ${workspace.source}`],
    ...(typeof ahead === 'number' ? [['Ahead', `${ahead} commit${ahead === 1 ? '' : 's'}`]] : []),
    ...(workspace.landed ? [['Last landed', workspace.landed.slice(0, 7)]] : []),
  ]
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
        {workspace.state === 'failed' && (
          <p role="alert" className="break-words whitespace-pre-wrap text-error">
            {workspace.error}
          </p>
        )}
        {info.error && (
          <p role="alert" className="break-words whitespace-pre-wrap text-error">
            {info.error.message}
          </p>
        )}
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
            <ConversationRef className="max-w-1/2 font-mono" id={item.conversationId} />
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
  const { refetch: refetchDisk } = disk
  const states = Object.entries(records)
    .map(([id, workspace]) => `${id}:${workspace.state}:${workspace.landed ?? ''}`)
    .join()
  useEffect(() => {
    void refetch()
  }, [states, refetch])
  useEffect(() => {
    const refresh = () => {
      void refetch()
      void refetchDisk()
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refetch, refetchDisk])
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

/** The lander queue, the statistics, and the shown conversation's checkout. */
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
