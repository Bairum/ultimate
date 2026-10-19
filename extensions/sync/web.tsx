import { LoaderCircleIcon, MailIcon, ServerIcon, TriangleAlertIcon, TruckIcon } from 'lucide-react'
import { useEffect } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { cn, defineWebExtension, Fold, provide, shortenPath, useAction, useSystem } from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import type { ProviderHealth } from '../../cloud/protocol.ts'
import { TransitionAction } from './refs.ts'
import { MoveHelp, phaseOf, TransitionCard } from '../cloud/ui.tsx'
import { AskSync } from './ui.tsx'
import { polling } from './moves.ts'
import type { Fleet, FleetProject, MoveEnded, SyncReport } from './types.ts'

function Dot({ on }: { on: boolean }) {
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', on ? 'bg-success' : 'bg-muted-foreground/40')}
    />
  )
}

/** `now`, `12m`, `3h`, `2d`: the provider row's compact ages. */
function ago(at: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 60 / 24)}d`
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
      {local?.login && !local.login.ok && (
        <Warning
          text={
            local.login.error
              ? `${local.login.provider} failing: ${local.login.error}`
              : `no model login for ${local.login.provider}`
          }
        />
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

/** `anthropic ✗ invalid_grant 3h`, like the cloud front page: ✓ ok, ✗ failing with its short error, ? unknown. */
function Provider({ health, now }: { health: ProviderHealth; now: number }) {
  const at =
    health.state === 'ok' ? health.lastOk : health.state === 'failing' ? health.lastFail : undefined
  const error = health.state === 'failing' ? health.error : undefined
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-baseline gap-1"
      title={
        health.state === 'ok'
          ? `Last worked ${at === undefined ? '' : `${ago(at, now)} ago`}`
          : health.state === 'failing'
            ? `Failing${at === undefined ? '' : ` since ${ago(at, now)} ago`}${error ? `: ${error}` : ''}`
            : 'Not used or checked yet'
      }
    >
      <span className="text-foreground/85">{health.provider}</span>
      {health.state === 'ok' && <span className="text-success">✓</span>}
      {health.state === 'failing' && <span className="text-error">✗</span>}
      {health.state === 'unknown' && <span className="text-muted-foreground/60">?</span>}
      {error && <span className="max-w-40 truncate text-error/85">{error}</span>}
      {at !== undefined && <span className="text-muted-foreground/70">{ago(at, now)}</span>}
    </span>
  )
}

/** One line per machine with a health report: its name, then each provider. */
function Providers({ fleet }: { fleet: Fleet }) {
  const reported = fleet.machines.filter((machine) => machine.health)
  if (!reported.length) return null
  const now = Date.now()
  return (
    <ul className="space-y-0.5 border-b border-border/60 px-3 py-1.5" data-sync-providers>
      {reported.map((machine) => (
        <li
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
          key={machine.machine}
        >
          <span className="w-16 shrink-0 truncate text-muted-foreground" title={machine.machine}>
            {machine.machine}
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            {machine.health!.length ? (
              machine.health!.map((provider, index) => (
                <span
                  className="inline-flex min-w-0 items-baseline gap-1.5"
                  key={provider.provider}
                >
                  {index > 0 && <span className="text-muted-foreground/40">·</span>}
                  <Provider health={provider} now={now} />
                </span>
              ))
            ) : (
              <span className="text-muted-foreground/70">no providers</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The fleet as one quiet card: machines with their online dots, their providers, then one row per project. */
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
      <Providers fleet={fleet} />
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
  const state = useAction(
    TransitionAction,
    { project: project ?? '' },
    { enabled: !!project && !!started, onError: () => {} },
  )
  const transition = state.data?.transition
  const live = polling(started, transition, call.startedAt ?? 0)
  const { refetch } = state
  useEffect(() => {
    if (!live) return undefined
    const timer = setInterval(() => void refetch(), 1500)
    return () => clearInterval(timer)
  }, [live, refetch])
  if (call.status === 'error' || call.status === 'interrupted') return core
  if (!started) return <Pending name="move" title={`${project ?? ''}…`} />
  if (transition && transition.id !== started && !live)
    return <Pending name="move" title={`${project ?? ''} · replaced by a later move`} />
  if (!transition || transition.id !== started)
    return <Pending name="move" title={`${project ?? ''} · waiting for its first step`} />
  return <TransitionCard transition={transition} />
}

/** The input that wakes @sync after a move ended. */
function MoveEntry({ entry }: { entry: EntryRecord }) {
  const data = entry.data as unknown as MoveEnded
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <TruckIcon className="size-3 shrink-0 text-brand" />
          <span className="min-w-0 truncate">Move of {data.project.name} ended</span>
        </>
      }
    >
      <div className="space-y-1.5" data-sync-move={data.transition.id}>
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <TruckIcon className="size-3.5 text-brand" />
          Move of {data.project.name} ended · @sync checks it
        </div>
        <TransitionCard transition={data.transition} />
      </div>
    </Fold>
  )
}

/** A report from @sync in a project's @ultimate, like a board message. */
function ReportEntry({ entry }: { entry: EntryRecord }) {
  const data = entry.data as unknown as SyncReport
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <MailIcon className="size-3 shrink-0 text-brand" />
          <span className="shrink-0 text-brand">{data.from}</span>
          <span className="shrink-0">report · one-way</span>
        </>
      }
    >
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
    </Fold>
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
  provides: [provide(MoveHelp, () => <AskSync />)],
})
