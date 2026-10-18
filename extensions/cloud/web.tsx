import { cn } from 'cn'
import { KeyRoundIcon, LoaderCircleIcon, ServerIcon } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, defineWebExtension, errorMessage, projectBase, useSystem } from '@/sdk'
import type { CloudInfo, Transition } from '../../cloud/protocol.ts'
import type { CloudState } from './types.ts'
import { phaseOf, TransitionCard } from './transition.tsx'

// Locally the facet asks its own server (`cloud.state`, `moveHere`, `cancel`); in the cloud, at `/p/<slug>/`, it asks
// the project's replica (`/api/cloud`), which answers while the writer machine is off too.
const base = projectBase()
const inCloud = base !== ''

/** One poll shared by every component that reads it, running while any is mounted; a failed poll keeps the last value. */
function poll<T>(
  load: (signal: AbortSignal) => Promise<T>,
  every: (value: T | undefined) => number,
) {
  let value: T | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let generation = 0
  const listeners = new Set<() => void>()
  const tick = async () => {
    const current = ++generation
    clearTimeout(timer)
    controller?.abort()
    controller = new AbortController()
    try {
      const next = await load(controller.signal)
      if (current !== generation) return
      value = next
      for (const listener of listeners) listener()
    } catch {
      // Aborted, restarting or unreachable: keep what was loaded, and the next poll tries again.
    }
    if (current === generation && listeners.size) timer = setTimeout(tick, every(value))
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      if (listeners.size === 1) void tick()
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        generation++
        clearTimeout(timer)
        controller?.abort()
      }
    },
    get: () => value,
    refresh: () => void tick(),
  }
}

const running = (transition?: Transition | null) =>
  !!transition && phaseOf(transition) === 'running'

const local = poll(
  (signal) => api.action<CloudState>('cloud', 'state', null, { signal }),
  (state) =>
    state?.status === 'off'
      ? 30_000
      : running(state?.transition) || state?.progress || state?.sync?.catchingUp
        ? 1000
        : 4000,
)
const remote = poll(
  async (signal) => {
    // oxlint-disable-next-line ultimate/no-raw-stream -- the replica answers /api/cloud itself; no server facet does
    const response = await fetch(`${base}/api/cloud`, { signal })
    if (!response.ok) throw new Error(`${response.status}`)
    return (await response.json()) as CloudInfo
  },
  (info) => (running(info?.transition) ? 1000 : 3000),
)
const useLocal = () => useSyncExternalStore(local.subscribe, local.get)
const useRemote = () => useSyncExternalStore(remote.subscribe, remote.get)

const moveHere = async (force = false) => {
  await api.action('cloud', 'moveHere', { force })
  local.refresh()
}
const cancelHere = async () => {
  await api.action('cloud', 'cancel')
  local.refresh()
}
/** `POST /api/cloud/<route>` of this project; rejects with the replica's error. */
async function cloudPost(route: 'move' | 'cancel', body: object = {}) {
  // oxlint-disable-next-line ultimate/no-raw-stream -- the replica answers /api/cloud itself; no server facet does
  const response = await fetch(`${base}/api/cloud/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `${response.status} ${response.statusText}`)
  }
  remote.refresh()
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
function ago(at: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 60 / 24)}d ago`
}

// Transitions this page saw running: their success shows until dismissed, an older one's does not.
const watched = new Set<string>()
/** The last dismissed transition, for every tab of this browser. */
const dismissed = {
  key: 'ultimate.cloud.dismissed',
  listeners: new Set<() => void>(),
  subscribe: (listener: () => void) => {
    dismissed.listeners.add(listener)
    return () => dismissed.listeners.delete(listener)
  },
  get: () => localStorage.getItem(dismissed.key),
  set: (id: string) => {
    localStorage.setItem(dismissed.key, id)
    for (const listener of dismissed.listeners) listener()
  },
}
/**
 * Whether to show `transition`: while it runs, after it failed until dismissed (or the next one starts), and after it
 * succeeded while this page watched it.
 */
function useShown(transition?: Transition | null) {
  const last = useSyncExternalStore(dismissed.subscribe, dismissed.get)
  if (!transition) return { shown: false, dismiss: () => {} }
  const phase = phaseOf(transition)
  if (phase === 'running') watched.add(transition.id)
  return {
    shown: transition.id !== last && (phase !== 'done' || watched.has(transition.id)),
    dismiss: () => dismissed.set(transition.id),
  }
}

function Dot({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        on ? 'bg-success' : 'bg-muted-foreground/40',
        className,
      )}
    />
  )
}

