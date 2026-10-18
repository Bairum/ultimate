import './front.css'
import { cn } from 'cn'
import { StrictMode, useEffect, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/** A row of `/api/directory` (`Project` in cloud/directory.ts, which runs in the Worker). */
interface Project {
  key: string
  name: string
  slug: string
  writer: { machine: string | null; online: boolean; lastSeen?: number }
  machines: { machine: string; role: 'writer' | 'standby'; connected: boolean; lastSeen: number }[]
  count: number
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

/** The directory from `/api/directory`, behind Access, refreshed every 10 s. A failed refresh keeps the last list. */
function useDirectory() {
  const [directory, setDirectory] = useState<Directory>({ state: 'loading' })
  const [failing, setFailing] = useState(false)
  useEffect(() => {
    async function refresh() {
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
  return { directory, failing }
}

/** Up and down move between rows, as in a list; Tab still walks them in order. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a[data-row]')]
  const index = rows.indexOf(document.activeElement as HTMLAnchorElement)
  const next = rows[event.key === 'ArrowDown' ? index + 1 : index < 0 ? rows.length - 1 : index - 1]
  if (!next) return
  event.preventDefault()
  next.focus()
}

function Row({ project, now }: { project: Project; now: number }) {
  const { writer } = project
  const { lastSeen } = writer
  const standbys = project.machines.filter((machine) => machine.role === 'standby')
  const conversations = `${project.count} conversation${project.count === 1 ? '' : 's'}`
  return (
    <li>
      <a
        className="flex flex-col gap-1 px-3 py-2.5 transition-colors pointer-coarse:py-3 outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        data-row
        href={`/p/${project.slug}/`}
      >
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
          <span className="shrink-0">{conversations}</span>
        </span>
      </a>
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
  const { directory, failing } = useDirectory()
  const now = Date.now()
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
            Every project that syncs here, and the machine it runs on. Open one to continue where it
            left off.
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
      </main>
    </div>
  )
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <Front />
  </StrictMode>,
)
