import { HourglassIcon, PauseIcon, PlayIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  defineWebExtension,
  formatDuration,
  errorMessage,
  getState,
  ParkedRuns,
  provide,
  useAction,
  useDocOf,
  useNow,
  useTasks,
  useUltimate,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { store } from '@/sdk/client'
import { ConversationRef } from '../conversations/ui.tsx'
import { lasted } from './lasted.ts'
import { parkedConversations } from './parked.ts'
import { PauseAction, PauseDoc, PlayAction, StateAction } from './refs.ts'
import type { PauseNote, PauseState } from './refs.ts'

const statusButton =
  '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent'

const tasks = (count: number) => `${count} ${count === 1 ? 'task' : 'tasks'}`

/** Whether the host is paused, live from the root's pause document. */
const usePaused = () => useDocOf(1, PauseDoc)?.paused === true

/** The pause and what still runs, refreshed when the doc changes and, while paused, with the task graph. */
function usePauseState() {
  const doc = useDocOf(1, PauseDoc)
  const live = useTasks()
  const graph = doc?.paused ? live : undefined
  const { data, refetch } = useAction(
    StateAction,
    null,
    // A failed poll keeps the last state; the next change asks again.
    { onError: () => {} },
  )
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void refetch()
  }, [doc, graph, refetch])
  return data
}

function Running({ state }: { state: PauseState }) {
  const now = useNow(1000, state.running.length > 0)
  const { switchConversation } = useUltimate()
  return (
    <ul className="space-y-1">
      {state.running.map((task) => (
        <li className="flex min-w-0 items-center gap-2" key={task.task}>
          <button
            className="min-w-0 flex-1 cursor-pointer text-left hover:underline"
            onClick={() => switchConversation(task.conversationId)}
            type="button"
          >
            <ConversationRef id={task.conversationId} title={task.title} />
          </button>
          <span className="shrink-0 text-muted-foreground">{task.what}</span>
          {task.startedAt !== undefined && (
            <span className="w-14 shrink-0 text-right text-muted-foreground/70 tabular-nums">
              {formatDuration(Math.max(0, now - task.startedAt))}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function Popup({
  state,
  busy,
  error,
  toggle,
}: {
  state: PauseState
  busy: boolean
  error?: string
  toggle: () => void
}) {
  const now = useNow(1000, state.paused)
  const pausing = state.paused && state.running.length > 0
  return (
    <>
      <div className="border-b border-border/70 px-3 py-2 text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Pause
      </div>
      <div className="space-y-2 px-3 py-2 text-[11.5px] leading-[1.55]">
        {!state.paused ? (
          <div className="text-muted-foreground">
            Pause stops new work: running tasks finish, nothing new starts, messages queue until
            Play. Nothing is killed.
          </div>
        ) : pausing ? (
          <>
            <div>
              <span className="text-warning">Pausing…</span> waiting for{' '}
              {tasks(state.running.length)} to finish; nothing new starts.
            </div>
            <Running state={state} />
          </>
        ) : (
          <div>
            <span className="text-warning">Paused · safe</span>: nothing runs.{' '}
            {state.since !== undefined && (
              <span className="text-muted-foreground">for {lasted(now - state.since)}</span>
            )}
          </div>
        )}
        {error && <div className="break-words text-error">{error}</div>}
      </div>
      <div className="flex justify-end border-t border-border/70 px-3 py-1.5">
        <Button
          className="h-7 font-sans text-[12px]"
          data-pause-toggle
          disabled={busy}
          onClick={toggle}
          size="sm"
          variant="outline"
        >
          {state.paused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
          {state.paused ? 'Play' : 'Pause'}
        </Button>
      </div>
    </>
  )
}

/** The status-line item: a quiet Pause, amber while pausing or paused. */
function Item() {
  const state = usePauseState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!state) return null
  const toggle = () => {
    setBusy(true)
    setError(undefined)
    api
      .action(state.paused ? PlayAction : PauseAction)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false))
  }
  const pausing = state.paused && state.running.length > 0
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            statusButton,
            state.paused ? 'text-warning' : 'text-muted-foreground/70 hover:text-foreground',
          )}
          data-pause={state.paused ? (pausing ? 'pausing' : 'paused') : 'running'}
          title="Pause or continue all work"
          type="button"
        >
          {pausing ? (
            <>
              <HourglassIcon className="size-3" />
              Pausing…<span className="max-md:hidden"> {tasks(state.running.length)} running</span>
            </>
          ) : state.paused ? (
            <>
              <PauseIcon className="size-3" />
              Paused<span className="max-md:hidden"> · safe</span>
            </>
          ) : (
            <>
              <PauseIcon className="size-3" />
              <span className="max-md:hidden">Pause</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[24rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
        side="top"
      >
        <Popup busy={busy} error={error} state={state} toggle={toggle} />
      </PopoverContent>
    </Popover>
  )
}

/** While paused, Play sits next to the item, one click away. */
function Play() {
  const paused = usePaused()
  const [busy, setBusy] = useState(false)
  if (!paused) return null
  return (
    <button
      className={cn(statusButton, 'text-brand')}
      data-pause-play
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void api
          .action(PlayAction)
          .catch((error: unknown) => store.notify({ level: 'error', message: errorMessage(error) }))
          .finally(() => setBusy(false))
      }}
      type="button"
    >
      <PlayIcon className="size-3" />
      Play
    </button>
  )
}

/** Under the composer while paused: what happens to a message sent now. */
function Hint() {
  if (!usePaused()) return null
  return (
    <span className="flex items-center gap-1.5 text-warning" data-pause-hint>
      <PauseIcon className="size-3" />
      Paused — your message runs on Play
    </span>
  )
}

/** The note Play leaves on a run paused mid-turn: one quiet divider. */
function Note({ entry }: { entry: EntryRecord }) {
  const note = (entry.data ?? {}) as Partial<PauseNote>
  if (note.since === undefined || note.until === undefined) return null
  return (
    <div
      className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/80 before:h-px before:flex-1 before:bg-warning/25 after:h-px after:flex-1 after:bg-warning/25"
      data-pause-note
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <PlayIcon className="size-3 shrink-0 text-warning" />
        <span className="text-warning">Paused for {lasted(note.until - note.since)}</span>
        <span className="truncate">
          · {note.finished ? 'after its last answer' : 'continued after Play'}
        </span>
      </span>
    </div>
  )
}

const paused = () => getState().docsOf[1]?.[PauseDoc.kind]?.paused === true

/** The conversations this pause parked, for the transcript and the lists of conversations. */
function useParked() {
  const pausedNow = usePaused()
  const graph = useTasks()
  return useMemo(() => parkedConversations(graph, pausedNow), [graph, pausedNow])
}

export default defineWebExtension({
  provides: [provide(ParkedRuns, useParked)],
  slots: {
    'statusline.right': [
      { component: Item, order: -3 },
      { component: Play, order: -3 },
    ],
    'composer.status': [Hint],
  },
  entries: { 'pause.note': Note },
  commands: [
    {
      id: 'pause.pause',
      title: 'Pause: stop starting new work',
      group: 'Ultimate',
      when: () => !paused(),
      run: () => api.action(PauseAction),
    },
    {
      id: 'pause.play',
      title: 'Play: continue paused work',
      group: 'Ultimate',
      when: paused,
      run: () => api.action(PlayAction),
    },
  ],
})
