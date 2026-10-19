import './front.css'
import { cn } from 'cn'
import { LoaderCircleIcon, NetworkIcon } from 'lucide-react'
import { StrictMode, useEffect, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { MachineHealth, ProviderHealth, Transition } from '../protocol.ts'

/** A row of `/api/directory` (`Project` in cloud/directory.ts, which runs in the Worker). */
interface Project {
  key: string
  name: string
  slug: string
  writer: { machine: string | null; online: boolean; lastSeen?: number; tailnet?: string }
  machines: {
    machine: string
    role: 'writer' | 'standby'
    connected: boolean
    lastSeen: number
    tailnet?: string
  }[]
  transition?: Transition
}

/** "Open on tailnet": the running writer, directly over Tailscale, skipping the cloud. Only while it is online. */
function Tailnet({ project }: { project: Project }) {
  const { machine, online, tailnet } = project.writer
  if (!online || !machine || !tailnet) return null
  return (
    <Button
      asChild
      className="h-6 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      size="xs"
      variant="ghost"
    >
      <a
        aria-label={`Open ${project.name} on ${machine} over the tailnet`}
        data-tailnet
        href={tailnet}
        title={`Open ${project.name} directly on ${machine}: ${tailnet}`}
      >
        <NetworkIcon className="size-3 opacity-70" />
        <span className="max-sm:hidden">Open on tailnet</span>
      </a>
    </Button>
  )
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`: the app's compact relative times. */
function ago(at: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 60 / 24)}d ago`
}

type Directory = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; rows: Project[] }

/**
 * The directory from `/api/directory` and each machine's provider health from `/api/health`, behind Access, refreshed
 * every 10 s. A failed refresh keeps the last list; health is optional and keeps its last list on failure too.
 */
function useDirectory() {
  const [directory, setDirectory] = useState<Directory>({ state: 'loading' })
  const [health, setHealth] = useState<MachineHealth[]>([])
  const [failing, setFailing] = useState(false)
  useEffect(() => {
    async function refreshHealth() {
      try {
        const response = await fetch('/api/health')
        if (response.ok) setHealth((await response.json()) as MachineHealth[])
      } catch {
        // The directory's own refresh reports an unreachable cloud; the machines keep their last report.
      }
    }
    async function refresh() {
      void refreshHealth()
      try {
        const response = await fetch('/api/directory')
        if (!response.ok) throw new Error(`${response.status}`)
        setDirectory({ state: 'loaded', rows: (await response.json()) as Project[] })
        setFailing(false)
      } catch {
        // Signed out or unreachable: say so, and keep what was loaded until the next refresh succeeds.
        setFailing(true)
        setDirectory((previous) => (previous.state === 'loaded' ? previous : { state: 'failed' }))
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 10000)
    return () => clearInterval(timer)
  }, [])
  return { directory, health, failing }
}

/** `12m`, `3h`: `ago()` without its suffix, for the compact provider row. */
const age = (at: number, now: number) => ago(at, now).replace(' ago', '')
/** A machine is online while a project lists it connected, or it reported within two hours. */
const ONLINE = 2 * 60 * 60 * 1000
/** A report older than this says when it came. */
const STALE = 90 * 60 * 1000

function Provider({ health, now }: { health: ProviderHealth; now: number }) {
  const at =
    health.state === 'ok' ? health.lastOk : health.state === 'failing' ? health.lastFail : undefined
  const error = health.state === 'failing' ? health.error : undefined
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-baseline gap-1"
      title={
        health.state === 'ok'
          ? `Last worked ${at === undefined ? '' : ago(at, now)}`
          : health.state === 'failing'
            ? `Failing${at === undefined ? '' : ` since ${ago(at, now)}`}${error ? `: ${error}` : ''}`
            : 'Not used or checked yet'
      }
    >
      <span className="text-foreground/85">{health.provider}</span>
      {health.state === 'ok' && <span className="text-success">✓</span>}
      {health.state === 'failing' && <span className="text-error">✗</span>}
      {health.state === 'unknown' && <span className="text-muted-foreground/60">?</span>}
      {error && <span className="max-w-40 truncate text-error/85">{error}</span>}
      {at !== undefined && <span className="text-muted-foreground/70">{age(at, now)}</span>}
    </span>
  )
}

