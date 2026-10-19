import { cn } from 'cn'
import { KeyRoundIcon, LoaderCircleIcon, ServerIcon } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, defineWebExtension, errorMessage, Provided, useSystem } from '@/sdk'
import type { Transition } from '../../cloud/protocol.ts'
import type { CloudState } from './types.ts'
import { movedAway, phaseOf, TransitionCard } from './transition.tsx'
import { MoveHelp } from './ui.tsx'
import { BackupAction, CancelAction, MoveHereAction, StateAction } from './refs.ts'

/** What another extension offers for help with moves: sync's "Ask @sync" link. */
const Help = () => (
  <Provided input={null} point={MoveHelp}>
    {(help) => help}
  </Provided>
)

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
  (signal) => api.action(StateAction, null, { signal }),
  (state) =>
    state?.status === 'off'
      ? 30_000
      : running(state?.transition) || state?.progress || state?.backup
        ? 1000
        : 4000,
)
const useLocal = () => useSyncExternalStore(local.subscribe, local.get)

const moveHere = async (force = false) => {
  await api.action(MoveHereAction, { force })
  local.refresh()
}
const backUp = async () => {
  const done = api.action(BackupAction)
  // The upload's progress shows as soon as the server started it.
  setTimeout(local.refresh, 300)
  await done.finally(local.refresh)
}
const cancelHere = async () => {
  await api.action(CancelAction)
  local.refresh()
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

/** `just now`, `12m ago`, `3h ago`, `2d ago`. */
function since(at: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 60 / 24)}d ago`
}
const mb = (bytes: number) => {
  const value = bytes / 1024 / 1024
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

/** On the writer: when the project was last backed up, "Back up now", and the upload while it runs. */
function BackupRow({ state }: { state: CloudState }) {
  const { busy, error, act } = useAct()
  const { lastBackup, backup } = state
  const uploading = !!backup
  return (
    <div className="space-y-1 border-t border-border/60 px-3 py-2" data-cloud-backup>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-foreground/90">
            {uploading ? 'Backing up…' : 'Backup'}
          </span>
          <span
            className="block truncate text-[11px] text-muted-foreground"
            title={lastBackup ? new Date(lastBackup.at).toLocaleString() : undefined}
          >
            {uploading && backup.total > 0
              ? `${mb(backup.done)} / ${mb(backup.total)} MB`
              : lastBackup
                ? `Last backup: ${since(lastBackup.at)} · ${mb(lastBackup.bytes)} MB`
                : 'No backup yet'}
          </span>
        </span>
        <Button
          className="h-6 font-sans text-[12px]"
          disabled={busy || uploading || running(state.transition)}
          onClick={() => act(backUp)}
          size="xs"
          title="Upload an encrypted snapshot now; this machine keeps the project"
          variant="outline"
        >
          {uploading ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
          Back up now
        </Button>
      </div>
      {uploading && (
        <div className="h-0.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-brand/70 transition-[width]"
            style={{
              width: `${backup.total ? Math.min(100, (backup.done / backup.total) * 100) : 0}%`,
            }}
          />
        </div>
      )}
      {error && <p className="font-sans text-[12px] text-error">{error}</p>}
    </div>
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
  const standby = useSystem()?.standby
  const released = standby?.released === true
  const { busy, error, act } = useAct()
  if (state?.status !== 'on') return null
  const moving = running(state.transition) && state.transition!.target === state.machine
  const away = moving ? undefined : movedAway(state, standby?.reason)
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
      {away && (
        <p className="text-[12px] leading-relaxed text-muted-foreground" data-cloud-moved-away>
          {away}
        </p>
      )}
      {!moving && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {state.writer?.online && state.writer.machine && state.writer.tailnet && (
            <Button asChild size="sm" variant="outline">
              <a data-cloud-open-writer href={state.writer.tailnet}>
                Open on {state.writer.machine}
              </a>
            </Button>
          )}
          <Button
            disabled={busy || !!state.blocked}
            onClick={() => act(() => moveHere())}
            size="sm"
          >
            {state.free && released ? 'Resume here' : 'Move here'}
          </Button>
        </div>
      )}
      {error && <p className="text-[12px] text-error">{error}</p>}
      {!error && state.lastError && !state.transition && (
        <p className="text-[12px] text-error/90">{state.lastError}</p>
      )}
      <LocalTransition className="w-full" state={state} />
      <Help />
    </div>
  )
}

function LocalPicker({ state }: { state: CloudState }) {
  const standby = useSystem()?.standby
  const released = standby?.released === true
  const { busy, error, act } = useAct()
  const { writer, machine = 'this machine' } = state
  const here = state.role === 'writer'
  const moving = running(state.transition)
  const away = moving ? undefined : movedAway(state, standby?.reason)
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
      {here && <BackupRow state={state} />}
      {state.role === 'standby' && state.blocked && (
        <p className="border-t border-border/60 px-3 py-1.5 font-sans text-[12px] text-muted-foreground">
          {state.blocked}
        </p>
      )}
      {away && (
        <p className="border-t border-border/60 px-3 py-1.5 font-sans text-[12px] text-muted-foreground">
          {away}
        </p>
      )}
      {error && <p className="px-3 pb-2 font-sans text-[12px] text-error">{error}</p>}
      <LocalTransition className="m-2 shadow-none" state={state} />
      <div className="flex justify-end border-t border-border/60 px-3 py-1.5 empty:hidden">
        <Help />
      </div>
    </>
  )
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
      moving={running(state.transition) || !!state.backup}
      warn={state.role === 'writer' && state.missing.length > 0}
    >
      <LocalPicker state={state} />
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

export default defineWebExtension({
  slots: {
    standby: [LocalStandby],
    'statusline.right': [LocalExecutor],
    'conversation.overlay': [LocalBanner],
  },
})
