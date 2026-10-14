import {
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  GitBranchIcon,
  GitForkIcon,
  LoaderCircleIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import {
  api,
  cn,
  useAction,
  defineWebExtension,
  errorMessage,
  events,
  getConversation,
  getState,
  useComposer,
  useDialog,
  useDoc,
  useSystem,
  useUiState,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, UltimateActions } from '@/sdk'

type BranchState = {
  from: number
  at: number
  intent: string
  status: 'briefing' | 'ready' | 'failed'
  error?: string
}

const branchDialog = 'lineage.branch'
let target: { from?: number; at?: number } = {}

/** Open the Branch dialog for `from` at entry `at` (default: its latest entry). */
export function openBranch(
  actions: Pick<UltimateActions, 'open'>,
  from: { from: number; at?: number },
) {
  target = from
  actions.open(branchDialog)
}

function userText(entry: EntryRecord) {
  const message = entry.model?.[0]
  if (message?.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

/** The source's marker of a branch started from it: a quiet divider that opens the branch. */
function Branched({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { branch, intent } = entry.data as { branch: number; intent: string }
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70 hover:text-foreground"
      data-lineage-branched={branch}
      onClick={() => switchConversation(branch)}
      title={`Open #${branch}`}
      type="button"
    >
      <span className="flex max-w-[70%] min-w-0 items-center gap-1.5">
        <GitForkIcon className="size-3 shrink-0" />
        <span className="shrink-0">Branched → #{branch}</span>
        <span className="truncate">· {intent}</span>
      </span>
    </button>
  )
}

/** A conversation this one asked `notify` about has finished: its title and last answer. */
function Finished({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { from, title, text } = entry.data as { from: number; title?: string; text: string }
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-success/70 bg-muted/20"
      data-lineage-finished={from}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <CircleCheckIcon className="size-3.5 shrink-0 text-success" />
        <button
          className="min-w-0 cursor-pointer truncate text-left text-foreground hover:underline"
          onClick={() => switchConversation(from)}
          title={`Open #${from}`}
          type="button"
        >
          #{from} finished{title ? ` · ${title}` : ''}
        </button>
      </header>
      <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </section>
  )
}

function LandingNote({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const {
    from,
    sha,
    target: branch,
    title,
    commits,
    paths,
    more,
  } = entry.data as {
    from: number
    sha: string
    target: string
    title: string
    commits: { sha: string; subject: string }[]
    paths: string[]
    more: number
  }
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-success/70 bg-muted/20"
      data-lineage-note="lander"
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px]">
        <CheckIcon className="size-3.5 shrink-0 text-success" />
        <span className="shrink-0">Landed {sha.slice(0, 7)} ·</span>
        <button
          className="min-w-0 cursor-pointer truncate text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => switchConversation(from)}
          title={`Open #${from}`}
          type="button"
        >
          #{from} {title}
        </button>
      </header>
      <div className="space-y-2 px-3 py-2.5 font-mono text-[11px]">
        <div className="text-muted-foreground">on {branch}</div>
        <div>
          {commits.map((commit) => (
            <div className="flex gap-2" key={commit.sha}>
              <span className="shrink-0 text-muted-foreground">{commit.sha.slice(0, 7)}</span>
              <span className="min-w-0 break-words">{commit.subject}</span>
            </div>
          ))}
          {more > 0 && <div className="text-muted-foreground">and {more} more</div>}
        </div>
        {paths.length > 0 && (
          <div className="break-words text-muted-foreground">Changed: {paths.join(', ')}</div>
        )}
      </div>
    </section>
  )
}

/** A note another conversation (or the lander) left here. */
function Note({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { from, text, source } = entry.data as {
    from?: number
    text: string
    source?: 'lander' | 'finished' | 'main'
  }
  if (source === 'lander') return <LandingNote entry={entry} />
  if (source === 'finished') return <Finished entry={entry} />
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/50 bg-muted/20"
      data-lineage-note="note"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {source === 'main' ? (
          <GitBranchIcon className="size-3.5 text-brand" />
        ) : (
          <StickyNoteIcon className="size-3.5 text-brand" />
        )}
        <span className="text-foreground">{source === 'main' ? 'Main catch-up' : 'Note from'}</span>
        {from !== undefined && (
          <button
            className="cursor-pointer text-foreground hover:underline"
            onClick={() => switchConversation(from)}
            title={`Open #${from}`}
            type="button"
          >
            #{from}
          </button>
        )}
      </header>
      <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </section>
  )
}

/** A branch's brief, which starts its context: collapsible like a compaction. */
function Brief({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const { switchConversation } = useUltimate()
  const lineage = (entry.data as { lineage?: { from: number; at: number } } | undefined)?.lineage
  if (!lineage) return core
  const brief = userText(entry)
    .replace(/^<brief[^>]*>\n/, '')
    .replace(/\n<\/brief>$/, '')
  return (
    <Collapsible
      className="group/brief rounded-lg border border-brand/30 bg-brand/5"
      data-lineage-brief={lineage.from}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/brief:rotate-90" />
          Branched from
          <span
            className="cursor-pointer hover:underline"
            onClick={(event) => {
              event.stopPropagation()
              switchConversation(lineage.from)
            }}
            role="link"
          >
            #{lineage.from}
          </span>
          · brief
        </span>
        <span className="text-xs text-muted-foreground">
          This conversation starts from a brief of #{lineage.from} up to entry {lineage.at}. Earlier
          messages remain available above.
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        <MessageResponse>{brief}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Under the composer of a branch: the brief being written, or why it failed. */
function BriefStatus() {
  return useComposer().target === 'new' ? null : <BriefLookup />
}

/**
 * Asks once whether the shown conversation is a branch still waiting for its brief, and only then subscribes to its
 * `lineage.branch` document: a first subscription reconnects the event stream, which every other conversation is
 * spared.
 */
function BriefLookup() {
  const { conversationId } = useUltimate()
  const info = useAction<{ root: number; branch?: BranchState }>(
    'lineage',
    'info',
    { id: conversationId ?? null },
    { enabled: conversationId !== undefined },
  )
  const status = info.data?.branch?.status
  return status && status !== 'ready' ? <BranchBrief /> : null
}

function BranchBrief() {
  const { conversationId } = useUltimate()
  const branch = useDoc<{ branch?: BranchState }>('lineage.branch')?.branch
  const [retrying, setRetrying] = useState(false)
  if (!branch || branch.status === 'ready') return null
  if (branch.status === 'briefing')
    return (
      <span
        className="flex shrink-0 items-center gap-1.5 text-brand"
        data-lineage-status="briefing"
      >
        <LoaderCircleIcon className="size-3 animate-spin" />
        Writing the brief from #{branch.from}…
      </span>
    )
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-error" data-lineage-status="failed">
      <TriangleAlertIcon className="size-3 shrink-0" />
      <span className="truncate" title={branch.error}>
        Brief failed: {branch.error}
      </span>
      <button
        className="shrink-0 cursor-pointer rounded px-1 text-foreground hover:bg-muted disabled:opacity-50"
        disabled={retrying}
        onClick={() => {
          setRetrying(true)
          void api
            .action('lineage', 'retry', { id: conversationId ?? null })
            .finally(() => setRetrying(false))
        }}
        type="button"
      >
        Retry
      </button>
    </span>
  )
}

function BranchDialog() {
  const [open, setOpen] = useDialog(branchDialog)
  const actions = useUltimate()
  const system = useSystem()
  const [creation, setCreation] = useUiState<string>('ext.conversations.creationType', 'isolated')
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const canIsolate = !!system?.extensions.some(
    (extension) => extension.name === 'workspaces' && extension.enabled,
  )
  const isolated = canIsolate && creation !== 'shared'
  const from = target.from ?? actions.conversationId
  const close = () => {
    setOpen(false)
    setError(undefined)
  }
  const branch = async () => {
    if (!prompt.trim() || pending) return
    setPending(true)
    setError(undefined)
    try {
      const { id } = await api.action<{ id: number }>('lineage', 'branch', {
        prompt,
        isolated,
        ...(from === undefined ? {} : { from }),
        ...(target.at === undefined ? {} : { at: target.at }),
      })
      setPrompt('')
      close()
      actions.switchConversation(id)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog onOpenChange={(next) => (next ? setOpen(true) : close())} open={open}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
        <div className="px-5 pt-5 pb-4">
          <DialogTitle className="flex items-center gap-2 text-[14px] font-medium">
            <GitForkIcon className="size-4 text-brand" />
            Branch from #{from ?? '?'}
            {target.at !== undefined && (
              <span className="font-mono text-[12px] text-muted-foreground">at {target.at}</span>
            )}
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] leading-relaxed">
            A new conversation starts from a brief of this one, aimed at what you write here.
          </DialogDescription>
          <textarea
            autoFocus
            className="mt-3 min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void branch()
              }
            }}
            placeholder="What should the branch do?"
            rows={4}
            value={prompt}
          />
          {error && <p className="mt-3 font-mono text-[12px] break-words text-error">{error}</p>}
        </div>
        <div className="flex items-center gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
          {canIsolate && (
            <label
              className={cn(
                'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors',
                isolated
                  ? 'border-brand/60 bg-brand/15 text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <GitBranchIcon className={cn('size-3.5', isolated && 'text-brand')} />
              Isolated
              <Switch
                aria-label="Isolated"
                checked={isolated}
                className="ml-0.5"
                onCheckedChange={(on) => setCreation(on ? 'isolated' : 'shared')}
              />
            </label>
          )}
          <Button className="ml-auto" onClick={close} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button disabled={pending || !prompt.trim()} onClick={() => void branch()} size="sm">
            {pending ? 'Branching…' : 'Branch'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** A top-level conversation: shown, and not a subagent or other owned conversation. */
function topLevel() {
  const { id } = getConversation()
  const summary = getState().conversations.find((conversation) => conversation.id === id)
  return id !== undefined && summary?.parentConversationId === undefined
}

export default defineWebExtension({
  entries: {
    'lineage.branched': Branched,
    'lineage.note': Note,
    'lineage.finished': Finished,
    'pi.reset': Brief,
  },
  slots: { 'composer.status': [BriefStatus], overlay: [BranchDialog] },
  commands: [
    {
      id: 'lineage.branch-at',
      title: 'Branch from here',
      group: 'Conversations',
      when: (context) => context.entryId !== undefined,
      run: (context) => {
        if (context.conversationId !== undefined && context.entryId !== undefined)
          openBranch(context, { from: context.conversationId, at: context.entryId })
      },
    },
    {
      id: 'lineage.branch',
      title: 'Branch…',
      group: 'Conversations',
      when: () => getConversation().id !== undefined,
      run: (context) => {
        const { id } = getConversation()
        if (id !== undefined) openBranch(context, { from: id })
      },
    },
    {
      id: 'lineage.root',
      title: 'Make this the root',
      group: 'Conversations',
      when: topLevel,
      run: async () => {
        const { id } = getConversation()
        if (id !== undefined) {
          await api.action('lineage', 'root', { id })
          events.emit('lineage:root-changed', { root: id })
        }
      },
    },
  ],
})
