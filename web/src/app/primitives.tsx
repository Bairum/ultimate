// The building blocks of surfaces, exported from `@/sdk`. Each is a thin wrapper over what the shell already has.
import { cn } from 'cn'
import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { actions, layout, shellKeys } from '../sdk/actions.ts'
import { useConversation, useExtensions, useUiState } from '../sdk/hooks.ts'
import { panelItems, slotItems } from '../sdk/registry.ts'
import type { PanelItem } from '../sdk/registry.ts'
import { ExtensionBoundary, Slot } from './boundary.tsx'
import { Composer } from './composer.tsx'
import { IconButton } from './header.tsx'
import { useSurfaceId } from './surface.ts'
import { Transcript } from './transcript.tsx'

/** The bottom line with the `statusline.left` and `statusline.right` slots. */
export function StatusLine() {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t border-border/70 bg-sidebar px-3 font-mono text-[11.5px] text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap">
        <Slot name="statusline.left" variant="inline" />
      </div>
      <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
        <Slot name="statusline.right" variant="inline" />
      </div>
    </footer>
  )
}

/**
 * The shown conversation: transcript and composer, filling the space it gets. `main` centres a reading column;
 * `dock` fits a narrow side region such as a `Dock`.
 */
export function Conversation({ variant = 'main' }: { variant?: 'main' | 'dock' }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Transcript dock={variant === 'dock'} />
      <Composer dock={variant === 'dock'} />
    </div>
  )
}

/** Mount `region` while this component is, so the header shows its toggle. Before paint: no flicker. */
function useMountRegion(region: 'sidebar' | 'panels') {
  useLayoutEffect(() => layout.mount(region), [region])
}

/** The `sidebar` slot as a left column (`mod+b`); it disappears while nothing is in it. */
export function Sidebar() {
  useMountRegion('sidebar')
  const [open] = useUiState(shellKeys.sidebarOpen, true)
  const empty = slotItems(useExtensions(), 'sidebar').length === 0
  if (empty || !open) return null
  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <Slot name="sidebar" />
    </aside>
  )
}

const tab = 'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 whitespace-nowrap'

/**
 * A tab per extension panel. When not every label fits, the tabs other than the shown one keep only their icon and
 * name themselves in a tooltip.
 */
function PanelTabs({ panels, active }: { panels: PanelItem[]; active: PanelItem }) {
  const row = useRef<HTMLDivElement>(null)
  const labelled = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    const fit = () => setCompact(labelled.current!.offsetWidth > row.current!.clientWidth)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(row.current!)
    observer.observe(labelled.current!)
    return () => observer.disconnect()
  }, [])
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border/70 px-2 font-mono text-[11.5px]">
      <div className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden" ref={row}>
        {/* Every tab with its label, unseen: how wide the row needs to be. */}
        <div aria-hidden className="invisible absolute flex w-max gap-0.5" ref={labelled}>
          {panels.map((panel) => {
            const Icon = panel.icon
            return (
              <span className={tab} key={`${panel.extension}:${panel.id}`}>
                {Icon && <Icon className="size-3.5" />}
                {panel.title}
              </span>
            )
          })}
        </div>
        {panels.map((panel) => {
          const Icon = panel.icon
          const iconOnly = compact && Icon !== undefined && panel.id !== active.id
          const button = (
            <button
              aria-label={iconOnly ? panel.title : undefined}
              className={cn(
                tab,
                'text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
                panel.id === active.id && 'bg-accent text-foreground',
              )}
              key={`${panel.extension}:${panel.id}`}
              onClick={() => actions.openPanel(panel.id)}
              type="button"
            >
              {Icon && <Icon className="size-3.5" />}
              {!iconOnly && panel.title}
            </button>
          )
          return iconOnly ? (
            <Tooltip key={`${panel.extension}:${panel.id}`}>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent side="bottom">{panel.title}</TooltipContent>
            </Tooltip>
          ) : (
            button
          )
        })}
      </div>
    </div>
  )
}

