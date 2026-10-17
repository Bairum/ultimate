import './front.css'
import { cn } from 'cn'
import { StrictMode, useEffect, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/** A row of `/api/directory` (`Instance` in cloud/directory.ts, which runs in the Worker). */
interface Instance {
  machine: string
  project: string
  slug: string
  connected: boolean
  lastSeen: number
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

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

type Directory = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; rows: Instance[] }

/** The directory from `/api/directory`, behind Access, refreshed every 10 s. A failed refresh keeps the last list. */
function useDirectory() {
  const [directory, setDirectory] = useState<Directory>({ state: 'loading' })
  const [failing, setFailing] = useState(false)
  useEffect(() => {
    async function refresh() {
      try {
        const response = await fetch('/api/directory')
        if (!response.ok) throw new Error(`${response.status}`)
        setDirectory({ state: 'loaded', rows: (await response.json()) as Instance[] })
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

function Row({ instance, now }: { instance: Instance; now: number }) {
  const name = basename(instance.project)
  const conversations = `${instance.count} conversation${instance.count === 1 ? '' : 's'}`
  return (
    <li>
      <a
        className="flex flex-col gap-1 px-3 py-2.5 transition-colors pointer-coarse:py-3 outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        data-row
        href={`/p/${instance.slug}/`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              instance.connected ? 'bg-success' : 'bg-muted-foreground/40',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {name}
          </span>
          <span
            className="shrink-0 font-mono text-[11px] text-muted-foreground"
            title={
              instance.connected
                ? undefined
                : `Last seen ${new Date(instance.lastSeen).toLocaleString()}`
            }
          >
            {instance.connected ? 'running' : `offline · last seen ${ago(instance.lastSeen, now)}`}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-3 pl-3.5 font-mono text-[10.5px] text-muted-foreground/70">
          <span className="min-w-0 flex-1 truncate" title={instance.project}>
            {instance.project}
          </span>
          <span className="shrink-0">{conversations}</span>
        </span>
      </a>
    </li>
  )
}

function Machine({ machine, rows, now }: { machine: string; rows: Instance[]; now: number }) {
  const running = rows.filter((row) => row.connected).length
  return (
    <section aria-label={machine}>
      <h2 className="flex items-baseline gap-2 px-3 pb-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        <span className="min-w-0 flex-1 truncate">{machine}</span>
        <span className="shrink-0 tracking-normal normal-case text-muted-foreground/70">
          {running} of {rows.length} running
        </span>
      </h2>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/40">
        {rows.map((row) => (
          <Row instance={row} key={row.slug} now={now} />
        ))}
      </ul>
    </section>
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
  const machines = new Map<string, Instance[]>()
  if (directory.state === 'loaded')
    for (const row of directory.rows)
      machines.set(row.machine, [...(machines.get(row.machine) ?? []), row])
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-border/70 bg-sidebar px-3 font-mono text-[11.5px] text-muted-foreground">
        <span className="font-sans text-[11px] font-semibold tracking-[0.28em] text-brand">
          ULTIMATE
        </span>
        <span>instances</span>
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
          <h1 className="text-[15px] font-medium text-foreground">Instances</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Every Ultimate that syncs here, by machine. Open one to continue where it left off.
          </p>
        </header>
        {directory.state === 'loading' && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-[58px]" />
            <Skeleton className="h-[58px]" />
          </div>
        )}
        {directory.state === 'failed' && (
          <Message>
            Unable to load instances. Sign in and refresh to try again.
            <div className="mt-4">
              <Button onClick={() => location.reload()} size="sm" variant="outline">
                Reload
              </Button>
            </div>
          </Message>
        )}
        {directory.state === 'loaded' && !machines.size && (
          <Message>
            No instances yet. Configure{' '}
            <code className="rounded-sm bg-muted px-1 font-mono text-[12px] text-foreground/85">
              cloud.url
            </code>{' '}
            and start Ultimate.
          </Message>
        )}
        {[...machines].map(([machine, rows]) => (
          <Machine key={machine} machine={machine} now={now} rows={rows} />
        ))}
      </main>
    </div>
  )
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <Front />
  </StrictMode>,
)
