import { ChevronRightIcon, CopyIcon, GitBranchIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  api,
  defineWebExtension,
  errorMessage,
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
} from './data.tsx'
import type { WorkspaceConversation as ConversationSummary } from './data.tsx'
import { LanderLogEntry, WorkspaceCall } from './log.tsx'
import type { WorkspaceInfo } from './types.ts'

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
        aria-label={`Workspace W${conversation.id}`}
      >
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <span className="shrink-0 font-mono">W{conversation.id}</span>
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
            aria-label={`Refresh W${conversation.id}`}
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
                    aria-label={`Copy ${label.toLowerCase()} of W${conversation.id}`}
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
            <span className="shrink-0 font-mono">W{item.conversationId}</span>
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

function WorkspacesPanel() {
  const conversations = useConversations().filter((conversation) => conversation.workspace)
  const [removing, setRemoving] = useState(false)
  const [removed, setRemoved] = useState<{ error?: boolean; text: string }>()
  const removeLanded = async () => {
    setRemoving(true)
    setRemoved(undefined)
    try {
      setRemoved(await api.action<{ text: string }>('workspaces', 'removeLanded', {}))
    } catch (error) {
      setRemoved({ error: true, text: errorMessage(error) })
    } finally {
      setRemoving(false)
    }
  }
  return (
    <div className="flex flex-col pb-4">
      <LanderQueue />
      {(removed ||
        conversations.some((conversation) => conversation.workspace!.state === 'ready')) && (
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-xs">
          <span
            className={`min-w-0 flex-1 truncate ${removed?.error ? 'text-error' : 'text-muted-foreground'}`}
            role={removed?.error ? 'alert' : 'status'}
          >
            {removed?.text}
          </span>
          <Button
            className="cursor-pointer"
            disabled={removing}
            onClick={() => void removeLanded()}
            size="sm"
            title="Remove clean, idle checkouts whose commits are already on their target"
            variant="ghost"
          >
            {removing ? 'Removing…' : 'Remove landed'}
          </Button>
        </div>
      )}
      {conversations.length ? (
        conversations
          .toSorted((a, b) => b.id - a.id)
          .map((conversation) => (
            <WorkspaceCard conversation={conversation} key={conversation.id} />
          ))
      ) : (
        <p className="px-4 py-4 text-xs text-muted-foreground">No isolated conversations yet.</p>
      )}
    </div>
  )
}

export default defineWebExtension({
  tools: { workspace: WorkspaceCall },
  entries: { 'ultimate.lander': LanderLogEntry },
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
