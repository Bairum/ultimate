import { MoonIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useDialog, useDocOf, useUltimate } from '@/sdk'
import { SessionJournal } from './journal.tsx'
import { MoonRow } from './moon.tsx'
import { pinnedOf, progress } from './types.ts'
import { DreamDoc } from './refs.ts'

/** The dialog the pinned dream line opens: the session's journal card. */
export const journalDialog = 'dream.journal'

/** The session the status line keeps in view, live. */
const usePinned = () => pinnedOf(useDocOf(1, DreamDoc)?.sessions)

/**
 * A dream session in the status line, on every surface and on phones, from its start until it is settled and slept
 * (or ended): where it stands, and a click away from its journal.
 */
export function DreamStatus() {
  const session = usePinned()
  const actions = useUltimate()
  if (!session) return null
  const { long, short, moons } = progress(session)
  return (
    <button
      className="-mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
      data-dream-status={session.id}
      onClick={() => actions.open(journalDialog)}
      title={`Dream session ${session.id}: ${long}. Show its journal`}
      type="button"
    >
      <MoonIcon className="size-3 shrink-0 text-brand" />
      <span className="text-foreground/85">dream {session.id}</span>
      {moons && <MoonRow session={session} />}
      <span className={short ? 'truncate max-sm:hidden' : 'truncate'}>{long}</span>
      {short && <span className="sm:hidden">{short}</span>}
    </button>
  )
}

/** The pinned session's current step: Fall asleep or its progress once proposals are settled, else the proposals. */
export function JournalDialog() {
  const [open, setOpen] = useDialog(journalDialog)
  const session = usePinned()
  return (
    <Dialog onOpenChange={setOpen} open={open && !!session}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[40rem]"
        data-dream-journal-dialog
      >
        <DialogTitle className="sr-only">Dream session {session?.id}</DialogTitle>
        <DialogDescription className="sr-only">
          The dream's journal and where its proposals stand
        </DialogDescription>
        {session && <SessionJournal className="rounded-none border-0" current id={session.id} />}
      </DialogContent>
    </Dialog>
  )
}
