import { ChevronRightIcon, MoonIcon, MoonStarIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { api, cn, formatTime, useDocOf, useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { MoonRow, Passes, passLabels } from './moon.tsx'
import { DreamDoc, EndAction } from './refs.ts'
import type { Proposal, Session, SessionEntry } from './refs.ts'

/** Session `id` of the live `dream.sessions` document; undefined while it streams or when unknown. */
function useSession(id: number) {
  return useDocOf(1, DreamDoc)?.sessions.find((item) => item.id === id)
}

/** The card frame every dream entry shares: a night-accented rule on the left, a mono header row. */
function Card({
  session,
  header,
  children,
}: {
  session: number
  header: ReactNode
  children?: ReactNode
}) {
  return (
    <section
      className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20"
      data-dream-session={session}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {header}
      </header>
      {children}
    </section>
  )
}

/** `dream.started`: the session began, and its passes as moons until the journal is filed. */
export function StartedCard({ entry }: { entry: EntryRecord }) {
  const { session: id } = entry.data as SessionEntry
  const session = useSession(id)
  const { switchConversation } = useUltimate()
  const filed = !!session?.journal
  return (
    <Card
      header={
        <>
          <MoonIcon className="size-3.5 text-brand" />
          <span className="text-foreground">Dream session {id}</span>
          <span>{session ? `started ${formatTime(session.startedAt)}` : 'started'}</span>
          {session && filed && <MoonRow session={session} />}
          {session?.dreamer !== undefined && (
            <button
              className="ml-auto flex min-w-0 cursor-pointer items-center hover:text-foreground"
              onClick={() => switchConversation(session.dreamer!)}
              title="Open the dream branch"
              type="button"
            >
              <ConversationRef id={session.dreamer} />
            </button>
          )}
        </>
      }
      session={id}
    >
      {session && !filed && (
        <>
          <div className="px-3 py-2.5">
            <Passes session={session} />
          </div>
          {/* A dream that stops before its journal must not hold the next one off. */}
          <Footer session={session} />
        </>
      )}
      {session && filed && (
        <p className="px-3 py-2 text-[12px] text-muted-foreground">
          {session.endedAt === undefined
            ? 'Journal filed below.'
            : `Journal filed below. Session complete.`}
        </p>
      )}
    </Card>
  )
}

/** Above this many characters the journal folds behind "Read the journal". */
const FOLD = 600

/** `dream.journal`: what the dream learned, the journal, and its proposals followed until they land. */
export function JournalCard({ entry }: { entry: EntryRecord }) {
  const { session: id } = entry.data as SessionEntry
  const session = useSession(id)
  const journal = session?.journal
  return (
    <Card
      header={
        <>
          <MoonStarIcon className="size-3.5 text-brand" />
          <span className="text-foreground">Dream journal</span>
          <span>session {id}</span>
          {journal && <span>{formatTime(journal.at)}</span>}
        </>
      }
      session={id}
    >
      {!session ? (
        <p className="px-3 py-3 text-[12px] text-muted-foreground">Loading the journal…</p>
      ) : !journal ? (
        <div className="px-3 py-2.5">
          <Passes session={session} />
        </div>
      ) : (
        <>
          <Learned lines={journal.learned} />
          <Text text={journal.text} />
          {session.proposals.length > 0 && <Proposals session={session} />}
          <Footer session={session} />
        </>
      )}
    </Card>
  )
}

/** The three lines in Ultimate's own voice: the morning picture, set apart in a larger serif-free italic. */
function Learned({ lines }: { lines: string[] }) {
  return (
    <ul className="space-y-1.5 px-4 pt-4 pb-3" data-dream-learned>
      {lines.map((line) => (
        <li
          className="border-l-2 border-brand/30 pl-3 text-[14.5px] leading-snug text-foreground/90 italic"
          key={line}
        >
          {line}
        </li>
      ))}
    </ul>
  )
}

function Text({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (text.length <= FOLD)
    return (
      <div className="px-4 pb-3 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    )
  return (
    <Collapsible className="group/journal px-4 pb-3" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/journal:rotate-90 motion-reduce:transition-none" />
        {open ? 'Hide the journal' : 'Read the journal'}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Where a proposal stands, as a pill; settled ones fade so the open ones draw the eye. */
const pills: Record<Proposal['status'], { label: string; className: string }> = {
  open: { label: 'open', className: 'bg-brand/15 text-brand' },
  approved: { label: 'in progress', className: 'bg-warning/15 text-warning' },
  landed: { label: 'landed', className: 'bg-success/15 text-success' },
  applied: { label: 'applied', className: 'bg-success/15 text-success' },
  rejected: { label: 'rejected', className: 'bg-muted text-muted-foreground' },
}

function Proposals({ session }: { session: Session }) {
  const { switchConversation } = useUltimate()
  return (
    <ul className="border-t border-border/60 py-1" data-dream-proposals>
      {session.proposals.map((proposal) => {
        const pill = pills[proposal.status]
        const settled = proposal.status === 'rejected'
        return (
          <li
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-1.5"
            data-proposal={proposal.id}
            data-status={proposal.status}
            key={proposal.id}
          >
            <div className="min-w-0">
              <p
                className={cn(
                  'text-[13px] leading-snug',
                  settled
                    ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                    : 'text-foreground',
                )}
              >
                {proposal.title}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
                <span>{passLabels[proposal.pass]}</span>
                {proposal.size && <span>· {proposal.size}</span>}
                {proposal.retire && (
                  <span>
                    · retires memory <span className="text-foreground/80">{proposal.retire}</span>
                  </span>
                )}
                {proposal.branch !== undefined && (
                  <button
                    className="flex min-w-0 cursor-pointer items-center gap-1 hover:text-foreground"
                    onClick={() => switchConversation(proposal.branch!)}
                    title="Open its branch"
                    type="button"
                  >
                    · <ConversationRef id={proposal.branch} />
                  </button>
                )}
              </p>
            </div>
            <span
              className={cn(
                'rounded-full px-2 font-mono text-[10.5px] leading-[18px] whitespace-nowrap',
                pill.className,
              )}
            >
              {pill.label}
              {proposal.status === 'landed' && proposal.sha && ` ${proposal.sha.slice(0, 7)}`}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** "2 open · 1 in progress · 1 landed": what the user still has to decide, at a glance. */
function Tally({ proposals }: { proposals: readonly Proposal[] }) {
  const count = (status: Proposal['status']) =>
    proposals.filter((item) => item.status === status).length
  if (!proposals.length) return <span>no proposals</span>
  const parts: [number, string, string?][] = [
    [count('open'), 'open', 'text-brand'],
    [count('approved'), 'in progress'],
    [count('landed'), 'landed'],
  ]
  if (count('applied')) parts.push([count('applied'), 'applied'])
  return (
    <span className="font-mono text-[11px] text-muted-foreground" data-dream-tally>
      {parts.map(([n, word, tone], index) => (
        <span key={word}>
          {index > 0 && ' · '}
          <span className={cn(n > 0 && (tone ?? 'text-foreground/80'))}>{n}</span> {word}
        </span>
      ))}
    </span>
  )
}

function Footer({ session }: { session: Session }) {
  const [confirming, setConfirming] = useState(false)
  const [ending, setEnding] = useState(false)
  if (session.endedAt !== undefined)
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2 font-mono text-[11px] text-muted-foreground">
        <Tally proposals={session.proposals} />
        <span className="ml-auto flex items-center gap-1.5">
          <MoonIcon className="size-3" />
          {session.journal ? 'Session complete' : 'Session ended'} · {formatTime(session.endedAt)}
        </span>
      </div>
    )
  const end = async () => {
    setEnding(true)
    try {
      await api.action(EndAction, { session: session.id })
    } finally {
      setEnding(false)
      setConfirming(false)
    }
  }
  return (
    <div className="flex min-h-10 flex-wrap items-center justify-end gap-2 border-t border-border/60 px-4 py-2 text-[12px]">
      {confirming ? (
        <>
          <span className="mr-auto text-muted-foreground">
            End the session? Open proposals stay undecided; branches already started go on.
          </span>
          <Button className="h-6" onClick={() => setConfirming(false)} size="xs" variant="ghost">
            Keep it open
          </Button>
          <Button
            className="h-6"
            disabled={ending}
            onClick={() => void end()}
            size="xs"
            variant="outline"
          >
            End session
          </Button>
        </>
      ) : (
        <>
          <span className="mr-auto">
            {session.journal ? (
              <Tally proposals={session.proposals} />
            ) : (
              <span className="text-muted-foreground">Dreaming…</span>
            )}
          </span>
          <Button className="h-6" onClick={() => setConfirming(true)} size="xs" variant="ghost">
            End session
          </Button>
        </>
      )}
    </div>
  )
}
