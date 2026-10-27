import { HourglassIcon } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatAgo, useConversation, useDocOf, useNow, useUltimate } from '@/sdk'
import { Address } from './cards.tsx'
import { emptyMessages, isOpen } from './data.tsx'
import { MessagesDoc } from './refs.ts'
import type { Message } from './refs.ts'

/**
 * A conversation's open messages: answers it waits for, what it owes (an open question, or a branch's report it has not
 * messaged the branch about since), and messages still on their way.
 */
export function openMessages(messages: readonly Message[], id: number) {
  const reports = new Map<number | 'user' | 'remote', Message>()
  for (const m of messages)
    if (m.to === id && m.report) reports.set(m.from, m)
    else if (m.from === id) reports.delete(m.to)
  return {
    waiting: messages.filter((m) => m.from === id && isOpen(m) && m.state === 'delivered'),
    owed: [
      ...messages.filter((m) => m.to === id && isOpen(m) && m.state === 'delivered'),
      ...reports.values(),
    ].toSorted((a, b) => a.id - b.id),
    delivering: messages.filter((m) => m.from === id && m.state === 'sent'),
  }
}

const gist = (text: string) => text.replace(/\s+/g, ' ').trim()

function Section({
  title,
  messages,
  side,
  now,
  open,
}: {
  title: string
  messages: Message[]
  side: 'to' | 'from'
  now: number
  open: (id: number) => void
}) {
  if (!messages.length) return null
  return (
    <div className="grid gap-0.5">
      <div className="px-1.5 text-[10px] tracking-wider text-muted-foreground uppercase">
        {title}
      </div>
      {messages.map((m) => (
        <button
          className="grid w-full min-w-0 gap-0.5 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-accent disabled:pointer-events-none"
          disabled={typeof m[side] !== 'number'}
          key={m.id}
          onClick={() => typeof m[side] === 'number' && open(m[side])}
          type="button"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate font-sans">
              <Address id={m[side]} remote={m.remote} />
            </span>
            <span className="ml-auto shrink-0 text-muted-foreground">{formatAgo(m.at, now)}</span>
          </span>
          <span className="truncate text-muted-foreground">{gist(m.text)}</span>
        </button>
      ))}
    </div>
  )
}

/** The composer's chip for the shown conversation's open messages; a click lists them, and each opens its conversation. */
export function OpenMessages() {
  const id = useConversation((conversation) => conversation.id)
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const now = useNow(30_000)
  const { switchConversation } = useUltimate()
  const [shown, setShown] = useState(false)
  if (id === undefined) return null
  const { waiting, owed, delivering } = openMessages(log.messages, id)
  const parts = [
    waiting.length && `${waiting.length} waiting`,
    owed.length && `${owed.length} owed`,
    delivering.length && `${delivering.length} delivering`,
  ].filter(Boolean)
  if (!parts.length) return null
  const go = (to: number) => {
    setShown(false)
    switchConversation(to)
  }
  return (
    <Popover onOpenChange={setShown} open={shown}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1.5 transition-colors hover:text-foreground max-md:hidden"
          data-open-messages
          title="Open messages"
          type="button"
        >
          <HourglassIcon className="size-3 text-amber-700/80 dark:text-amber-300/70" />
          {parts.join(' · ')}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="grid w-80 gap-2.5 p-1.5 font-mono text-[11px]"
        side="top"
      >
        <Section messages={waiting} now={now} open={go} side="to" title="Waiting on" />
        <Section messages={owed} now={now} open={go} side="from" title="You owe an answer to" />
        <Section messages={delivering} now={now} open={go} side="to" title="Delivering to" />
      </PopoverContent>
    </Popover>
  )
}
