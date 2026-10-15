import {
  ChevronRightIcon,
  CircleCheckIcon,
  GitBranchIcon,
  GitForkIcon,
  LoaderCircleIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  api,
  useAction,
  defineWebExtension,
  events,
  getConversation,
  getState,
  getUiState,
  NewConversationComposer,
  useComposer,
  useCommands,
  useDialog,
  useDoc,
  useEvent,
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

/** A note another conversation (or the lander) left here. */
function Note({ entry, core }: { entry: EntryRecord; core: React.ReactNode }) {
  const { switchConversation } = useUltimate()
  const { from, text, source } = entry.data as {
    from?: number
    text: string
    source?: 'lander' | 'finished' | 'main'
  }
  if (source === 'lander') return core
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
  const info = useAction<{ roots: number[]; root?: number; branch?: BranchState }>(
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

function BranchAction({ entry }: { entry: EntryRecord }) {
  const actions = useUltimate()
  const branch = useCommands().find((command) => command.id === 'lineage.branch-at')
  if (!branch) return null
  return (
    <button
      aria-label="Branch from here"
      title="Branch from here"
      className="cursor-pointer rounded p-0.5 transition-colors hover:text-foreground"
      onClick={() =>
        void branch.run({
          ...actions,
          conversationId: entry.conversationId,
          entryId: entry.id,
        })
      }
      type="button"
    >
      <GitBranchIcon className="size-3" />
    </button>
  )
}

function BranchDialog() {
  const [open, setOpen] = useDialog(branchDialog)
  const actions = useUltimate()
  const from = target.from ?? actions.conversationId
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="gap-3 sm:max-w-xl">
        <DialogTitle className="flex items-center gap-2 text-[14px] font-medium">
          <GitForkIcon className="size-4 text-brand" />
          Branch from #{from ?? '?'}
          {target.at !== undefined && (
            <span className="font-mono text-[12px] text-muted-foreground">at {target.at}</span>
          )}
        </DialogTitle>
        <DialogDescription className="text-[13px]">
          A new conversation starts from a brief of this one, aimed at what you write here.
        </DialogDescription>
        <NewConversationComposer
          branch={{
            ...(from === undefined ? {} : { from }),
            ...(target.at === undefined ? {} : { at: target.at }),
          }}
          onStarted={(id) => {
            setOpen(false)
            actions.switchConversation(id)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** The project's roots as last read, for the synchronous `when` of "Make this a root". */
let roots: number[] = []
function Roots() {
  const info = useAction<{ roots: number[] }>('lineage', 'info')
  useEvent('lineage:roots-changed', () => void info.refetch())
  useEffect(() => {
    if (info.data) roots = info.data.roots
  }, [info.data])
  return null
}

/** The shown conversation, when it is top-level (not a subagent or other owned conversation) and not a branch. */
function topLevel() {
  const { id } = getConversation()
  const summary = getState().conversations.find((conversation) => conversation.id === id)
  return id !== undefined && summary?.parentConversationId === undefined && !summary?.branchOf
}

/** Where a branch starts by default: the shown tree's root, else the most recently active root. */
async function defaultRoot() {
  const { id } = getConversation()
  const info = await api.action<{ roots: number[]; root?: number }>(
    'lineage',
    'info',
    id === undefined ? null : { id },
  )
  if (info.root !== undefined) return info.root
  const { conversations } = getState()
  const inputAt = (root: number) =>
    conversations.find((conversation) => conversation.id === root)?.inputAt ?? 0
  return info.roots.toSorted((a, b) => inputAt(b) - inputAt(a) || b - a)[0]
}

export default defineWebExtension({
  start: async ({ root, ...draft }) => {
    const isolated =
      draft.isolated ??
      (getUiState('ext.conversations.creationType') !== 'shared' &&
        getState().system?.extensions.some((extension) => extension.name === 'workspaces') === true)
    if (root) {
      const { from: _from, at: _at, ...input } = draft
      const started = await api.action<{ id: number }>('lineage', 'newRoot', { ...input, isolated })
      events.emit('lineage:roots-changed', {})
      return started
    }
    const from = draft.from ?? (await defaultRoot())
    if (from === undefined) throw new Error('There is no root to branch from')
    return api.action<{ id: number }>('lineage', 'branch', { ...draft, from, isolated })
  },
  entries: {
    'lineage.branched': Branched,
    'lineage.note': Note,
    'lineage.finished': Finished,
    'pi.reset': Brief,
  },
  slots: { 'composer.status': [BriefStatus], overlay: [BranchDialog, Roots] },
  messageActions: [BranchAction],
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
      id: 'lineage.add-root',
      title: 'Make this a root',
      group: 'Conversations',
      when: () => topLevel() && !roots.includes(getConversation().id!),
      run: async () => {
        const { id } = getConversation()
        if (id !== undefined) {
          roots = (await api.action<{ roots: number[] }>('lineage', 'root', { id })).roots
          events.emit('lineage:roots-changed', { roots })
        }
      },
    },
  ],
})
