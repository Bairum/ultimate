import { GitForkIcon, GitMergeIcon, ScrollTextIcon, TriangleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn, events, useUltimate } from '@/sdk'
import type { EventData, EventRecord } from '@/sdk'
import { compareUrl } from '../../lib/compare.ts'
import { NoticeEvent } from '../../shared/events.ts'
import { ConversationRef, FeatureTag } from '../conversations/ui.tsx'
import { Branched, Rooted } from '../lineage/ui.tsx'
import { CommitCount, SubmissionLanded, useGithubRepo } from '../workspaces/ui.tsx'

/** The events the feed shows, each with its own row. */
export const activityEvents = [SubmissionLanded, Branched, Rooted, NoticeEvent] as const
export type ActivityEvent = EventRecord<EventData<(typeof activityEvents)[number]>>

/** `now`, `5m`, `3h`, `2d`, then a short date, as the sidebar's root rows show ages. */
function ago(at: number, now: number) {
  const minutes = Math.max(0, (now - at) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${Math.floor(minutes)}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / 60 / 24)}d`
  const date = new Date(at)
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', year: '2-digit' },
  )
}

/** Where a row leads: a conversation, at an entry when there is one. */
type Target = { conversation: number; entry?: number }

/** Opens `target` on the Agent surface, revealing its entry, as the root row's landings do. */
function useOpen() {
  const actions = useUltimate()
  return ({ conversation, entry }: Target) => {
    if (entry !== undefined) events.emit('board:open', { conversation, entry })
    actions.showSurface('agent')
    actions.switchConversation(conversation)
  }
}

/** One event as one quiet line: an icon for its kind, what happened, a link where there is one, and its age. */
function Row({
  event,
  icon,
  target,
  title,
  trailing,
  now,
  children,
}: {
  event: EventRecord
  icon: ReactNode
  target?: Target
  title: string
  trailing?: ReactNode
  now: number
  children: ReactNode
}) {
  const open = useOpen()
  const at = Date.parse(event.at)
  const body = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
    </>
  )
  return (
    <li
      className="flex min-w-0 items-start gap-1.5 px-3 py-[3px] font-mono pointer-coarse:py-1.5 text-[10.5px] leading-[18px] text-muted-foreground hover:bg-muted/40"
      data-activity={event.name}
    >
      {target ? (
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => open(target)}
          title={`${title} · open #${target.conversation}${target.entry !== undefined ? `/${target.entry}` : ''}`}
          type="button"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-start gap-2" title={title}>
          {body}
        </span>
      )}
      {trailing}
      <time
        className="w-7 shrink-0 text-right text-muted-foreground/60 tabular-nums"
        dateTime={event.at}
        title={new Date(at).toLocaleString()}
      >
        {ago(at, now)}
      </time>
    </li>
  )
}

const iconClass = 'mt-[3px] size-3 shrink-0'
const name = 'min-w-0 truncate font-sans text-[12px] text-foreground/85'

type Props<T> = { event: EventRecord<EventData<T>>; now: number }

function Landing({ event, now }: Props<typeof SubmissionLanded>) {
  const github = useGithubRepo()
  const landing = event.data
  return (
    <Row
      event={event}
      icon={<GitMergeIcon className={cn(iconClass, 'text-success')} />}
      now={now}
      target={{ conversation: landing.conversationId, entry: landing.at }}
      title={`Landed ${landing.sha.slice(0, 7)} on ${landing.target}${landing.title ? ` · ${landing.title}` : ''}`}
      trailing={
        <CommitCount
          className="text-muted-foreground/80"
          count={landing.commitCount}
          href={github ? compareUrl(github, landing.base, landing.sha) : undefined}
          range={`${landing.base}...${landing.sha}`}
        />
      }
    >
      {landing.feature && <FeatureTag className="shrink-0" feature={landing.feature} />}
      <span className={name}>{landing.title || landing.sha.slice(0, 7)}</span>
    </Row>
  )
}

function Branch({ event, now }: Props<typeof Branched>) {
  const { id, from } = event.data
  return (
    <Row
      event={event}
      icon={<GitForkIcon className={cn(iconClass, 'text-brand')} />}
      now={now}
      target={{ conversation: id }}
      title={`Branched from #${from}`}
    >
      <ConversationRef className="font-sans text-[12px] text-foreground/85" id={id} />
      <span className="shrink-0">from #{from}</span>
    </Row>
  )
}

function Root({ event, now }: Props<typeof Rooted>) {
  const { id, intent } = event.data
  return (
    <Row
      event={event}
      icon={<ScrollTextIcon className={cn(iconClass, 'text-brand')} />}
      now={now}
      target={{ conversation: id }}
      title={`New root: ${intent}`}
    >
      <span className="shrink-0">new root</span>
      <ConversationRef
        className="font-sans text-[12px] text-foreground/85"
        id={id}
        title={intent}
      />
    </Row>
  )
}

function Notice({ event, now }: Props<typeof NoticeEvent>) {
  const { extension, message, level } = event.data
  const warning = level === 'warning'
  const conversation = event.context?.conversationId
  return (
    <Row
      event={event}
      icon={
        <TriangleAlertIcon
          className={cn(iconClass, warning ? 'text-warning' : 'text-muted-foreground')}
        />
      }
      now={now}
      target={conversation === undefined ? undefined : { conversation }}
      title={`${extension}: ${message}`}
    >
      <span className="line-clamp-2 min-w-0 font-sans text-[12px] break-words text-foreground/80">
        <span className={cn('mr-1.5 font-mono text-[10.5px]', warning && 'text-warning')}>
          {extension}
        </span>
        {message}
      </span>
    </Row>
  )
}

function Activity({ event, now }: { event: ActivityEvent; now: number }) {
  if (SubmissionLanded.is(event)) return <Landing event={event} now={now} />
  if (Branched.is(event)) return <Branch event={event} now={now} />
  if (Rooted.is(event)) return <Root event={event} now={now} />
  if (NoticeEvent.is(event)) return <Notice event={event} now={now} />
  return null
}

/** Events newest first, one line each; quiet when there are none. */
export function Feed({ events: list, now }: { events: readonly ActivityEvent[]; now: number }) {
  if (list.length === 0)
    return (
      <div className="px-3 py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
        quiet · nothing has happened yet
      </div>
    )
  return (
    <ul className="flex flex-col">
      {list.map((event) => (
        <Activity event={event} key={event.id} now={now} />
      ))}
    </ul>
  )
}
