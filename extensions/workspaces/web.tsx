import { ChevronRightIcon, CopyIcon, GitBranchIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { defineWebExtension, useAction, useConversation, useTasks, useUltimate } from '@/sdk'
import {
  stateLabel,
  useWorkspaceAction,
  useWorkspaceConversations as useConversations,
} from './data.tsx'
import type { WorkspaceConversation as ConversationSummary } from './data.tsx'
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
  const { pending, outcome, land, remove } = useWorkspaceAction(conversation.id, info.refetch)
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
        <span className="shrink-0 text-[10.5px] text-muted-foreground">{stateLabel(recorded)}</span>
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
              <Button
                className="cursor-pointer"
                disabled={disabled || workspace.state !== 'ready'}
                onClick={() => void land()}
                size="sm"
                variant="outline"
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

function WorkspacesPanel() {
  const conversations = useConversations().filter((conversation) => conversation.workspace)
  return (
    <div className="flex flex-col pb-4">
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
