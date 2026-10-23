import { cn } from 'cn'
import { ChevronDownIcon, CommandIcon } from 'lucide-react'
import { forwardRef } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SystemInfo } from '../../../shared/protocol.ts'
import { actions } from '../sdk/actions.ts'
import { shortenPath } from '../sdk/format.ts'
import { useExtensions, useStore, useSystem } from '../sdk/hooks.ts'
import { HOME, slotItems, surfaceItems } from '../sdk/registry.ts'
import { Slot } from './boundary.tsx'
import { Shortcut } from './palette.tsx'

/**
 * The project as tabs name it: its folder from home. A branch's checkout (`<home>/worktrees/<id>`) is the project's
 * name and that conversation, and a server with a home outside `~/.ultimate/projects`, as test previews have, says
 * it is a preview.
 */
export function projectTitle(system: SystemInfo | undefined) {
  if (!system) return undefined
  const { home } = system.machine
  const worktree = /\/\.ultimate\/projects\/(.+)-[\da-f]{8}\/worktrees\/(\d+)$/.exec(
    system.project.root,
  )
  const project = worktree
    ? `${worktree[1]} #${worktree[2]}`
    : shortenPath(system.project.root, { home })
  return system.persistence.path.startsWith(`${home}/.ultimate/projects/`)
    ? project
    : `preview · ${project}`
}

/** The project's name as the title bar's chip says it: the folder, or `<project> #<worktree>` for a branch's checkout. */
export function projectName(system: SystemInfo | undefined) {
  if (!system) return undefined
  const worktree = /\/\.ultimate\/projects\/(.+)-[\da-f]{8}\/worktrees\/(\d+)$/.exec(
    system.project.root,
  )
  return worktree ? `${worktree[1]} #${worktree[2]}` : system.project.name
}

/**
 * The title bar's project chip: the name, its full path in the tooltip. Pass `menu` to show a chevron and act as a
 * dropdown trigger (spread the trigger's props through); without it the chip is plain text.
 */
export const ProjectChip = forwardRef<
  HTMLButtonElement,
  ComponentProps<'button'> & { menu?: boolean; children?: ReactNode }
>(function ProjectChip({ menu, className, children, ...props }, ref) {
  const system = useSystem()
  const name = projectName(system)
  if (!name) return null
  const preview =
    system && !system.persistence.path.startsWith(`${system.machine.home}/.ultimate/projects/`)
  const body = (
    <>
      {preview && <span className="text-muted-foreground">preview ·</span>}
      <span className="truncate">{name}</span>
      {children}
      {menu && <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />}
    </>
  )
  const chip =
    'flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 font-sans text-[13px] font-medium text-foreground/90'
  if (!menu)
    return (
      <span className={cn(chip, className)} title={system?.project.root}>
        {body}
      </span>
    )
  return (
    <button
      className={cn(
        chip,
        'transition-colors outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent',
        className,
      )}
      ref={ref}
      title={system?.project.root}
      type="button"
      {...props}
    >
      {body}
    </button>
  )
})

/** The project chip, or what extensions put in its place (`titlebar.project`), such as the chip with a menu. */
function Project() {
  const replaced = slotItems(useExtensions(), 'titlebar.project').length > 0
  return replaced ? <Slot name="titlebar.project" variant="inline" /> : <ProjectChip />
}

const wordmark =
  'flex shrink-0 items-center gap-2 rounded-sm px-1 font-sans text-[11px] font-semibold tracking-[0.28em] text-brand'

/**
 * The brand. Beyond a phone it is just the mark, since the tabs beside it list the surfaces; on phones it opens the
 * list of surfaces and names the shown one.
 */
function Brand() {
  const surfaces = surfaceItems(useExtensions())
  const shown = useStore((state) => state.ui.surface?.id)
  const current = surfaces.find((surface) => surface.id === shown)
  const Icon = current?.icon
  return (
    <>
      <span className={cn(wordmark, 'max-md:hidden')}>ULTIMATE</span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              wordmark,
              'transition-opacity outline-none hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring md:hidden',
            )}
            title="Switch surface"
            type="button"
          >
            ULTIMATE
            {current && current.id !== HOME && (
              <span className="flex items-center gap-1.5 text-[12px] font-medium tracking-normal text-foreground">
                {Icon && <Icon className="size-3.5 text-muted-foreground" />}
                {current.title}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-96" sideOffset={4}>
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
    </>
  )
}

/** One segment per surface beyond a phone, the shown one raised like a selected tab. */
function SurfaceItems() {
  const surfaces = surfaceItems(useExtensions())
  const shown = useStore((state) => state.ui.surface?.id)
  return (
    <nav className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5 font-sans text-[12.5px] max-md:hidden">
      {surfaces.map((surface, index) => {
        const Icon = surface.icon
        const active = surface.id === shown
        const button = (
          <button
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-6 items-center gap-1.5 rounded-[5px] px-2 transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
              active
                ? 'bg-background text-foreground shadow-xs ring-1 ring-border/70'
                : 'hover:bg-accent/60',
            )}
            data-surface={surface.id}
            key={surface.id}
            onClick={() => actions.showSurface(surface.id)}
            type="button"
          >
            <Icon className={cn('size-3.5', active && 'text-brand')} />
            {surface.title}
          </button>
        )
        if (index >= 9) return button
        return (
          <Tooltip key={surface.id}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent className="flex items-center gap-2">
              {surface.description ?? surface.title}
              <Shortcut keys={`mod+${index + 1}`} />
            </TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}

/**
 * The bar above every surface, as the status line's background: the brand (the surface switcher on phones), the
 * project chip, `titlebar.left`, the surfaces; then `titlebar.right` and the command palette.
 */
export function TitleBar() {
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 overflow-hidden border-b border-border/70 bg-sidebar px-3 font-mono text-[11.5px] text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap">
        <Brand />
        <Project />
        <Slot name="titlebar.left" variant="inline" />
        <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border max-md:hidden" />
        <SurfaceItems />
      </div>
      <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
        <Slot name="titlebar.right" variant="inline" />
        <Button
          aria-label="Command palette"
          className="-mr-1 h-6 gap-1.5 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground max-md:hidden"
          onClick={actions.openPalette}
          size="sm"
          variant="ghost"
        >
          commands
          <Shortcut keys="mod+k" />
        </Button>
        <Button
          aria-label="Command palette"
          className="-mr-1 size-6 text-muted-foreground hover:text-foreground md:hidden"
          onClick={actions.openPalette}
          size="icon"
          variant="ghost"
        >
          <CommandIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
