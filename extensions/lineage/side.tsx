import { GitBranchIcon, LoaderCircleIcon, MessagesSquareIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { api, cn, errorMessage, useConversation, useDocOf, useTranscript, useUltimate } from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { ConversationRef } from '../conversations/feature.tsx'
import { useSides } from './roots.tsx'
import { openStart } from './start.tsx'

type SideState = {
  root: number
  at: number
  ending?: 'note' | 'branch'
  ended?: 'note' | 'branch' | 'discard'
  branch?: number
}
type SideDoc = { side?: SideState }
const sideKind = 'lineage.side'
/** The label a side chat carries in the conversation list. */
export const sideLabel = 'side chat'

/** The composer's reading column, as the core lays it out. */
const column = (dock?: boolean) =>
  dock ? 'w-full px-4' : 'mx-auto w-full max-w-[46rem] px-3 sm:px-6'

/** Side chats this page ended: the roots' document can list them a moment longer, and must not reopen them. */
const ended = new Set<number>()

/**
 * A root with an open side chat shows it instead: the side chat's view is the tally as it was when it opened, then the
 * chat. It replaces the root's history entry, so Back leaves rather than returns to the redirect.
 */
export function SideRedirect() {
  const { conversationId, switchConversation } = useUltimate()
  const side = useSides()?.[String(conversationId)]
  useEffect(() => {
    if (side !== undefined && !ended.has(side)) switchConversation(side, { replace: true })
  }, [side, switchConversation])
  return null
}

/** A side chat's composer: the bar that ends it above it while open, a quiet line instead once it ended. */
export function SideComposer({ id, core, dock }: { id: number; core: ReactNode; dock?: boolean }) {
  const side = useDocOf<SideDoc>(id, sideKind)?.side
  if (!side) return core
  if (side.ended) return <SideEnded dock={dock} id={id} side={side} />
  return (
    <>
      <SideBar dock={dock} id={id} side={side} />
      {core}
    </>
  )
}

const label =
  'flex min-w-0 items-center gap-2 rounded-md border border-l-2 border-border border-l-brand/50 bg-muted/20 font-mono text-[11px] text-muted-foreground'

function SideBar({ id, side, dock }: { id: number; side: SideState; dock?: boolean }) {
  const { switchConversation } = useUltimate()
  const busy = useConversation((conversation) => conversation.busy)
  const [pending, setPending] = useState<'note' | 'discard'>()
  const [error, setError] = useState<string>()
  const ending = pending ?? side.ending
  const end = async (mode: 'note' | 'discard') => {
    setPending(mode)
    setError(undefined)
    ended.add(id)
    try {
      await api.action('lineage', 'endSide', { root: side.root, side: id, mode })
      switchConversation(side.root)
    } catch (failure) {
      ended.delete(id)
      setError(errorMessage(failure))
    } finally {
      setPending(undefined)
    }
  }
  const off = busy || ending !== undefined
  const why = busy ? 'Wait for the answer, or stop it' : undefined
  return (
    <div className={cn(column(dock), 'pb-1.5')}>
      <div className={cn(label, 'py-1 pr-1 pl-3')} data-lineage-side-bar={id}>
        <MessagesSquareIcon className="size-3.5 shrink-0 text-brand" />
        <span className="shrink-0 text-foreground">Side chat</span>
        <span className="shrink-0">· #{id}</span>
        {ending ? (
          <span className="flex min-w-0 items-center gap-1.5 truncate" role="status">
            <LoaderCircleIcon className="size-3 shrink-0 motion-safe:animate-spin" />
            {ending === 'discard' ? 'Discarding…' : 'Writing the note…'}
          </span>
        ) : (
          error && <span className="min-w-0 truncate text-error">{error}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          <Button
            className="font-mono text-[11px]"
            disabled={off}
            onClick={() => openStart({ from: side.root, side: id })}
            size="xs"
            title={why ?? 'Keep a note of it in the tally, then start a branch after it'}
            variant="ghost"
          >
            <GitBranchIcon />
            Branch…
          </Button>
          <Button
            className="font-mono text-[11px]"
            disabled={off}
            onClick={() => void end('note')}
            size="xs"
            title={why ?? 'Keep a note of what it settled in the tally'}
            variant="ghost"
          >
            Keep as note
          </Button>
          <Button
            className="font-mono text-[11px] hover:text-error"
            disabled={off}
            onClick={() => void end('discard')}
            size="xs"
            title={why ?? 'End it; the tally gets nothing'}
            variant="ghost"
          >
            Discard
          </Button>
        </span>
      </div>
    </div>
  )
}

function SideEnded({ id, side, dock }: { id: number; side: SideState; dock?: boolean }) {
  const { switchConversation } = useUltimate()
  const link = (to: number) => (
    <button
      className="flex min-w-0 cursor-pointer text-foreground hover:underline"
      onClick={() => switchConversation(to)}
      title={`Open #${to}`}
      type="button"
    >
      <ConversationRef id={to} />
    </button>
  )
  return (
    <div className={cn(column(dock), 'pb-3')}>
      <div className={cn(label, 'px-3 py-2')} data-lineage-side-ended={id}>
        <MessagesSquareIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">Side chat ended ·</span>
        {side.ended === 'discard' ? (
          'discarded'
        ) : side.ended === 'branch' && side.branch !== undefined ? (
          <>
            <span className="shrink-0">a note, then</span>
            {link(side.branch)}
          </>
        ) : (
          <>
            <span className="shrink-0">kept as a note in</span>
            {link(side.root)}
          </>
        )}
      </div>
    </div>
  )
}

/** `propose_branch` as the prompt it drafted, with the way to start it while the side chat is open. */
export function ProposeCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const id = useConversation((conversation) => conversation.id)
  const side = useDocOf<SideDoc>(id, sideKind)?.side
  if (call.status === 'error' || call.status === 'interrupted') return core
  const prompt = typeof call.args.prompt === 'string' ? call.args.prompt : ''
  const open = id !== undefined && side && !side.ended && !side.ending
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/50 bg-muted/20"
      data-lineage-proposal={id}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 py-1 pr-1 pl-3 font-mono text-[11px] text-muted-foreground">
        <GitBranchIcon className="size-3.5 shrink-0 text-brand" />
        <span className="text-foreground">Proposed branch</span>
        {open && (
          <Button
            className="ml-auto font-mono text-[11px]"
            onClick={() => openStart({ from: side.root, side: id }, { prompt })}
            size="xs"
            title="Keep a note of the side chat, then start this branch after it"
            variant="ghost"
          >
            Start branch…
          </Button>
        )}
      </header>
      <p className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap">
        {prompt}
      </p>
    </section>
  )
}

/** What a side chat left in the tally: its note, and the branch it ended in when it did. */
export function SideNote({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const transcript = useTranscript()
  const { from, text } = entry.data as { from: number; text: string }
  const started = transcript.find(
    (other) =>
      other.id > entry.id &&
      other.kind === 'lineage.branched' &&
      (other.data as { side?: number }).side === from,
  )
  const branch = (started?.data as { branch: number } | undefined)?.branch
  const open = (to: number) => (
    <button
      className="flex min-w-0 cursor-pointer text-foreground hover:underline"
      onClick={() => switchConversation(to)}
      title={`Open #${to}`}
      type="button"
    >
      <ConversationRef id={to} />
    </button>
  )
  return (
    <section
      className="min-w-0 rounded-md border border-border bg-muted/20"
      data-lineage-side-note={from}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <MessagesSquareIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">Side chat ·</span>
        {open(from)}
        {branch !== undefined && (
          <>
            <span className="shrink-0">→</span>
            {open(branch)}
          </>
        )}
      </header>
      <p className="min-w-0 px-3 py-2.5 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
        {text}
      </p>
    </section>
  )
}
