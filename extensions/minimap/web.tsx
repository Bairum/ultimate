import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  cn,
  defineWebExtension,
  useConversation,
  useConversations,
  useExtensionUiState,
  useViewport,
} from '@/sdk'
import { kindLabel, milestones, mockMarks } from './mock.tsx'
import type { Mark, MarkKind, Profile } from './mock.tsx'

type Variant = 'ticks' | 'list' | 'lanes'

/** Rough guess for the mock: @ultimate is the standing `agent`, owned conversations are workers, the rest coordinators. */
function useProfile(): Profile {
  const { id } = useConversation()
  const summary = useConversations().find((conversation) => conversation.id === id)
  if (summary?.parentConversationId !== undefined) return 'worker'
  if (summary?.label === 'agent' && summary.branchOf === undefined) return 'ultimate'
  return 'coordinator'
}

/** The transcript's scroller next to this overlay, and how far through it the reader is. */
function useScroller(root: RefObject<HTMLDivElement | null>) {
  const [view, setView] = useState({ top: 0, size: 1 })
  const scroller = () =>
    root.current?.parentElement?.querySelector<HTMLElement>('[role="log"] > div') ?? undefined
  useEffect(() => {
    const element = scroller()
    if (!element) return undefined
    const update = () => {
      const height = Math.max(1, element.scrollHeight)
      const top = element.scrollTop / height
      const size = element.clientHeight / height
      setView((view) => (view.top === top && view.size === size ? view : { top, size }))
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  })
  /** The mock jumps by order: mark `index` of `count` lands at the same share of the transcript. */
  const jump = (index: number, count: number) => {
    const element = scroller()
    if (!element) return
    const range = element.scrollHeight - element.clientHeight
    element.scrollTo({ top: (range * index) / Math.max(1, count - 1), behavior: 'smooth' })
  }
  return { view, jump }
}

/** One mark's glyph: shape and colour carry the kind, so a glance says what happened where. */
function Glyph({ kind, active }: { kind: MarkKind; active?: boolean }) {
  const bar = (width: string, tone: string) => (
    <span className={cn('block h-[2px] rounded-full', width, active ? 'bg-foreground' : tone)} />
  )
  switch (kind) {
    case 'user':
      return bar(active ? 'w-4' : 'w-3', 'bg-muted-foreground/70')
    case 'answer':
      return bar(active ? 'w-4' : 'w-2', 'bg-muted-foreground/30')
    case 'branch':
      return (
        <span
          className={cn(
            'block size-[7px] rotate-45 rounded-[1px] bg-brand',
            active && 'ring-2 ring-brand/40',
          )}
        />
      )
    case 'landed':
      return (
        <span
          className={cn(
            'block size-[7px] rounded-full bg-success',
            active && 'ring-2 ring-success/40',
          )}
        />
      )
    case 'failed':
      return (
        <span
          className={cn('block size-[7px] rounded-full bg-error', active && 'ring-2 ring-error/40')}
        />
      )
    case 'commit':
      return (
        <span
          className={cn(
            'block size-[7px] rounded-full border-[1.5px] border-success',
            active && 'bg-success',
          )}
        />
      )
    case 'preview':
      return (
        <span
          className={cn(
            'block size-[7px] rounded-[2px] border-[1.5px] border-note',
            active && 'bg-note',
          )}
        />
      )
    case 'subagent':
      return bar('w-2.5', 'bg-brand/50')
    case 'report':
      return bar('w-3.5', 'bg-brand/80')
    case 'screenshot':
      return (
        <span
          className={cn(
            'block size-[6px] rounded-[1px] border border-muted-foreground',
            active && 'bg-foreground',
          )}
        />
      )
    default:
      return <span className="block w-4 border-t border-dashed border-muted-foreground/60" />
  }
}

/** The floating label next to a mark: kind, time, and its line of text. */
function Tip({ mark, top }: { mark: Mark; top: number }) {
  return (
    <div
      className="pointer-events-none absolute right-7 z-20 w-64 -translate-y-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 shadow-md"
      style={{ top }}
    >
      <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
        <span className="flex w-4 justify-center">
          <Glyph kind={mark.kind} />
        </span>
        {kindLabel[mark.kind]}
        <span className="ml-auto">{mark.at}</span>
      </div>
      <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-popover-foreground">
        {mark.text}
      </div>
    </div>
  )
}

/** Turn the wheel over the rail into steps from mark to mark; the page does not scroll meanwhile. */
function useWheelSteps(element: RefObject<HTMLElement | null>, step: (delta: number) => void) {
  const latest = useRef(step)
  latest.current = step
  useEffect(() => {
    const target = element.current
    if (!target) return undefined
    let carry = 0
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      carry += event.deltaY
      // A notch is about 100 px on a mouse; a trackpad sends many small deltas.
      while (Math.abs(carry) >= 40) {
        latest.current(Math.sign(carry))
        carry -= Math.sign(carry) * 40
      }
    }
    target.addEventListener('wheel', onWheel, { passive: false })
    return () => target.removeEventListener('wheel', onWheel)
  }, [element])
}

const GAP = 7
const MAX_HEIGHT = 420

