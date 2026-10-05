import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  EllipsisIcon,
  EraserIcon,
  PencilIcon,
  SquarePenIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  formatKeys,
  getConversation,
  getState,
  useConversations,
  useDialog,
  useExtensionUiState,
  useNow,
  useStore,
  useUltimate,
} from '@/sdk'
import type { ConversationSummary, UltimateActions } from '@/sdk'

const newKeys = 'mod+alt+n'
const resetDialog = 'conversations.reset'

/** The shown conversation, also while its snapshot is still on the way. */
const useShownId = () => useStore((state) => state.view?.conversation.id ?? state.requested)

/** The top-level conversation above `id` by parent links, or `id`'s own summary when it is top-level. */
function topOf(id: number | undefined, conversations: readonly ConversationSummary[]) {
  let current = conversations.find((conversation) => conversation.id === id)
  while (current?.parentConversationId !== undefined) {
    const parent = current.parentConversationId
    current = conversations.find((conversation) => conversation.id === parent)
  }
  return current
}

/** Why a top-level conversation is working: its own run, or only runs of conversations below it. */
function workingByTop(conversations: readonly ConversationSummary[]) {
  const working = new Map<number, 'self' | 'subagents'>()
  for (const conversation of conversations) {
    if (!conversation.busy) continue
    const top = topOf(conversation.id, conversations)
    if (!top) continue
    working.set(top.id, top.id === conversation.id ? 'self' : (working.get(top.id) ?? 'subagents'))
  }
  return working
}

/** The empty draft first, then by latest input, newest first. */
const byInput = (a: ConversationSummary, b: ConversationSummary) =>
  (b.inputAt ?? Infinity) - (a.inputAt ?? Infinity) || b.id - a.id

