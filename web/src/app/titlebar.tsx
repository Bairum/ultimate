import { cn } from 'cn'
import { CommandIcon } from 'lucide-react'
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
import { HOME, surfaceItems } from '../sdk/registry.ts'
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

/** The brand, which opens the list of surfaces; on phones, where they are not listed beside it, it names the shown one. */
function SurfaceSwitcher() {
  const surfaces = surfaceItems(useExtensions())
  const shown = useStore((state) => state.ui.surface?.id)
  const current = surfaces.find((surface) => surface.id === shown)
  const Icon = current?.icon
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          className="flex shrink-0 items-center gap-2 rounded-sm px-1 font-sans text-[11px] font-semibold tracking-[0.28em] text-brand transition-opacity outline-none hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring"
          title="Switch surface"
          type="button"
        >
          ULTIMATE
          {current && current.id !== HOME && (
            <span className="flex items-center gap-1.5 text-[12px] font-medium tracking-normal text-foreground md:hidden">
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
  )
}

/** One item per surface, like a menu bar, beyond a phone; the shown one in the foreground. */
function SurfaceItems() {
  const surfaces = surfaceItems(useExtensions())
  const shown = useStore((state) => state.ui.surface?.id)
  return (
    <nav className="flex shrink-0 items-center gap-0.5 max-md:hidden">
      {surfaces.map((surface, index) => {
        const Icon = surface.icon
        const active = surface.id === shown
        const button = (
          <button
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-5 items-center gap-1.5 rounded-sm px-1.5 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
              active && 'text-foreground',
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
 * The bar above every surface, styled like the status line: the brand with the surface switcher, the project,
 * `titlebar.left`, the surfaces; then `titlebar.right` and the command palette.
 */
export function TitleBar() {
  const project = projectTitle(useSystem())
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-b border-border/70 bg-sidebar px-2 font-mono text-[11.5px] text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap">
        <SurfaceSwitcher />
        {project && (
          <span className="truncate" title={project}>
            {project}
          </span>
        )}
        <Slot name="titlebar.left" variant="inline" />
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