interface RailProps {
  marks: Mark[]
  profile: Profile
  view: { top: number; size: number }
  jump: (index: number) => void
}

/** Rows of the rail: one per mark, evenly spaced by order. */
function layout(count: number) {
  const gap = Math.max(3, Math.min(GAP, MAX_HEIGHT / Math.max(1, count)))
  return { gap, height: gap * count }
}

/** The current-view bracket along the rail. */
function ViewBand({ view, height }: { view: RailProps['view']; height: number }) {
  return (
    <span
      className="pointer-events-none absolute -right-1 w-[2px] rounded-full bg-foreground/25"
      style={{ top: view.top * height, height: Math.max(6, view.size * height) }}
    />
  )
}

/** Variant A: ticks only; hover or wheel shows one floating label. */
function Ticks({ marks, view, jump }: RailProps) {
  const rail = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<number>()
  const { gap, height } = layout(marks.length)
  useWheelSteps(rail, (delta) =>
    setActive((index) =>
      clamp((index ?? Math.round(view.top * marks.length)) + delta, marks.length),
    ),
  )
  return (
    <div
      className="relative w-6 cursor-pointer py-1"
      onPointerLeave={() => setActive(undefined)}
      ref={rail}
      style={{ height: height + 8 }}
    >
      <ViewBand height={height} view={view} />
      {marks.map((mark, index) => (
        <button
          aria-label={`${kindLabel[mark.kind]}: ${mark.text}`}
          className="absolute right-1 flex w-5 items-center justify-end"
          key={index}
          onClick={() => jump(index)}
          onPointerEnter={() => setActive(index)}
          style={{ top: 4 + index * gap, height: gap }}
          type="button"
        >
          <Glyph active={active === index} kind={mark.kind} />
        </button>
      ))}
      {active !== undefined && <Tip mark={marks[active]} top={4 + active * gap + gap / 2} />}
    </div>
  )
}

/** Variant C: three lanes, you · agent · milestones, rows aligned by order. */
function Lanes({ marks, profile, view, jump }: RailProps) {
  const rail = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<number>()
  const { gap, height } = layout(marks.length)
  const lane = (kind: MarkKind) =>
    kind === 'user' ? 0 : milestones[profile].includes(kind) ? 2 : 1
  useWheelSteps(rail, (delta) =>
    setActive((index) =>
      clamp((index ?? Math.round(view.top * marks.length)) + delta, marks.length),
    ),
  )
  return (
    <div
      className="group/lanes relative w-12 cursor-pointer py-1"
      onPointerLeave={() => setActive(undefined)}
      ref={rail}
      style={{ height: height + 8 }}
    >
      <div className="pointer-events-none absolute -top-4 right-0 flex w-12 justify-around font-mono text-[9px] text-muted-foreground/0 transition-colors group-hover/lanes:text-muted-foreground/70">
        <span>you</span>
        <span>ai</span>
        <span>★</span>
      </div>
      {[0, 1, 2].map((column) => (
        <span
          className="pointer-events-none absolute top-1 bottom-1 w-px bg-border/60"
          key={column}
          style={{ left: 8 + column * 16 }}
        />
      ))}
      <ViewBand height={height} view={view} />
      {marks.map((mark, index) => (
        <button
          aria-label={`${kindLabel[mark.kind]}: ${mark.text}`}
          className={cn('absolute right-0 left-0', active === index && 'bg-foreground/5')}
          key={index}
          onClick={() => jump(index)}
          onPointerEnter={() => setActive(index)}
          style={{ top: 4 + index * gap, height: gap }}
          type="button"
        >
          <span
            className="absolute top-1/2 flex w-4 -translate-y-1/2 justify-center"
            style={{ left: lane(mark.kind) * 16 }}
          >
            <Glyph active={active === index} kind={mark.kind} />
          </span>
        </button>
      ))}
      {active !== undefined && <Tip mark={marks[active]} top={4 + active * gap + gap / 2} />}
    </div>
  )
}

type Filter = 'milestones' | 'yours' | 'all'

