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
  useConversations,
  useSystem,
  useTasks,
  useUltimate,
} from '@/sdk'
import type { ConversationSummary } from '@/sdk'
import type { Workspace } from '../../shared/protocol.ts'

type WorkspaceInfo = Workspace & { ahead: number | null }

/** A saved landing is historical, never proof that the current branch tip is applied. */
const stateLabel = (workspace: Workspace) =>
  workspace.state === 'discarded'
    ? 'Removed'
    : workspace.preparation === 'pending'
      ? 'Setting up…'
      : workspace.preparation === 'error'
        ? 'Setup failed'
        : 'Ready'

function WorkspaceCard({ conversation }: { conversation: ConversationSummary }) {
  const actions = useUltimate()
  const shown = useConversation().id === conversation.id
  const [open, setOpen] = useState(shown)
  const [pending, setPending] = useState<'land' | 'discard'>()
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()
  const system = useSystem()
  const supported = system?.execution.workspaces === true
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
  const recorded = conversation.workspace!
  const workspace =
    info.data &&
    info.data.state === recorded.state &&
    info.data.preparation === recorded.preparation &&
    info.data.landed === recorded.landed
      ? info.data
      : recorded
  useEffect(() => {
    if (shown) setOpen(true)
  }, [shown])
  useEffect(() => {
    if (open && supported) void info.refetch()
  }, [
    recorded.state,
    recorded.preparation,
    recorded.landed,
    conversation.busy,
    open,
    supported,
    info.refetch,
  ])
  const mutate = async (operation: 'land' | 'discard') => {
    if (!supported) return
    setPending(operation)
    setError(undefined)
    setMessage(undefined)
    try {
      await api.action(
        'workspaces',
        operation,
        {
          id: conversation.id,
          ...(operation === 'discard' ? { confirm: true } : {}),
        },
        { conversationId: conversation.id },
      )
      setMessage(
        operation === 'land'
          ? 'Landing completed. Refresh details before another operation.'
          : 'Checkout removed. Branch and history kept.',
      )
      setConfirming(false)
      await info.refetch()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(undefined)
    }
  }
  const disabled =
    !supported ||
    busy ||
    pending !== undefined ||
    workspace.state === 'discarded' ||
    workspace.preparation === 'pending'
  const fields = [
    ['Path', workspace.path],
    ['Branch', workspace.branch],
    ['Source', workspace.source],
    ['Target', workspace.targetBranch ?? `Detached @ ${workspace.targetHead ?? workspace.base}`],
    ...(workspace.landed ? [['Last landed', workspace.landed]] : []),
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
            disabled={info.loading || !supported}
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
                <button
                  aria-label={`Copy ${label.toLowerCase()} of W${conversation.id}`}
                  className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    void navigator.clipboard.writeText(value).then(
                      () => setMessage(`${label} copied.`),
                      (failure: unknown) => setError(errorMessage(failure)),
                    )
                  }
                  type="button"
                >
                  <CopyIcon className="size-3" />
                </button>
              </dd>
            </div>
          ))}
        </dl>
        {workspace.landed && (
          <p className="text-muted-foreground">
            Last landed is a saved SHA, not a claim that the current tip is applied.
          </p>
        )}
        {info.data?.ahead !== undefined && info.data.ahead !== null && (
          <p className="text-muted-foreground">
            {info.data.ahead} commit{info.data.ahead === 1 ? '' : 's'} ahead of the source checkout.
          </p>
        )}
        {busy && (
          <p role="status" className="text-muted-foreground">
            Conversation is busy. Wait for its run to settle or stop it before changing the
            checkout.
          </p>
        )}
        {workspace.preparation === 'pending' && workspace.state !== 'discarded' && (
          <p role="status" className="text-muted-foreground">
            Setup is pending. Refresh to check progress; do not send input until Ready.
          </p>
        )}
        {workspace.preparation === 'error' && workspace.state !== 'discarded' && (
          <p role="alert" className="text-error break-words">
            {workspace.error ?? 'Workspace setup failed.'} Refresh details, then remove the clean
            checkout or create a new isolated conversation.
          </p>
        )}
        {!supported && (
          <p role="status" className="text-muted-foreground">
            Upgrade and restart the core to manage workspaces.
          </p>
        )}
        {(error || info.error) && (
          <p role="alert" className="text-error break-words">
            {error ?? info.error?.message} Resolve the reported blocker, then refresh and retry. No
            force cleanup is available.
          </p>
        )}
        {message && (
          <p role="status" className="text-muted-foreground">
            {message}
          </p>
        )}
        {workspace.state !== 'discarded' &&
          (confirming ? (
            <div className="space-y-2 rounded-md border border-border/70 p-3">
              <p>
                Remove only this clean checkout? The branch, commits and conversation history stay.
                Uncommitted changes, active dependents and previews prevent removal.
              </p>
              <div className="flex gap-2">
                <Button
                  className="cursor-pointer"
                  disabled={pending !== undefined}
                  onClick={() => setConfirming(false)}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  className="cursor-pointer"
                  disabled={disabled}
                  onClick={() => void mutate('discard')}
                  size="sm"
                  variant="outline"
                >
                  {pending === 'discard' ? 'Removing…' : 'Confirm clean-only removal'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                className="cursor-pointer"
                disabled={disabled || workspace.preparation !== 'ready'}
                onClick={() => void mutate('land')}
                size="sm"
                variant="outline"
              >
                {pending === 'land' ? 'Landing…' : 'Land verified tip'}
              </Button>
              <Button
                className="cursor-pointer"
                disabled={disabled}
                onClick={() => setConfirming(true)}
                size="sm"
                variant="ghost"
              >
                Remove checkout…
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
      <p className="border-b border-border/60 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        Isolated checkouts, including empty and archived drafts. Archive and clear context never
        remove a checkout or commits.
      </p>
      {conversations.length ? (
        conversations
          .toSorted((a, b) => b.id - a.id)
          .map((conversation) => (
            <WorkspaceCard conversation={conversation} key={conversation.id} />
          ))
      ) : (
        <p className="px-4 py-4 text-xs text-muted-foreground">
          No isolated workspaces. Use New → New isolated conversation to opt in.
        </p>
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
