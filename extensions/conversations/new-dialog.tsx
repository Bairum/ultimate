import { GitBranchIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { getConversation, NewConversationComposer, useDialog, useUltimate } from '@/sdk'
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
  const actions = useUltimate()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="gap-3 sm:max-w-xl">
        <DialogTitle className="flex items-center gap-2 text-[14px] font-medium">
          <GitBranchIcon className="size-4 text-brand" /> Branch from the root
        </DialogTitle>
        <DialogDescription className="text-[13px]">
          Start a new line of work from the root's latest context.
        </DialogDescription>
        <NewConversationComposer
          isolated={newIsolation}
          onStarted={(id) => {
            setOpen(false)
            actions.switchConversation(id)
            focusWhenShown(actions, id)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