/** One machine in a picker: its dot, name, state and what it lacks, then what can be done about it. */
function MachineRow({
  name,
  on,
  state,
  missing,
  children,
}: {
  name: string
  on: boolean
  state: string
  missing?: string[]
  children?: ReactNode
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 px-3 py-1.5">
      <Dot on={on} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-foreground/90">{name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{state}</span>
        {missing && missing.length > 0 && (
          <span
            className="flex min-w-0 items-center gap-1 text-[11px] text-warning"
            title="Secrets the writer has and this machine lacks"
          >
            <KeyRoundIcon className="size-3 shrink-0" />
            <span className="truncate">missing {missing.join(', ')}</span>
          </span>
        )}
      </span>
      {children}
    </li>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[10.5px] tracking-wider text-muted-foreground uppercase">
      {children}
    </div>
  )
}

/** A button that runs `action`, showing its failure beside the picker. */
function useAct() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const act = (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    action()
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }
  return { busy, error, act }
}

// Locally: this machine, the writer it hears about, "Move here".

/** "runs on rog", "rog · offline", "free": who has the project, as this machine hears it. */
function holder(state: CloudState, released: boolean) {
  const { writer } = state
  if (!state.role || !writer) return 'connecting to the cloud…'
  if (state.free || writer.machine === null)
    return released ? 'free · released by this machine' : 'free'
  if (writer.machine === state.machine) return `runs on ${writer.machine} (this machine)`
  return writer.online ? `runs on ${writer.machine}` : `${writer.machine} · offline`
}

function LocalTransition({
  state,
  compact,
  className,
}: {
  state: CloudState
  compact?: boolean
  className?: string
}) {
  const { shown, dismiss } = useShown(state.transition)
  if (!shown || !state.transition) return null
  const own = state.transition.target === state.machine
  return (
    <TransitionCard
      className={className}
      compact={compact}
      source={state.transition.from === state.machine}
      onCancel={own ? cancelHere : undefined}
      onDismiss={dismiss}
      onForce={own ? () => moveHere(true) : undefined}
      transition={state.transition}
    />
  )
}

/** The standby page's controls: who runs the project, what this machine lacks, "Move here", the move in progress. */
function LocalStandby() {
  const state = useLocal()
  const released = useSystem()?.standby?.released === true
  const { busy, error, act } = useAct()
  if (state?.status !== 'on') return null
  const moving = running(state.transition) && state.transition!.target === state.machine
  return (
    <div className="flex w-full flex-col items-center gap-3">
      <div className="flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
        <Dot on={!!state.writer?.online} />
        {holder(state, released)}
      </div>
      {state.missing.length > 0 && (
        <p className="flex items-center gap-1.5 font-mono text-[11.5px] text-warning">
          <KeyRoundIcon className="size-3 shrink-0" />
          Missing here: {state.missing.join(', ')}
        </p>
      )}
      {state.blocked && !moving && (
        <p className="text-[12px] leading-relaxed text-muted-foreground">{state.blocked}</p>
      )}
      {!moving && (
        <Button disabled={busy || !!state.blocked} onClick={() => act(() => moveHere())} size="sm">
          {state.free && released ? 'Resume here' : 'Move here'}
        </Button>
      )}
      {error && <p className="text-[12px] text-error">{error}</p>}
      {!error && state.lastError && !state.transition && (
        <p className="text-[12px] text-error/90">{state.lastError}</p>
      )}
      <LocalTransition className="w-full" state={state} />
    </div>
  )
}

