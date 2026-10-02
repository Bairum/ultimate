import { cn } from 'cn'
import { PanelLeftIcon, PanelRightIcon } from 'lucide-react'
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ConversationSummary } from '../../../shared/protocol.ts'
import { actions, shellKeys } from '../sdk/actions.ts'
import { ROOT } from '../sdk/api.ts'
import { useConversation, useConversations, useExtensions, useUiState } from '../sdk/hooks.ts'
import { HOME, panelItems, slotItems, surfaceItems } from '../sdk/registry.ts'
import { Slot } from './boundary.tsx'
import { Shortcut } from './palette.tsx'
import { useRegion, useSurfaceId } from './surface.ts'

export function IconButton({
  label,
  keys,
  onClick,
  children,
  active,
}: {
  label: string
  keys?: string
  onClick: () => void
  children: ReactNode
  active?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className={cn(
            'size-7 text-muted-foreground hover:text-foreground',
            active && 'text-foreground',
          )}
          onClick={onClick}
          size="icon"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        {keys && <Shortcut keys={keys} />}
      </TooltipContent>
    </Tooltip>
  )
}

/** The conversations above `id`, root first, by their parent links. */
function ancestors(id: number | undefined, conversations: readonly ConversationSummary[]) {
  const chain: ConversationSummary[] = []
  let parent = conversations.find((conversation) => conversation.id === id)?.parentConversationId
  while (parent !== undefined && !chain.some((conversation) => conversation.id === parent)) {
    const found = conversations.find((conversation) => conversation.id === parent)
    if (!found) break
    chain.unshift(found)
    parent = found.parentConversationId
  }
  return chain
}

/** The root is named by role rather than by its first prompt. */
const nameOf = (conversation: ConversationSummary) =>
  conversation.id === ROOT ? 'main' : (conversation.label ?? `#${conversation.id}`)

/** Where the shown conversation sits: its ancestors, a busy dot, and its title. */
function Trail() {
  const { id, busy } = useConversation()
  const conversations = useConversations()
  const summary = conversations.find((conversation) => conversation.id === id)
  const trail = ancestors(id, conversations)
  const root = id === ROOT
  const title = summary?.title ?? (id === undefined ? 'connecting…' : 'New conversation')
  return (
    <>
      {trail.map((conversation) => (
        <Fragment key={conversation.id}>
          <button
            className="shrink-0 rounded-sm px-1 font-mono text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => actions.switchConversation(conversation.id)}
            title={conversation.id === ROOT ? 'The main conversation' : conversation.title}
            type="button"
          >
            {nameOf(conversation)}
          </button>
          <span className="-mx-1 shrink-0 text-muted-foreground/40">/</span>
        </Fragment>
      ))}
      {busy && <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />}
      {root ? (
        <span className="font-mono text-[12px] text-foreground/85">main</span>
      ) : (
        <>
          {summary?.label && (
            <span className="shrink-0 font-mono text-[12px] text-brand">{summary.label}</span>
          )}
          <span className="truncate text-[13px] font-medium" title={title}>
            {title}
          </span>
          {id !== undefined && (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">#{id}</span>
          )}
        </>
      )}
    </>
  )
}

/** The brand, which opens the list of surfaces; away from Agent it names the shown one. */
function SurfaceSwitcher() {
  const surfaces = surfaceItems(useExtensions())
  const shown = useSurfaceId()
  const current = surfaces.find((surface) => surface.id === shown)
  const Icon = current?.icon
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          className="flex shrink-0 items-center gap-2 rounded-sm px-1 text-[11px] font-semibold tracking-[0.28em] text-brand transition-opacity outline-none hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring"
          title="Switch surface"
          type="button"
        >
          ULTIMATE
          {current && current.id !== HOME && (
            <span className="flex items-center gap-1.5 text-[13px] font-medium tracking-normal text-foreground">
              {Icon && <Icon className="size-3.5 text-muted-foreground" />}
              {current.title}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-96" sideOffset={6}>
        <DropdownMenuLabel className="px-2 pt-1 pb-1.5 font-mono text-[10.5px] font-normal tracking-wider text-muted-foreground uppercase">
          Surfaces
        </DropdownMenuLabel>
        {surfaces.map((surface, index) => {
          const Item = surface.icon
          const active = surface.id === shown
          return (
            <DropdownMenuItem
              className="items-start gap-2.5 py-1.5"
              data-surface={surface.id}
              key={surface.id}
              onSelect={() => actions.showSurface(surface.id)}
            >
              <Item
                className={cn('mt-0.5 size-4', active ? 'text-brand' : 'text-muted-foreground')}
              />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[13px]', active && 'text-brand')}>
                  {surface.title}
                </span>
                {surface.description && (
                  <span className="block truncate text-[12px] text-muted-foreground">
                    {surface.description}
                  </span>
                )}
              </span>
              {index < 9 && (
                <span className="mt-0.5 shrink-0">
                  <Shortcut keys={`mod+${index + 1}`} />
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The top bar: the brand with the surface switcher, `children` (the shown conversation's trail by default), the
 * `header.right` slot, and the command palette. It toggles the sidebar and panel when the surface renders them.
 */
export function Header({ children }: { children?: ReactNode }) {
  const records = useExtensions()
  const sidebar = useRegion('sidebar') && slotItems(records, 'sidebar').length > 0
  const panels = useRegion('panels') && panelItems(records).length > 0
  const [panelOpen] = useUiState(shellKeys.panelOpen, false)
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-2">
      {sidebar && (
        <IconButton keys="mod+b" label="Toggle sidebar" onClick={actions.toggleSidebar}>
          <PanelLeftIcon className="size-4" />
        </IconButton>
      )}
      <SurfaceSwitcher />
      <span className="h-4 w-px shrink-0 bg-border" />
      <div className="flex min-w-0 items-center gap-2">{children ?? <Trail />}</div>
      <div className="ml-auto flex items-center gap-1">
        <Slot name="header.right" variant="inline" />
        <Button
          aria-label="Command palette"
          className="h-7 gap-1.5 px-2 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          onClick={actions.openPalette}
          size="sm"
          variant="ghost"
        >
          commands
          <Shortcut keys="mod+k" />
        </Button>
        {panels && (
          <IconButton
            active={panelOpen}
            keys="mod+alt+b"
            label="Toggle panel"
            onClick={actions.togglePanel}
          >
            <PanelRightIcon className="size-4" />
          </IconButton>
        )}
      </div>
    </header>
  )
}
