import { cn } from 'cn'
import {
  MessagesSquareIcon,
  PanelLeftIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { actions, shellKeys } from '../sdk/actions.ts'
import { useConversation, useConversations, useExtensions, useUiState } from '../sdk/hooks.ts'
import { panelItems, slotItems, viewItems } from '../sdk/registry.ts'
import { ExtensionBoundary, ExtensionErrors, Slot } from './boundary.tsx'
import { Composer } from './composer.tsx'
import { useShortcuts } from './keyboard.ts'
import { CommandPalette, Shortcut } from './palette.tsx'
import { Transcript } from './transcript.tsx'

function IconButton({
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

function Header({ view }: { view: string | undefined }) {
  const { id, busy } = useConversation()
  const summary = useConversations().find((conversation) => conversation.id === id)
  const records = useExtensions()
  const views = viewItems(records)
  const hasSidebar = slotItems(records, 'sidebar').length > 0
  const hasPanels = panelItems(records).length > 0
  const [panelOpen] = useUiState(shellKeys.panelOpen, false)
  const title = summary?.title ?? (id === undefined ? 'Connecting…' : 'New conversation')
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-2">
      {hasSidebar && (
        <IconButton keys="mod+b" label="Toggle sidebar" onClick={actions.toggleSidebar}>
          <PanelLeftIcon className="size-4" />
        </IconButton>
      )}
      <div className="flex min-w-0 items-center gap-2 pl-1">
        {busy && <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />}
        <span className="truncate text-[13px] font-medium">{title}</span>
        {id !== undefined && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">#{id}</span>
        )}
        {id !== undefined && id !== 1 && (
          <Button
            className="h-6 px-2 font-mono text-[11px] text-muted-foreground"
            onClick={() => actions.switchConversation(1)}
            size="sm"
            variant="ghost"
          >
            ← main
          </Button>
        )}
      </div>
      {views.length > 0 && (
        <nav className="ml-3 flex items-center gap-0.5 font-mono text-[11.5px]">
          {[{ id: undefined, title: 'conversation', icon: MessagesSquareIcon }, ...views].map(
            (item) => {
              const Icon = item.icon
              const active = view === item.id
              return (
                <button
                  className={cn(
                    'flex h-6 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:text-foreground',
                    active && 'bg-accent text-foreground',
                  )}
                  key={item.id ?? ''}
                  onClick={() => actions.openView(item.id)}
                  type="button"
                >
                  {Icon && <Icon className="size-3.5" />}
                  {item.title}
                </button>
              )
            },
          )}
        </nav>
      )}
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
        {hasPanels && (
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

function Sidebar() {
  const [open] = useUiState(shellKeys.sidebarOpen, true)
  const empty = slotItems(useExtensions(), 'sidebar').length === 0
  if (empty || !open) return null
  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <Slot name="sidebar" />
    </aside>
  )
}

function RightPanel() {
  const panels = panelItems(useExtensions())
  const [open] = useUiState(shellKeys.panelOpen, false)
  const [selected] = useUiState<string | null>(shellKeys.panel, null)
  if (!open || panels.length === 0) return null
  const active = panels.find((panel) => panel.id === selected) ?? panels[0]
  const Panel = active.component
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-border/70 bg-sidebar">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border/70 px-2 font-mono text-[11.5px]">
        {panels.map((panel) => {
          const Icon = panel.icon
          return (
            <button
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:text-foreground',
                panel.id === active.id && 'bg-accent text-foreground',
              )}
              key={`${panel.extension}:${panel.id}`}
              onClick={() => actions.openPanel(panel.id)}
              type="button"
            >
              {Icon && <Icon className="size-3.5" />}
              {panel.title}
            </button>
          )
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ExtensionBoundary extension={active.extension} version={active.version}>
          <Panel />
        </ExtensionBoundary>
      </div>
    </aside>
  )
}

/** The conversation beside a full-area view: transcript and composer, collapsible to a rail. */
function ConversationDock() {
  const [open, setOpen] = useUiState(shellKeys.dockOpen, true)
  const { busy } = useConversation()
  if (!open)
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-2 border-l border-border/70 py-2">
        <IconButton label="Show conversation" onClick={() => setOpen(true)}>
          <PanelRightOpenIcon className="size-4" />
        </IconButton>
        {busy && <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />}
      </aside>
    )
  return (
    <aside className="flex w-[26rem] shrink-0 flex-col border-l border-border/70">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 pr-1 pl-3 font-mono text-[11.5px] text-muted-foreground">
        conversation
        <IconButton label="Hide conversation" onClick={() => setOpen(false)}>
          <PanelRightCloseIcon className="size-4" />
        </IconButton>
      </div>
      <Transcript dock />
      <Composer dock />
    </aside>
  )
}

function StatusLine() {
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

export function App() {
  useShortcuts()
  const records = useExtensions()
  const [selected] = useUiState<string | null>(shellKeys.view, null)
  const view = viewItems(records).find((item) => item.id === selected)
  const View = view?.component
  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-dvh flex-col">
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="flex min-w-0 flex-1 flex-col">
            <Header view={view?.id} />
            {view && View ? (
              <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1 overflow-auto">
                  <ExtensionBoundary extension={view.extension} version={view.version}>
                    <View />
                  </ExtensionBoundary>
                </div>
                <ConversationDock />
              </div>
            ) : (
              <>
                <Transcript />
                <Composer />
              </>
            )}
          </main>
          <RightPanel />
        </div>
        <StatusLine />
      </div>
      <CommandPalette />
      <ExtensionErrors />
      <Slot name="overlay" />
    </TooltipProvider>
  )
}
