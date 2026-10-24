import { MoonIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useDialog, useDocOf, useUltimate } from '@/sdk'
import { SessionJournal } from './journal.tsx'
import { MoonRow } from './moon.tsx'
import { DreamDoc } from './refs.ts'
import type { Session } from './refs.ts'

/** The dialog the pinned dream line opens: the session's journal card. */
export const journalDialog = 'dream.journal'

/**
 * The session the status line keeps in view: the open one, or the newest once every proposal settled while its Fall
 * asleep is still to come (a granted sleep under way included). A session the user ended early, or one a compaction's
 * dream settled to stay, is done.
 */
function usePinned(): Session | undefined {
  const sessions = useDocOf(1, DreamDoc)?.sessions
  const open = sessions?.find((item) => item.endedAt === undefined)
  if (open) return open
  const newest = sessions?.at(-1)
  if (!newest?.journal || newest.sleep?.phase === 'asleep') return undefined
  if (newest.proposals.some((item) => item.status === 'open' || item.status === 'approved'))
    return undefined
  if (newest.beforeCompaction?.outcome?.result === 'stay') return undefined
  return newest
}

const settled = (session: Session) =>
  session.proposals.filter((item) => item.status !== 'open' && item.status !== 'approved').length

/** Where the session stands, in a few words: dreaming, deciding, waiting on branches, or ready to fall asleep. */
function progress(session: Session) {
  if (session.sleep && session.sleep.phase !== 'failed') return { long: 'falling asleep' }
  if (!session.journal) return { long: 'dreaming', moons: true }
  const total = session.proposals.length
  const done = settled(session)
  if (session.endedAt !== undefined || done === total) return { long: 'ready to fall asleep' }
  const open = session.proposals.filter((item) => item.status === 'open').length
  const approved = total - done - open
  const rest = [open > 0 && `${open} to decide`, approved > 0 && `${approved} on branches`]
  return {
    long: [`${done} of ${total} settled`, ...rest].filter(Boolean).join(' · '),
    short: `${done}/${total}`,
  }
}

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

/** The pinned session's journal, proposals and End or Fall asleep, as the card in @ultimate's conversation shows them. */
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
        {session && <SessionJournal className="rounded-none border-0" id={session.id} />}
      </DialogContent>
    </Dialog>
  )
}
