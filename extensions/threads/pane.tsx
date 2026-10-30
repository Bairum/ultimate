import { cn } from 'cn'
import {
  ArrowLeftIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import {
  api,
  Composer,
  ComposerRedirect,
  formatAgo,
  ThreadView,
  useConversation,
  useNow,
  useUltimate,
} from '@/sdk'
import { FeatureTag, useOverview } from '../conversations/ui.tsx'
import {
  ease,
  reduced,
  tones,
  useInset,
  useLayout,
  useOpenThread,
  usePulse,
  useSeeing,
  useThread,
  useThreads,
  useToggle,
  useVariant,
} from './model.tsx'
import type { Variant } from './model.tsx'
import { Dot } from './roots.tsx'
import { reply } from './threads.tsx'

const duration = 340

/** Over @ultimate's conversation: the open thread, as a right column, a left rail of every thread, or a phone's sheet. */
export function Threads() {
  const found = useThreads()
  const layout = useLayout()
  if (!found) return null
  if (layout === 'rail') return <Rail />
  return <Pane sheet={layout === 'sheet'} />
}

// ---- (A) right pane ------------------------------------------------------------------------------------------------

/** The open thread as a column on the right; main's column moves left to make room. On a phone, a sheet over main. */
function Pane({ sheet }: { sheet: boolean }) {
  const [open, setOpen] = useOpenThread()
  // The last thread stays mounted while its column leaves.
  const [shown, setShown] = useState<number | null>(open)
  if (open !== null && shown !== open) setShown(open)
  useEffect(() => {
    if (open !== null) return undefined
    const timer = setTimeout(() => setShown(null), duration + 40)
    return () => clearTimeout(timer)
  }, [open])
  const [pane, setPane] = useState(420)
  const { ref, width } = useInset({ left: 0, right: open !== null && !sheet ? pane : 0 })
  const fit = Math.round(Math.min(512, Math.max(360, width * 0.4)))
  if (width && fit !== pane) setPane(fit)
  const still = reduced()
  const away = sheet ? 'translateY(104%)' : 'translateX(24px)'
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" ref={ref}>
      {shown !== null && (
        <aside
          aria-label="Thread"
          className={cn(
            'absolute flex flex-col overflow-hidden bg-background',
            open !== null && 'pointer-events-auto',
            sheet
              ? 'inset-x-0 top-0 bottom-0 shadow-2xl shadow-black/40'
              : 'top-0 right-0 bottom-0 border-l border-border/70',
          )}
          data-thread-pane={shown}
          inert={open === null}
          style={{
            width: sheet ? undefined : pane,
            transition: still
              ? `opacity ${duration}ms ease`
              : `transform ${duration}ms ${ease}, opacity ${duration}ms ease`,
            transform: open !== null || still ? 'none' : away,
            opacity: open !== null ? 1 : 0,
          }}
        >
          <ThreadHead id={shown} onClose={() => setOpen(null)} sheet={sheet} />
          <ThreadBody id={shown} />
        </aside>
      )}
    </div>
  )
}

