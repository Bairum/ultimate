import { LoaderCircleIcon, MailIcon, ServerIcon, TriangleAlertIcon, TruckIcon } from 'lucide-react'
import { useEffect } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { cn, defineWebExtension, shortenPath, useAction, useSystem } from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import type { Transition } from '../../cloud/protocol.ts'
import { phaseOf, TransitionCard } from '../cloud/transition.tsx'
import type { Fleet, FleetProject, MoveEnded, SyncReport } from './types.ts'

function Dot({ on }: { on: boolean }) {
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', on ? 'bg-success' : 'bg-muted-foreground/40')}
    />
  )
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** A small amber line, cut to one line; the full text shows on hover. */
function Warning({ text }: { text: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-amber-700 dark:text-amber-300">
      <TriangleAlertIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
    </div>
  )
}

/** One project: its writer, standby chips and this machine's warnings; a move in flight embeds the move card. */
function ProjectRow({ project, machine }: { project: FleetProject; machine: string }) {
  const local = project.local
  const home = useSystem()?.machine.home
  const moving = project.transition && phaseOf(project.transition) === 'running'
  return (
    <li className="space-y-1 px-3 py-2" data-sync-project={project.key}>
      <div className="flex min-w-0 items-center gap-2 leading-5">
        <span className="min-w-0 truncate text-foreground/90" title={project.key}>
          {project.name}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <Dot on={project.writer.online} />
          {project.writer.machine ?? (local && !project.standbys.length ? 'local only' : 'free')}
          {project.writer.machine === machine && machine && (
            <span className="text-muted-foreground/60">· here</span>
          )}
        </span>
        <span className="ml-auto flex min-w-0 flex-wrap justify-end gap-1">
          {project.standbys.map((standby) => (
            <span
              className="flex items-center gap-1 rounded-sm border border-border/70 px-1.5 text-[10.5px] text-muted-foreground"
              key={standby.machine}
              title={`standby, last seen ${new Date(standby.lastSeen).toLocaleString()}`}
            >
              <Dot on={standby.connected} />
              {standby.machine}
            </span>
          ))}
        </span>
      </div>
      {local?.sync?.catchingUp && (
        <div className="text-muted-foreground">
          catching up
          {local.sync.conversations
            ? ` ${local.sync.conversations.synced}/${local.sync.conversations.total} conversations`
            : ` · ${local.sync.backlog} behind`}
        </div>
      )}
      {local && local.missing.length > 0 && (
        <Warning text={`missing secrets: ${local.missing.join(', ')}`} />
      )}
      {local && local.stale.length > 0 && (
        <Warning
          text={`${plural(local.stale.length, 'stale database')} in ${shortenPath(local.home, { home })}`}
        />
      )}
      {local && local.keptRefs.length > 0 && (
        <Warning
          text={`${plural(local.keptRefs.length, 'kept ref')}: ${local.keptRefs.join(', ')}`}
        />
      )}
      {moving && <TransitionCard className="mt-1.5 shadow-none" transition={project.transition!} />}
    </li>
  )
}

/** The fleet as one quiet card: machines with their online dots, then one row per project. */
export function FleetCard({ fleet }: { fleet: Fleet }) {
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/60 bg-card text-left font-mono text-[11.5px] shadow-xs"
      data-sync-fleet
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-3 py-1.5">
        <ServerIcon className="size-3.5 shrink-0 text-brand" />
        <span className="text-[12px] text-foreground/90">Fleet</span>
        {fleet.machines.map((machine) => (
          <span className="flex items-center gap-1.5 text-muted-foreground" key={machine.machine}>
            <Dot on={machine.online} />
            {machine.machine}
            {machine.machine === fleet.machine && (
              <span className="text-muted-foreground/60">(this)</span>
            )}
          </span>
        ))}
      </header>
      {fleet.error && (
        <p className="border-b border-border/60 px-3 py-1.5 font-sans text-[12px] text-error/90">
          {fleet.error}
        </p>
      )}
      {fleet.projects.length ? (
        <ul className="divide-y divide-border/50">
          {fleet.projects.map((project) => (
            <ProjectRow key={project.key} machine={fleet.machine} project={project} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2 text-muted-foreground">No projects yet.</p>
      )}
    </section>
  )
}

function Pending({ name, title }: { name: string; title: string }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
      <LoaderCircleIcon className="size-3 animate-spin text-brand" />
      {name} {title}
    </div>
  )
}

function FleetCall({ call, core }: { call: ToolCallView; core: React.ReactNode }) {
  if (call.status === 'error' || call.status === 'interrupted') return core
  const fleet = call.details as Fleet | undefined
  if (!fleet?.projects) return <Pending name="fleet" title="reading the fleet…" />
  return <FleetCard fleet={fleet} />
}

/** A move's card while it runs, polled from the project's server or the cloud; the final state once it ended. */
function MoveCall({ call, core }: { call: ToolCallView; core: React.ReactNode }) {
  const project = typeof call.args.project === 'string' ? call.args.project : undefined
  const started = (call.details as { id?: string } | undefined)?.id
  const state = useAction<{ transition: Transition | null }>(
    'sync',
    'transition',
    { project: project ?? '' },
    { enabled: !!project && !!started, onError: () => {} },
  )
  const transition = state.data?.transition
  const running = transition && transition.id === started && phaseOf(transition) === 'running'
  const { refetch } = state
  useEffect(() => {
    if (!started || (transition && !running)) return undefined
    const timer = setInterval(() => void refetch(), 1500)
    return () => clearInterval(timer)
  }, [started, transition, running, refetch])
  if (call.status === 'error' || call.status === 'interrupted') return core
  if (!started) return <Pending name="move" title={`${project ?? ''}…`} />
  if (!transition || transition.id !== started)
    return <Pending name="move" title={`${project ?? ''} · waiting for its first step`} />
  return <TransitionCard transition={transition} />
}

/** The input that wakes @sync after a move ended. */
function MoveEntry({ entry }: { entry: EntryRecord }) {
  const data = entry.data as unknown as MoveEnded
  return (
    <div className="space-y-1.5" data-sync-move={data.transition.id}>
      <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <TruckIcon className="size-3.5 text-brand" />
        Move of {data.project.name} ended · @sync checks it
      </div>
      <TransitionCard transition={data.transition} />
    </div>
  )
}

/** A report from @sync in a project's @ultimate, like a board message. */
function ReportEntry({ entry }: { entry: EntryRecord }) {
  const data = entry.data as unknown as SyncReport
  return (
    <section className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/60">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MailIcon className="size-3.5 shrink-0 text-brand" />
        <span className="font-semibold text-brand">{data.from}</span>
        <span>Report · one-way</span>
      </header>
      <div className="min-w-0 px-3 py-3 text-[13px] leading-relaxed">
        <MessageResponse>{data.text}</MessageResponse>
      </div>
    </section>
  )
}

/** @sync's own conversation, a chat in the machine home; the fleet and move cards stay visible in it. */
const syncChat = (conversation: {
  label?: string
  title?: string
  parentConversationId?: number
}) =>
  conversation.label === 'agent' &&
  conversation.title === '@sync' &&
  conversation.parentConversationId === undefined

export default defineWebExtension({
  tools: { fleet: FleetCall, move: MoveCall },
  chat: { when: syncChat, tools: ['fleet', 'move', 'cancel', 'report'] },
  intro: {
    when: syncChat,
    title: '@sync moves your projects between machines.',
    hint: 'Ask for the fleet, or: move ultimate here.',
    placeholder: 'Ask @sync about your machines…',
  },
  entries: { 'sync.move': MoveEntry, 'sync.report': ReportEntry },
})
