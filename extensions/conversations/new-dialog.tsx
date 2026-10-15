import { GitBranchIcon, SproutIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  cn,
  getConversation,
  NewConversationComposer,
  useAction,
  useDialog,
  useEvent,
  useStore,
  useUltimate,
} from '@/sdk'
import type { UltimateActions } from '@/sdk'
export const newKeys = 'mod+alt+n'

/** Focus the composer once conversation `id` has rendered and no dialog (the palette) holds focus any longer. */
function focusWhenShown(actions: UltimateActions, id: number, deadline = Date.now() + 5000) {
  requestAnimationFrame(() => {
    if (getConversation().id === id && !document.querySelector('[role="dialog"]'))
      actions.focusComposer()
    else if (Date.now() < deadline) focusWhenShown(actions, id, deadline)
  })
}

const newDialog = 'conversations.new'

export function createConversation(actions: UltimateActions, isolated?: boolean) {
  newIsolation = isolated
  actions.showSurface('agent')
  actions.open(newDialog)
}
let newIsolation: boolean | undefined

export function NewDialog() {
  const [open, setOpen] = useDialog(newDialog)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="gap-3 sm:max-w-xl"
        // The prompt takes focus once the dialog knows its modes, not the first mode tab.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <NewConversation close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

const mode =
  'flex h-6 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring'

/** Branch from the shown tree's root (else the most recently active root), or start a new root. */
function NewConversation({ close }: { close: () => void }) {
  const actions = useUltimate()
  const shown = actions.conversationId
  const info = useAction<{ roots: number[]; root?: number }>(
    'lineage',
    'info',
    shown === undefined ? null : { id: shown },
  )
  useEvent('lineage:roots-changed', () => void info.refetch())
  const conversations = useStore((state) => state.conversations)
  const inputAt = (id: number) =>
    conversations.find((conversation) => conversation.id === id)?.inputAt ?? 0
  const from =
    info.data?.root ?? info.data?.roots.toSorted((a, b) => inputAt(b) - inputAt(a) || b - a)[0]
  const title = conversations.find((conversation) => conversation.id === from)?.title
  const [choice, setChoice] = useState<'branch' | 'root'>('branch')
  const root = choice === 'root' || from === undefined
  const modes = useRef<HTMLDivElement>(null)
  useEffect(() => {
    modes.current?.parentElement
      ?.querySelector<HTMLElement>('[aria-label="Start a conversation"]')
      ?.focus()
  }, [root, from, info.data])
  const started = (id: number) => {
    close()
    actions.switchConversation(id)
    focusWhenShown(actions, id)
  }
  if (!info.data) return <DialogTitle className="sr-only">New conversation</DialogTitle>
  return (
    <>
      {/* The mode tabs are the title: which kind of conversation starts. */}
      <DialogTitle className="sr-only">{root ? 'New root' : `Branch from #${from}`}</DialogTitle>
      <div className="-ml-2 flex min-w-0 items-center gap-0.5 pr-6" ref={modes} role="tablist">
        {from !== undefined && (
          <button
            aria-selected={!root}
            className={cn(mode, 'min-w-0', !root && 'bg-accent text-foreground')}
            onClick={() => setChoice('branch')}
            role="tab"
            type="button"
          >
            <GitBranchIcon className={cn('size-3.5 shrink-0', !root && 'text-brand')} />
            <span className="truncate">
              Branch from #{from}
              {title && ` · ${title}`}
            </span>
          </button>
        )}
        <button
          aria-selected={root}
          className={cn(mode, 'shrink-0', root && 'bg-accent text-foreground')}
          onClick={() => setChoice('root')}
          role="tab"
          type="button"
        >
          <SproutIcon className={cn('size-3.5', root && 'text-brand')} />
          New root
        </button>
      </div>
      <DialogDescription className="text-[13px]">
        {root
          ? 'Start a new, independent line of work.'
          : `Start a new line of work from #${from}'s latest context.`}
      </DialogDescription>
      {root ? (
        <NewConversationComposer
          branch={{ root: true }}
          isolated={newIsolation}
          onStarted={started}
        />
      ) : (
        <NewConversationComposer branch={{ from }} isolated={newIsolation} onStarted={started} />
      )}
    </>
  )
}