/** A thread's header: where it stands, what it is, the way out. */
function ThreadHead({
  id,
  onClose,
  sheet,
  children,
}: {
  id: number
  onClose: () => void
  sheet?: boolean
  children?: ReactNode
}) {
  const shown = useThread(id)
  const feature = useOverview()[id]?.feature
  const tone = shown && tones[shown.tone]
  return (
    <header className="@container/thread flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3 font-mono text-[11px] text-muted-foreground">
      {sheet ? (
        <button
          className="-ml-1 flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 py-1 text-foreground hover:bg-accent"
          onClick={onClose}
          type="button"
        >
          <ArrowLeftIcon className="size-3.5" />
          @ultimate
        </button>
      ) : (
        <MessageSquareIcon className="size-3.5 shrink-0 text-brand" />
      )}
      {feature && <FeatureTag className="shrink-0" feature={feature} />}
      <span className="min-w-0 truncate font-sans text-[13px] font-semibold text-foreground">
        {shown?.title ?? `#${id}`}
      </span>
      {shown && tone && (
        <span className={cn('flex shrink-0 items-center gap-1.5', tone.text)}>
          <Dot tone={shown.tone} />
          <span className="@max-[26rem]/thread:hidden">{tone.word}</span>
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {children}
        {!sheet && <VariantSwitch />}
        <OpenBranch id={id} />
        {!sheet && (
          <button
            aria-label="Close thread"
            className="flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            onClick={onClose}
            title="Close thread"
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </span>
    </header>
  )
}

/** Opens the branch itself, with a dot while it works. */
function OpenBranch({ id }: { id: number }) {
  const { switchConversation } = useUltimate()
  return (
    <button
      aria-label={`Open branch #${id}`}
      className="flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      onClick={() => switchConversation(id)}
      title={`Open branch #${id}`}
      type="button"
    >
      <SquareArrowOutUpRightIcon className="size-3.5" />
    </button>
  )
}

/** A thread's story, and a composer whose words go to @ultimate about it. */
function ThreadBody({ id }: { id: number }) {
  const self = useConversation((conversation) => conversation.id)
  const shown = useThread(id)
  useSeeing(id, shown?.newest)
  return (
    <ThreadView thread={id}>
      <ComposerRedirect
        to={{
          placeholder: `Reply about #${id}…`,
          send: (text) => api.submit(reply(id, text), 'followUp', self),
        }}
      >
        <Composer dock />
      </ComposerRedirect>
    </ThreadView>
  )
}

/** Which way threads show on a wide screen, for this round of previews. */
function VariantSwitch() {
  const [variant, setVariant] = useVariant()
  const other: Variant = variant === 'pane' ? 'rail' : 'pane'
  const Icon = other === 'rail' ? PanelLeftIcon : PanelRightIcon
  return (
    <button
      aria-label={`Show threads as a ${other === 'rail' ? 'left rail' : 'right pane'}`}
      className="flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      data-thread-variant={variant}
      onClick={() => setVariant(other)}
      title={`Show threads as a ${other === 'rail' ? 'left rail' : 'right pane'}`}
      type="button"
    >
      <Icon className="size-3.5" />
    </button>
  )
}

// ---- (B) left rail -------------------------------------------------------------------------------------------------

const RAIL = 248
const WIDE = 448

/**
 * Every thread as a compact row in a rail left of main's column, newest activity on top; a click opens that thread in
 * place, the rail widening around it and main moving right to make room.
 */
function Rail() {
  const found = useThreads()!
  const [open, setOpen] = useOpenThread()
  const [wide, setWide] = useState(WIDE)
  const width = open !== null ? wide : RAIL
  const { ref, width: region } = useInset({ left: width, right: 0 })
  const fit = Math.round(Math.min(WIDE + 64, Math.max(WIDE - 64, region * 0.38)))
  if (region && fit !== wide) setWide(fit)
  const still = reduced()
  const order = found.threads.threads.toSorted((a, b) => b.last - a.last)
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" ref={ref}>
      <nav
        aria-label="Threads"
        className="pointer-events-auto absolute top-0 bottom-0 left-0 flex flex-col overflow-hidden border-r border-border/50 bg-background"
        data-thread-rail={open ?? 'closed'}
        style={{
          width,
          transition: still ? undefined : `width ${duration}ms ${ease}`,
        }}
      >
        <header className="@container/thread flex h-11 shrink-0 items-center gap-2 px-3 font-mono text-[11px] text-muted-foreground">
          <MessageSquareIcon className="size-3.5 shrink-0" />
          Threads
          <span className="text-muted-foreground/60">{order.length}</span>
          <span className="ml-auto flex items-center gap-1">
            <VariantSwitch />
          </span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pb-2">
          {order.length === 0 && (
            <p className="px-2 py-1 font-mono text-[11px] leading-relaxed text-muted-foreground/70">
              Features @ultimate starts get a thread here.
            </p>
          )}
          {order.map((thread) =>
            thread.id === open ? (
              <section
                className="-mx-1.5 flex min-h-[18rem] flex-1 flex-col border-y border-border/60 bg-background"
                data-thread-pane={open}
                key={thread.id}
              >
                <ThreadHead id={open} onClose={() => setOpen(null)} />
                <ThreadBody id={open} />
              </section>
            ) : (
              <RailRow id={thread.id} key={thread.id} />
            ),
          )}
        </div>
      </nav>
    </div>
  )
}

/** One thread in the rail: where it stands, the feature, its title, what is new; its newest line under it. */
function RailRow({ id }: { id: number }) {
  const shown = useThread(id)
  const toggle = useToggle()
  const now = useNow(30_000)
  const feature = useOverview()[id]?.feature
  const ref = useRef<HTMLButtonElement>(null)
  usePulse(ref, shown?.newest)
  if (!shown) return null
  return (
    <button
      className="group flex w-full min-w-0 shrink-0 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      data-thread-root={id}
      data-unread={shown.fresh > 0 || undefined}
      onClick={() => toggle(id, shown.newest)}
      ref={ref}
      title={`${shown.title ?? `#${id}`} · ${tones[shown.tone].word}`}
      type="button"
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <Dot tone={shown.tone} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px]',
            shown.fresh ? 'font-semibold text-foreground' : 'text-foreground/80',
          )}
        >
          {shown.title ?? `#${id}`}
        </span>
        {shown.fresh > 0 && (
          <span className="shrink-0 rounded-full bg-brand px-1.5 font-mono text-[10px] leading-4 text-brand-foreground tabular-nums">
            {shown.fresh}
          </span>
        )}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 pl-3 font-mono text-[10.5px] text-muted-foreground/80">
        {feature && <FeatureTag className="min-w-0" feature={feature} />}
        {shown.writing ? (
          <Shimmer as="span">@ultimate writing…</Shimmer>
        ) : (
          <span className={cn('shrink-0', tones[shown.tone].text)}>{tones[shown.tone].word}</span>
        )}
        {shown.at !== undefined && (
          <span className="ml-auto shrink-0">{formatAgo(shown.at, now)}</span>
        )}
      </span>
    </button>
  )
}