function LocalPicker({ state }: { state: CloudState }) {
  const released = useSystem()?.standby?.released === true
  const { busy, error, act } = useAct()
  const { writer, machine = 'this machine' } = state
  const here = state.role === 'writer'
  const moving = running(state.transition)
  return (
    <>
      <Heading>Where this project runs</Heading>
      <ul className="pb-1">
        {writer?.machine && writer.machine !== machine && (
          <MachineRow
            name={writer.machine}
            on={writer.online}
            state={writer.online ? 'running' : 'holds the project · offline'}
          />
        )}
        <MachineRow
          missing={state.missing}
          name={`${machine} (this machine)`}
          on={!!state.role}
          state={
            here
              ? 'running'
              : !state.role
                ? 'connecting…'
                : state.free
                  ? 'standby · the project is free'
                  : 'standby'
          }
        >
          {state.role === 'standby' && (
            <Button
              className="h-6 font-sans text-[12px]"
              disabled={busy || moving || !!state.blocked}
              onClick={() => act(() => moveHere())}
              size="xs"
              title={state.blocked}
              variant="outline"
            >
              {state.free && released ? 'Resume here' : 'Move here'}
            </Button>
          )}
        </MachineRow>
      </ul>
      {state.sync?.catchingUp && (
        <p className="flex items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
          Catching up
          {state.sync.conversations
            ? ` ${state.sync.conversations.synced}/${state.sync.conversations.total} conversations`
            : '…'}
        </p>
      )}
      {state.role === 'standby' && state.blocked && (
        <p className="border-t border-border/60 px-3 py-1.5 font-sans text-[12px] text-muted-foreground">
          {state.blocked}
        </p>
      )}
      {error && <p className="px-3 pb-2 font-sans text-[12px] text-error">{error}</p>}
      <LocalTransition className="m-2 shadow-none" state={state} />
    </>
  )
}

// In the cloud: every machine the replica knows, "Run here".

function CloudTransition({ info, className }: { info: CloudInfo; className?: string }) {
  const { shown, dismiss } = useShown(info.transition)
  const transition = info.transition
  if (!shown || !transition) return null
  return (
    <TransitionCard
      className={className}
      onCancel={() => cloudPost('cancel')}
      onDismiss={dismiss}
      onForce={() => cloudPost('move', { machine: transition.target, force: true })}
      transition={transition}
    />
  )
}

/** The machine picker: the lease holder, standbys with a checkout, machines not connected, and what each lacks. */
function CloudPicker({ info }: { info: CloudInfo }) {
  const { busy, error, act } = useAct()
  const moving = running(info.transition)
  const machines = info.machines.toSorted(
    (a, b) =>
      Number(b.role === 'writer') - Number(a.role === 'writer') ||
      Number(b.connected) - Number(a.connected) ||
      a.machine.localeCompare(b.machine),
  )
  return (
    <>
      <Heading>Run on…</Heading>
      <ul className="pb-1">
        {machines.map((machine) => (
          <MachineRow
            key={machine.machine}
            missing={machine.missingSecrets}
            name={machine.machine}
            on={machine.connected}
            state={
              machine.role === 'writer'
                ? info.lease?.online
                  ? 'running'
                  : `holds the project · offline since ${ago(machine.lastSeen)}`
                : machine.connected
                  ? 'standby · checkout ready'
                  : `not connected · seen ${ago(machine.lastSeen)}`
            }
          >
            {machine.role === 'standby' && (
              <Button
                className="h-6 font-sans text-[12px]"
                disabled={busy || moving || !machine.connected}
                onClick={() => act(() => cloudPost('move', { machine: machine.machine }))}
                size="xs"
                title={machine.connected ? undefined : `${machine.machine} is not connected`}
                variant="outline"
              >
                Run here
              </Button>
            )}
          </MachineRow>
        ))}
      </ul>
      {error && <p className="px-3 pb-2 font-sans text-[12px] text-error">{error}</p>}
      <CloudTransition className="m-2 shadow-none" info={info} />
    </>
  )
}