/** The right panel: a tab per extension panel (`mod+alt+b`). */
export function Panels() {
  useMountRegion('panels')
  const panels = panelItems(useExtensions())
  const [open] = useUiState(shellKeys.panelOpen, false)
  const [selected] = useUiState<string | null>(shellKeys.panel, null)
  if (!open || panels.length === 0) return null
  const active = panels.find((panel) => panel.id === selected) ?? panels[0]
  const Panel = active.component
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-border/70 bg-sidebar">
      <PanelTabs active={active} panels={panels} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ExtensionBoundary
          extension={active.extension}
          key={`${active.extension}:${active.id}`}
          version={active.version}
        >
          <Panel />
        </ExtensionBoundary>
      </div>
    </aside>
  )
}

const DOCK_WIDTH = 416
const MIN_WIDTH = 280
/** The widest a dock gets: the window less room for the surface beside it. */
const maxWidth = () => Math.max(MIN_WIDTH, window.innerWidth - 360)
const clamp = (width: number) => Math.round(Math.min(Math.max(width, MIN_WIDTH), maxWidth()))

/**
 * A collapsible, resizable side region, usually holding `<Conversation variant="dock" />`. Collapsed it is a rail
 * that still shows when the agent works. Open state and width are durable per surface and side
 * (`shell.dock.<surface>.<side>`); drag the inner edge to resize, double-click it to reset.
 */
export function Dock({
  title = 'conversation',
  side = 'right',
  children,
}: {
  title?: string
  side?: 'left' | 'right'
  children: ReactNode
}) {
  const surface = useSurfaceId()
  const [stored, setStored] = useUiState<{ open?: boolean; width?: number }>(
    `${shellKeys.dock}.${surface}.${side}`,
    { open: true, width: DOCK_WIDTH },
  )
  const open = stored.open !== false
  const [dragging, setDragging] = useState<number>()
  const live = useRef<number | undefined>(undefined)
  const { busy } = useConversation()
  const width = clamp(dragging ?? (typeof stored.width === 'number' ? stored.width : DOCK_WIDTH))
  const border = side === 'right' ? 'border-l' : 'border-r'
  const setOpen = (next: boolean) => setStored({ open: next, width })

  if (!open)
    return (
      <aside
        className={cn(
          'flex w-10 shrink-0 flex-col items-center gap-2 border-border/70 py-2',
          border,
        )}
      >
        <IconButton label={`Show ${title}`} onClick={() => setOpen(true)}>
          {side === 'right' ? (
            <PanelRightOpenIcon className="size-4" />
          ) : (
            <PanelLeftOpenIcon className="size-4" />
          )}
        </IconButton>
        {busy && <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />}
      </aside>
    )

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const start = event.clientX
    handle.setPointerCapture(event.pointerId)
    const move = (next: globalThis.PointerEvent) => {
      const delta = side === 'right' ? start - next.clientX : next.clientX - start
      live.current = clamp(width + delta)
      setDragging(live.current)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      if (live.current !== undefined) setStored({ open: true, width: live.current })
      live.current = undefined
      setDragging(undefined)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  return (
    <aside
      className={cn('relative flex shrink-0 flex-col border-border/70', border)}
      style={{ width }}
    >
      <div
        aria-label={`Resize ${title}`}
        aria-orientation="vertical"
        className={cn(
          'absolute inset-y-0 z-10 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-brand/60 after:opacity-0 after:transition-opacity hover:after:opacity-100',
          side === 'right' ? '-left-1' : '-right-1',
          dragging !== undefined && 'after:opacity-100',
        )}
        onDoubleClick={() => setStored({ open: true, width: DOCK_WIDTH })}
        onPointerDown={resize}
        role="separator"
      />
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 pr-1 pl-3 font-mono text-[11.5px] text-muted-foreground">
        {title}
        <IconButton label={`Hide ${title}`} onClick={() => setOpen(false)}>
          {side === 'right' ? (
            <PanelRightCloseIcon className="size-4" />
          ) : (
            <PanelLeftCloseIcon className="size-4" />
          )}
        </IconButton>
      </div>
      {children}
    </aside>
  )
}

export { Header } from './header.tsx'
export { Slot }