/** One line per machine: its online dot and name, then each provider's state, age and short error. */
function Machines({
  health,
  connected,
  now,
}: {
  health: MachineHealth[]
  connected: Set<string>
  now: number
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[10.5px] font-normal tracking-wider text-muted-foreground uppercase">
        Machines
      </h2>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/40">
        {health.map((machine) => {
          const online = connected.has(machine.machine) || now - machine.at < ONLINE
          return (
            <li
              className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2 font-mono text-[11px]"
              key={machine.machine}
            >
              <span className="flex shrink-0 items-center gap-2">
                <span
                  className={cn(
                    'size-1.5 shrink-0 self-center rounded-full',
                    online ? 'bg-success' : 'bg-muted-foreground/40',
                  )}
                />
                <span className="font-sans text-[13px] font-medium text-foreground">
                  {machine.machine}
                </span>
              </span>
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-1 pl-3.5 sm:pl-1">
                {machine.providers.length ? (
                  machine.providers.map((provider, index) => (
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
              {now - machine.at > STALE && (
                <span
                  className="shrink-0 text-[10.5px] text-muted-foreground/60"
                  title={new Date(machine.at).toLocaleString()}
                >
                  reported {ago(machine.at, now)}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Up and down move between tailnet links, as in a list; Tab still walks them in order. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a[data-tailnet]')]
  const index = rows.indexOf(document.activeElement as HTMLAnchorElement)
  const next = rows[event.key === 'ArrowDown' ? index + 1 : index < 0 ? rows.length - 1 : index - 1]
  if (!next) return
  event.preventDefault()
  next.focus()
}

const steps: Record<Transition['step'], string> = {
  fetch: 'updating checkout',
  install: 'installing dependencies',
  checks: 'checking',
  handover: 'handover',
  download: 'downloading',
  branches: 'restoring branches',
  claim: 'claiming',
}
const mb = (bytes: number) => {
  const value = bytes / 1024 / 1024
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

/** A running move's current step: `→ rog · downloading 120 / 231 MB`; nothing once it ended. */
function moving(transition: Transition | undefined) {
  if (!transition || transition.error) return undefined
  const step = transition.steps.find((candidate) => candidate.name === transition.step)
  if (transition.step === 'claim' && step?.state === 'done') return undefined
  const detail =
    transition.step === 'download' && step?.total
      ? ` ${mb(step.done ?? 0)} / ${mb(step.total)} MB`
      : transition.step === 'handover' && step?.detail && transition.from
        ? `: ${transition.from} ${step.detail}`
        : ''
  return `→ ${transition.target} · ${steps[transition.step]}${detail}`
}

function Row({ project, now }: { project: Project; now: number }) {
  const { writer } = project
  const { lastSeen } = writer
  const standbys = project.machines.filter((machine) => machine.role === 'standby')
  const step = moving(project.transition)
  return (
    <li className="flex items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5 pointer-coarse:py-3">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              writer.online ? 'bg-success' : 'bg-muted-foreground/40',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {project.name}
          </span>
          <span
            className="min-w-0 shrink truncate font-mono text-[11px] text-muted-foreground"
            title={
              writer.machine === null
                ? 'Free: any standby machine may take it over'
                : writer.online || lastSeen === undefined
                  ? undefined
                  : `Last seen ${new Date(lastSeen).toLocaleString()}`
            }
          >
            {writer.machine === null
              ? 'free'
              : writer.online
                ? `runs on ${writer.machine}`
                : `${writer.machine} · offline${lastSeen === undefined ? '' : ` since ${ago(lastSeen, now)}`}`}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-3 pl-3.5 font-mono text-[10.5px] text-muted-foreground/70">
          <span className="min-w-0 flex-1 truncate" title={project.key}>
            {project.key}
          </span>
          {standbys.map((machine) => (
            <span
              className="shrink-0 rounded-sm border border-border/60 px-1 text-[10px] leading-4 text-muted-foreground/70"
              key={machine.machine}
              title={`Standby, ${machine.connected ? 'connected' : `last seen ${ago(machine.lastSeen, now)}`}`}
            >
              {machine.machine}
            </span>
          ))}
        </span>
        {step && (
          <span className="flex min-w-0 items-center gap-1.5 pl-3.5 font-mono text-[11px] text-brand">
            <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
            <span className="truncate">{step}</span>
          </span>
        )}
      </div>
      <Tailnet project={project} />
    </li>
  )
}

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border/80 px-4 py-8 text-center text-[13px] leading-relaxed text-muted-foreground">
      {children}
    </div>
  )
}

function Front() {
  const { directory, health, failing } = useDirectory()
  const now = Date.now()
  const connected = new Set(
    directory.state === 'loaded'
      ? directory.rows.flatMap((row) =>
          row.machines.filter((machine) => machine.connected).map((machine) => machine.machine),
        )
      : [],
  )
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-border/70 bg-sidebar px-3 font-mono text-[11.5px] text-muted-foreground">
        <span className="font-sans text-[11px] font-semibold tracking-[0.28em] text-brand">
          ULTIMATE
        </span>
        <span>projects</span>
        <span className="ml-auto flex items-center gap-1.5" title="Refreshes every 10 seconds">
          <span
            className={cn(
              'size-1.5 rounded-full',
              directory.state === 'loading'
                ? 'animate-pulse-dot bg-warning'
                : failing
                  ? 'bg-warning'
                  : 'bg-success',
            )}
          />
          <span className={cn(failing && 'text-warning')}>
            {directory.state === 'loading' ? 'loading…' : failing ? 'retrying…' : 'live'}
          </span>
        </span>
      </div>
      <main
        aria-busy={directory.state === 'loading'}
        aria-live="polite"
        className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-10 pb-16 md:pt-16"
        onKeyDown={moveFocus}
      >
        <header>
          <h1 className="text-[15px] font-medium text-foreground">Projects</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Every project that syncs here, and the machine it runs on. Open one on the tailnet to
            continue where it left off.
          </p>
        </header>
        {directory.state === 'loading' && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-[58px]" />
            <Skeleton className="h-[58px]" />
          </div>
        )}
        {directory.state === 'failed' && (
          <Message>
            Unable to load projects. Sign in and refresh to try again.
            <div className="mt-4">
              <Button onClick={() => location.reload()} size="sm" variant="outline">
                Reload
              </Button>
            </div>
          </Message>
        )}
        {directory.state === 'loaded' && !directory.rows.length && (
          <Message>
            No projects yet. Configure{' '}
            <code className="rounded-sm bg-muted px-1 font-mono text-[12px] text-foreground/85">
              cloud.url
            </code>{' '}
            and start Ultimate in a checkout with a GitHub origin.
          </Message>
        )}
        {directory.state === 'loaded' && directory.rows.length > 0 && (
          <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/40">
            {directory.rows.map((row) => (
              <Row key={row.slug} now={now} project={row} />
            ))}
          </ul>
        )}
        {health.length > 0 && <Machines connected={connected} health={health} now={now} />}
      </main>
    </div>
  )
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <Front />
  </StrictMode>,
)