/** The holder as the status line names it: `on haza-pc`, `haza-pc · offline` or `free`. */
function cloudHolder(info: CloudInfo) {
  const lease = info.lease
  if (!lease || lease.machine === null) return 'free'
  return lease.online ? `on ${lease.machine}` : `${lease.machine} · offline`
}

const statusButton =
  '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent'

function ExecutorButton({
  label,
  moving,
  warn,
  children,
}: {
  label: string
  moving: boolean
  warn?: boolean
  children: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(statusButton, moving && 'text-brand', warn && !moving && 'text-warning')}
          data-cloud-executor
          title="Where this project runs"
          type="button"
        >
          {moving ? (
            <LoaderCircleIcon className="size-3 animate-spin" />
          ) : (
            <ServerIcon className="size-3" />
          )}
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0 font-mono" side="top">
        {children}
      </PopoverContent>
    </Popover>
  )
}

function LocalExecutor() {
  const state = useLocal()
  if (!state || state.status === 'off') return null
  if (state.status === 'local')
    return (
      <span
        className="flex items-center gap-1.5 text-muted-foreground/70"
        title="The project has no GitHub origin, so it does not sync and runs on this machine only"
      >
        <ServerIcon className="size-3" />
        local only
      </span>
    )
  const label =
    state.role === 'writer'
      ? `on ${state.machine}`
      : state.role === 'standby'
        ? state.free
          ? 'free'
          : `standby · runs on ${state.writer?.machine}`
        : `${state.machine} · connecting`
  return (
    <ExecutorButton
      label={label}
      moving={running(state.transition)}
      warn={state.role === 'writer' && state.missing.length > 0}
    >
      <LocalPicker state={state} />
    </ExecutorButton>
  )
}

function CloudExecutor() {
  const info = useRemote()
  if (!info?.lease) return null
  return (
    <ExecutorButton
      label={cloudHolder(info)}
      moving={running(info.transition)}
      warn={!info.lease.online}
    >
      <CloudPicker info={info} />
    </ExecutorButton>
  )
}

// Right-aligned on wider screens, clear of the notices at the top centre.
const banner =
  'pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-3 md:justify-end'

/** On the serving writer: a move to another machine, before this page switches to standby. */
function LocalBanner() {
  const state = useLocal()
  if (state?.role !== 'writer' || !state.transition || state.transition.target === state.machine)
    return null
  return (
    <div className={banner}>
      <LocalTransition className="pointer-events-auto w-full max-w-md" compact state={state} />
    </div>
  )
}

/** In the cloud: the move in progress, or while no machine serves the project, a way to run it on one. */
function CloudBanner() {
  const info = useRemote()
  if (!info) return null
  return (
    <div className={banner}>
      <CloudTransition className="pointer-events-auto w-full max-w-md" info={info} />
    </div>
  )
}

/** In the cloud while no machine serves the project: who is off, and "Run on…" to start it on another. */
function CloudOffline() {
  const info = useRemote()
  const offline = useSystem()?.offline === true
  if (!info || !offline) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          data-cloud-run-on
          type="button"
        >
          <Dot on={false} />
          <span className="max-md:hidden">
            {info.lease?.machine ? `${info.lease.machine} is offline · ` : 'not running · '}
          </span>
          <span className="text-foreground/85">Run on…</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0 font-mono" side="bottom">
        <CloudPicker info={info} />
      </PopoverContent>
    </Popover>
  )
}

/** The standby page in the cloud lists the machines to run the project on. */
function CloudStandby() {
  const info = useRemote()
  if (!info) return null
  return (
    <div className="w-full rounded-md border border-border bg-card text-left font-mono">
      <CloudPicker info={info} />
    </div>
  )
}

export default defineWebExtension({
  slots: {
    standby: [inCloud ? CloudStandby : LocalStandby],
    'statusline.right': [inCloud ? CloudExecutor : LocalExecutor],
    'conversation.overlay': [inCloud ? CloudBanner : LocalBanner],
    'header.right': inCloud ? [CloudOffline] : [],
  },
})
