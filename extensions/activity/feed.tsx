import {
  CircleDotIcon,
  GitForkIcon,
  GitMergeIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { cn, events, useUltimate } from '@/sdk'
import type { EventRecord } from '@/sdk'
import { ago, ConversationRef, FeatureTag } from '../conversations/ui.tsx'
import { CommitCount, useGithubRepo } from '../workspaces/ui.tsx'

// The parts of each event's data a row shows. The landing and branch tokens live in workspaces/api.ts and
// lineage/api.ts, which are server contracts browser code cannot import, so their data shapes are restated here.
type Landed = {
  conversationId: number
  at: number
  sha: string
  base: string
  target: string
  title: string
  feature?: string
  commitCount: number
}
type Branched = { id: number; from: number; at: number; intent: string }
type Rooted = { id: number; intent: string }
type Notice = { extension: string; message: string; level: string }

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

function Landing({ event, now }: { event: EventRecord<Landed>; now: number }) {
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
          href={github ? `${github}/compare/${landing.base}...${landing.sha}` : undefined}
        />
      }
    >
      {landing.feature && <FeatureTag className="shrink-0" feature={landing.feature} />}
      <span className={name}>{landing.title || landing.sha.slice(0, 7)}</span>
    </Row>
  )
}

function Branch({ event, now }: { event: EventRecord<Branched>; now: number }) {
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

function Root({ event, now }: { event: EventRecord<Rooted>; now: number }) {
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

function NoticeRow({ event, now }: { event: EventRecord<Notice>; now: number }) {
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

/** An event this feed has no row for yet, by its name. */
function Other({ event, now }: { event: EventRecord; now: number }) {
  return (
    <Row
      event={event}
      icon={<CircleDotIcon className={cn(iconClass, 'text-muted-foreground/60')} />}
      now={now}
      title={event.name}
    >
      <span className="truncate">{event.name}</span>
    </Row>
  )
}

const rows: Record<string, (props: { event: EventRecord<never>; now: number }) => ReactNode> = {
  'workspaces.landed': Landing,
  'lineage.branched': Branch,
  'lineage.rooted': Root,
  'ultimate.notice': NoticeRow,
}

/** Events newest first, one line each; quiet when there are none. */
export function Feed({ events: list, now }: { events: readonly EventRecord[]; now: number }) {
  if (list.length === 0)
    return (
      <div className="px-3 py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
        quiet · nothing has happened yet
      </div>
    )
  return (
    <ul className="flex flex-col">
      {list.map((event) => {
        const Kind = rows[event.name] ?? Other
        return <Kind event={event as EventRecord<never>} key={event.id} now={now} />
      })}
    </ul>
  )
}