/** `now`, `5m`, `3h`, `2d`, then a short date. */
function ago(at: number, now: number) {
  const minutes = Math.max(0, (now - at) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${Math.floor(minutes)}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / 60 / 24)}d`
  const date = new Date(at)
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', year: '2-digit' },
  )
}

/** Focus the composer once conversation `id` has rendered and no dialog (the palette) holds focus any longer. */
function focusWhenShown(actions: UltimateActions, id: number, deadline = Date.now() + 5000) {
  requestAnimationFrame(() => {
    if (getConversation().id === id && !document.querySelector('[role="dialog"]'))
      actions.focusComposer()
    else if (Date.now() < deadline) focusWhenShown(actions, id, deadline)
  })
}

/**
 * Show an empty conversation on the Agent surface, the composer focused: the shown draft, else an empty, untitled,
 * idle one nobody archived, else a new one. It takes the shown conversation's model and thinking level, not a
 * subagent's.
 */
async function newConversation(actions: UltimateActions) {
  const { conversations, shared, models } = getState()
  const shown = getConversation()
  actions.showSurface('agent')
  const current = conversations.find((conversation) => conversation.id === shown.id)
  const topLevel = current !== undefined && current.parentConversationId === undefined
  // The replica, not the lagging summary: right after a first send, the shown conversation is no draft any longer.
  if (topLevel && shown.entries.length === 0) {
    focusWhenShown(actions, current.id)
    return
  }
  const archived = shared?.['ext.conversations.archived']
  const reusable = conversations
    .filter(
      (conversation) =>
        conversation.parentConversationId === undefined &&
        conversation.inputAt === undefined &&
        conversation.title === undefined &&
        !conversation.busy &&
        !(Array.isArray(archived) && archived.includes(conversation.id)),
    )
    .toSorted((a, b) => b.id - a.id)[0]
  const id = reusable?.id ?? (await api.createConversation()).id
  const { model, thinkingLevel } = shown.agent
  // A level the model does not support fails the whole call; without one, the server clamps the current level.
  const levels = models?.models.find(
    (candidate) => candidate.provider === model?.provider && candidate.id === model.modelId,
  )?.thinkingLevels
  if (topLevel && model)
    await api
      .configure(
        { model, ...(thinkingLevel && levels?.includes(thinkingLevel) && { thinkingLevel }) },
        id,
      )
      .catch(() => undefined)
  actions.switchConversation(id)
  focusWhenShown(actions, id)
}

/** The conversation the clear-context dialog asks about; set just before it opens. */
let resetTarget: number | undefined
function openReset(actions: Pick<UltimateActions, 'open'>, id: number) {
  resetTarget = id
  actions.open(resetDialog)
}

function Shortcut({ keys }: { keys: string }) {
  return (
    <KbdGroup>
      {formatKeys(keys)[0]?.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </KbdGroup>
  )
}

/** The leading mark: working (pulsing), an unseen answer (solid), or an empty slot that keeps titles aligned. */
function Mark({ working, unseen }: { working?: 'self' | 'subagents'; unseen: boolean }) {
  const label = working ? (working === 'self' ? 'Working' : 'Subagents working') : 'New answer'
  return (
    <span className="flex size-3 shrink-0 items-center justify-center">
      {(working || unseen) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={label}
              className={cn('size-1.5 rounded-full bg-brand', working && 'animate-pulse-dot')}
              role="img"
            />
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

/** One top-level conversation: click shows it; the menu renames, clears, archives or unarchives it. */
function Row({
  conversation,
  shown,
  draft,
  working,
  unseen,
  archived,
  now,
  onArchive,
}: {
  conversation: ConversationSummary
  shown: boolean
  draft: boolean
  working?: 'self' | 'subagents'
  unseen: boolean
  archived: boolean
  now: number
  onArchive: (archive: boolean) => void
}) {
  const actions = useUltimate()
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)
  /** Whether the row button takes focus back once the field closes: after Enter or Escape, not a click elsewhere. */
  const refocus = useRef(false)
  /** What a menu item does once the menu has closed, so focus lands where it should. */
  const afterMenu = useRef<() => void>(undefined)
  const name = conversation.title ?? (draft ? 'New conversation' : `#${conversation.id}`)
  const latest = Math.max(conversation.inputAt ?? 0, conversation.answerAt ?? 0)
  const rename = () => {
    cancelled.current = false
    setEditing(true)
  }
  const save = (value: string) => {
    setEditing(false)
    if (cancelled.current) return
    const title = value.trim()
    if (title === (conversation.title ?? '')) return
    void api.action('conversations', 'rename', { id: conversation.id, title })
  }
  const title = (
    <span
      className={cn(
        'min-w-0 flex-1 truncate text-[13px]',
        conversation.title || !draft
          ? shown
            ? 'text-foreground'
            : 'text-foreground/85'
          : 'text-muted-foreground',
      )}
      onDoubleClick={draft ? undefined : rename}
      title={name}
    >
      {name}
    </span>
  )
  return (
    <div
      className={cn(
        'group relative mx-2 flex h-7 items-center rounded-md transition-colors',
        shown ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
      )}
      data-conversation={conversation.id}
    >
      {editing ? (
        <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-1.5">
          <Mark unseen={unseen} working={working} />
          <input
            aria-label="Conversation title"
            autoFocus
            className="h-6 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            defaultValue={conversation.title ?? ''}
            onBlur={(event) => save(event.currentTarget.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                // Without it, the keypress lands on the refocused row button and opens the row.
                event.preventDefault()
                refocus.current = true
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                cancelled.current = true
                refocus.current = true
                event.currentTarget.blur()
              }
            }}
          />
        </div>
      ) : (
        <button
          aria-current={shown ? 'true' : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-2 pl-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => actions.switchConversation(conversation.id)}
          ref={(element) => {
            if (!element || !refocus.current) return
            refocus.current = false
            element.focus()
          }}
          type="button"
        >
          <Mark unseen={unseen} working={working} />
          {title}
          {latest > 0 && (
            <span
              className="shrink-0 font-mono text-[10.5px] text-muted-foreground/80 group-focus-within:invisible group-hover:invisible group-has-[[data-state=open]]:invisible"
              title={new Date(latest).toLocaleString()}
            >
              {ago(latest, now)}
            </span>
          )}
        </button>
      )}
      {!draft && !editing && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label="Conversation actions"
            className="invisible absolute right-1 flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within:visible group-hover:visible hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:visible data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
          >
            <EllipsisIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-44"
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
              onSelect={() => (afterMenu.current = rename)}
            >
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-[12.5px]"
              disabled={conversation.busy}
              onSelect={() => (afterMenu.current = () => openReset(actions, conversation.id))}
            >
              <EraserIcon />
              Clear context…
            </DropdownMenuItem>
            <DropdownMenuItem className="text-[12.5px]" onSelect={() => onArchive(!archived)}>
              {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {archived ? 'Unarchive' : 'Archive'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

/**
 * The project's top-level conversations that have a message, newest input first, under the shown one when it is an
 * empty draft; archived ones in a collapsed group at the bottom.
 */
function Conversations() {
  const conversations = useConversations()
  const actions = useUltimate()
  const shownId = useShownId()
  const now = useNow(60_000)
  const [archived, setArchived] = useExtensionUiState<number[]>('archived', [])
  const [seen] = useExtensionUiState<Record<string, number>>('seen', {})
  const shownTop = topOf(shownId, conversations)
  const working = workingByTop(conversations)
  const topLevel = conversations.filter(
    (conversation) => conversation.parentConversationId === undefined,
  )
  const listed = topLevel
    .filter(
      (conversation) =>
        !archived.includes(conversation.id) &&
        (conversation.inputAt !== undefined || conversation.id === shownTop?.id),
    )
    .toSorted(byInput)
  const hidden = topLevel
    .filter((conversation) => archived.includes(conversation.id))
    .toSorted(byInput)

  const setArchive = (id: number, archive: boolean) => {
    setArchived((previous) => [
      ...previous.filter((candidate) => candidate !== id),
      ...(archive ? [id] : []),
    ])
    if (!archive || id !== shownTop?.id) return
    const index = listed.findIndex((conversation) => conversation.id === id)
    const next = listed[index + 1] ?? listed[index - 1]
    if (next) actions.switchConversation(next.id)
  }
  const row = (conversation: ConversationSummary) => {
    const recorded = seen[conversation.id]
    const state = working.get(conversation.id)
    return (
      <Row
        archived={archived.includes(conversation.id)}
        conversation={conversation}
        draft={conversation.inputAt === undefined}
        key={conversation.id}
        now={now}
        onArchive={(archive) => setArchive(conversation.id, archive)}
        shown={conversation.id === shownTop?.id}
        unseen={
          recorded !== undefined &&
          (conversation.answerAt ?? 0) > recorded &&
          conversation.id !== shownId &&
          state === undefined
        }
        working={state}
      />
    )
  }

  return (
    <div className="flex flex-1 flex-col pb-2">
      <div className="mb-1 flex h-10 shrink-0 items-center gap-2 border-b border-border/70 pr-1.5 pl-4 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Conversations
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="New conversation"
              className="ml-auto size-7 text-muted-foreground hover:text-foreground"
              onClick={() => actions.runCommand('conversations.new')}
              size="icon"
              variant="ghost"
            >
              <SquarePenIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-2">
            New conversation
            <Shortcut keys={newKeys} />
          </TooltipContent>
        </Tooltip>
      </div>
      <nav aria-label="Conversations" className="flex flex-col gap-px">
        {listed.map(row)}
      </nav>
      {hidden.length > 0 && (
        <Collapsible className="mt-auto pt-3">
          <CollapsibleTrigger className="group/archived flex w-full items-center gap-1 px-4 py-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground">
            <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/archived:rotate-90" />
            Archived · {hidden.length}
          </CollapsibleTrigger>
          <CollapsibleContent
            aria-label="Archived"
            className="flex flex-col gap-px pt-1"
            role="region"
          >
            {hidden.map(row)}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

/** Records the answer the user has seen: the shown top-level conversation's latest, once it is idle. */
function Seen() {
  const id = useShownId()
  const summary = useConversations().find((conversation) => conversation.id === id)
  const [seen, setSeen] = useExtensionUiState<Record<string, number>>('seen', {})
  const answerAt =
    summary && summary.parentConversationId === undefined && !summary.busy
      ? (summary.answerAt ?? 0)
      : undefined
  useEffect(() => {
    if (id === undefined || answerAt === undefined || seen[id] === answerAt) return
    setSeen((previous) => ({ ...previous, [id]: answerAt }))
  }, [id, answerAt, seen, setSeen])
  return null
}

/** Asks before a context reset, from the row menu or the command; a failure stays in the dialog. */
function ResetDialog() {
  const [open, setOpen] = useDialog(resetDialog)
  const conversation = useConversations().find((candidate) => candidate.id === resetTarget)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const close = () => {
    setOpen(false)
    setError(undefined)
  }
  const confirm = async () => {
    setPending(true)
    setError(undefined)
    try {
      await api.action('conversations', 'reset', { id: resetTarget ?? null })
      close()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog onOpenChange={(next) => (next ? setOpen(true) : close())} open={open}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        <div className="px-5 pt-5 pb-4">
          <DialogTitle className="text-[14px] font-medium">Clear the context</DialogTitle>
          <DialogDescription className="mt-2 text-[13px] leading-relaxed break-words">
            Clear the context of{' '}
            <span className="text-foreground">
              {conversation?.title ?? `#${resetTarget ?? '?'}`}
            </span>
            ? The agent starts fresh; the history stays stored.
          </DialogDescription>
          {error && <p className="mt-3 font-mono text-[12px] break-words text-error">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
          <Button onClick={close} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button disabled={pending || conversation?.busy} onClick={() => void confirm()} size="sm">
            {pending ? 'Clearing…' : 'Clear context'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default defineWebExtension({
  slots: { sidebar: Conversations, overlay: [ResetDialog, Seen] },
  commands: [
    {
      id: 'conversations.new',
      title: 'New conversation',
      keys: newKeys,
      group: 'Conversations',
      run: (context) => newConversation(context),
    },
    {
      id: 'conversations.reset',
      title: 'Clear the context',
      group: 'Conversations',
      when: () => {
        const { id, busy, entries } = getConversation()
        const summary = getState().conversations.find((conversation) => conversation.id === id)
        return (
          id !== undefined &&
          !busy &&
          entries.length > 0 &&
          summary?.parentConversationId === undefined
        )
      },
      run: (context) => {
        const { id } = getConversation()
        if (id !== undefined) openReset(context, id)
      },
    },
  ],
})