/** Variant B: the rail, and hovering it opens a list with filters; the wheel moves through the list. */
function List({ marks, profile, view, jump }: RailProps) {
  const rail = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [stored, setFilter] = useExtensionUiState('mock.filter', 'milestones')
  const filter = stored as Filter
  const [active, setActive] = useState<number>()
  const close = useRef<ReturnType<typeof setTimeout>>(undefined)
  const { gap, height } = layout(marks.length)
  const shown = marks
    .map((mark, index) => ({ mark, index }))
    .filter(({ mark }) =>
      filter === 'all'
        ? true
        : filter === 'yours'
          ? mark.kind === 'user'
          : milestones[profile].includes(mark.kind),
    )
  const position = shown.findIndex((row) => row.index === active)
  useWheelSteps(rail, (delta) => {
    setOpen(true)
    const from =
      position === -1 ? shown.findIndex((row) => row.index >= view.top * marks.length) : position
    setActive(shown[clamp(from + delta, shown.length)]?.index)
  })
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const enter = () => {
    clearTimeout(close.current)
    setOpen(true)
  }
  const leave = () => {
    close.current = setTimeout(() => {
      setOpen(false)
      setActive(undefined)
    }, 180)
  }
  const chip = (value: Filter, label: string) => (
    <button
      className={cn(
        'h-6 cursor-pointer rounded-md px-2 font-mono text-[11px]',
        filter === value
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={() => setFilter(value)}
      type="button"
    >
      {label}
    </button>
  )
  return (
    <div className="relative flex" onPointerEnter={enter} onPointerLeave={leave}>
      {open && (
        <div className="absolute top-0 right-7 z-20 flex max-h-[min(440px,70vh)] w-80 flex-col rounded-lg border border-border bg-popover shadow-lg">
          <div className="flex items-center gap-1 border-b border-border/70 p-1.5">
            {chip('milestones', 'Milestones')}
            {chip('yours', 'Yours')}
            {chip('all', 'All')}
            <span className="ml-auto pr-1 font-mono text-[10.5px] text-muted-foreground/70">
              {shown.length}
            </span>
          </div>
          <div className="min-h-0 overflow-y-auto p-1" ref={list}>
            {shown.map(({ mark, index }) => (
              <button
                className={cn(
                  'flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left',
                  active === index ? 'bg-accent' : 'hover:bg-accent/60',
                )}
                data-active={active === index ? '' : undefined}
                key={index}
                onClick={() => jump(index)}
                onPointerEnter={() => setActive(index)}
                type="button"
              >
                <span className="mt-[7px] flex w-4 shrink-0 justify-center">
                  <Glyph kind={mark.kind} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-popover-foreground">
                  {mark.text}
                </span>
                <span className="mt-0.5 shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
                  {mark.at}
                </span>
              </button>
            ))}
            {shown.length === 0 && (
              <div className="px-2 py-3 font-mono text-[11px] text-muted-foreground">
                Nothing of this kind yet
              </div>
            )}
          </div>
        </div>
      )}
      <div className="relative w-6 cursor-pointer py-1" ref={rail} style={{ height: height + 8 }}>
        <ViewBand height={height} view={view} />
        {marks.map((mark, index) => (
          <button
            aria-label={`${kindLabel[mark.kind]}: ${mark.text}`}
            className="absolute right-1 flex w-5 items-center justify-end"
            key={index}
            onClick={() => jump(index)}
            onPointerEnter={() => setActive(index)}
            style={{ top: 4 + index * gap, height: gap }}
            type="button"
          >
            <Glyph active={active === index} kind={mark.kind} />
          </button>
        ))}
      </div>
    </div>
  )
}

const clamp = (index: number, count: number) => Math.max(0, Math.min(count - 1, index))

/** Preview-only switcher between the variants and conversation kinds. */
function Switcher({
  variant,
  setVariant,
  profile,
  setProfile,
}: {
  variant: Variant
  setVariant: (variant: Variant) => void
  profile: Profile
  setProfile: (profile: Profile) => void
}) {
  const option = <T extends string>(
    value: T,
    current: T,
    set: (value: T) => void,
    label: ReactNode,
  ) => (
    <button
      className={cn(
        'h-5 cursor-pointer rounded px-1.5',
        current === value
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={() => set(value)}
      type="button"
    >
      {label}
    </button>
  )
  return (
    <div className="pointer-events-auto flex flex-col items-end gap-1 font-mono text-[10px]">
      <div className="flex rounded-md border border-dashed border-border bg-background/80 p-0.5">
        {option('ticks', variant, setVariant, 'A ticks')}
        {option('list', variant, setVariant, 'B list')}
        {option('lanes', variant, setVariant, 'C lanes')}
      </div>
      <div className="flex rounded-md border border-dashed border-border bg-background/80 p-0.5">
        {option('ultimate', profile, setProfile, '@ultimate')}
        {option('coordinator', profile, setProfile, 'coord')}
        {option('worker', profile, setProfile, 'worker')}
      </div>
    </div>
  )
}

function Minimap() {
  const root = useRef<HTMLDivElement>(null)
  const viewport = useViewport()
  const detected = useProfile()
  const [stored, setVariant] = useExtensionUiState('mock.variant', 'ticks')
  const [chosen, setChosen] = useExtensionUiState('mock.profile', '')
  const variant = stored as Variant
  const profile = (chosen || detected) as Profile
  const marks = useMemo(() => mockMarks(profile), [profile])
  const { view, jump } = useScroller(root)
  if (viewport === 'phone') return <div hidden ref={root} />
  const props: RailProps = { marks, profile, view, jump: (index) => jump(index, marks.length) }
  return (
    <div className="pointer-events-none absolute inset-0" ref={root}>
      <div className="absolute top-3 right-5 flex flex-col items-end gap-6">
        <Switcher
          profile={profile}
          setProfile={setChosen}
          setVariant={setVariant}
          variant={variant}
        />
        <div className="pointer-events-auto">
          {variant === 'ticks' && <Ticks {...props} />}
          {variant === 'list' && <List {...props} />}
          {variant === 'lanes' && <Lanes {...props} />}
        </div>
      </div>
    </div>
  )
}

export default defineWebExtension({
  slots: { 'conversation.overlay': [Minimap] },
})
