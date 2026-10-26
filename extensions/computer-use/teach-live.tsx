/**
 * Teach mode while it records: the start dialog, the strip above the composer, the status-line item and the summary
 * in the session view. The user demonstrates; the agent only watches. Pause is one click from the strip and from the
 * status line, so a password can be typed unrecorded. The drafted procedure's review is in `teach-review.tsx`.
 */
import {
  CircleStopIcon,
  GraduationCapIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  SparklesIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  errorMessage,
  useAction,
  useConversations,
  useDialog,
  useDocOf,
  useNow,
  useUltimate,
} from '@/sdk'
import type { ActionRef } from '@/sdk'
import {
  GrantAction,
  SessionDoc,
  TeachDoc,
  TeachPauseAction,
  TeachRejectAction,
  TeachResumeAction,
  TeachStartAction,
  TeachStopAction,
  TeachWindowsAction,
} from './refs.ts'
import type { Teach } from './refs.ts'
import { matchProblem, startWindows, suggestedPick, WindowPicker } from './teach-picker.tsx'
import type { Pick } from './teach-picker.tsx'

export type Segment = NonNullable<Teach['segment']>

/** The dialog that starts a teaching segment, opened from ⌘K, the composer, the status line and the session view. */
export const teachDialog = 'computer-use.teach'

/** Teaching runs in the computer operator's conversation: only that agent may draft from it (`computer_teach`). */
export function useOperator(conversation: number | undefined) {
  return useConversations().some((c) => c.id === conversation && c.label === 'computer-operator')
}

/** Why frames were left out, in the user's words. */
const dropWords: Record<string, string> = {
  password_cue: 'password on screen',
  post_signin: 'after sign-in',
  window_not_visible: 'window not visible',
  observation_unavailable: 'screen unavailable',
  recorder_failed: 'recorder failed',
}
/**
 * `{total, text}` of frames left out while recording: `2 password on screen · 1 window not visible`, most frequent
 * first. `frame_missing` is recorded by save, not the recorder; the saved card reports it on its own. A recorder
 * failure is no dropped frame: with its `failure` message the strip shows it instead.
 */
export function dropped(segment: Segment) {
  const counts = new Map<string, number>()
  const recorded = segment.dropped.filter(
    (d) => d.reason !== 'frame_missing' && !(d.reason === 'recorder_failed' && segment.failure),
  )
  for (const d of recorded) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1)
  const text = [...counts]
    .toSorted((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${dropWords[reason] ?? reason.replaceAll('_', ' ')}`)
    .join(' · ')
  return { total: recorded.length, text }
}

/** `4:07`: minutes and seconds left before the segment's deadline. */
export const left = (segment: Segment, now: number) => {
  const seconds = Math.max(0, Math.ceil((segment.endsAt - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
export const live = (segment: Segment | undefined) =>
  segment?.status === 'recording' || segment?.status === 'paused'
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** One small outline button that calls a user-only teach action; a failure goes to `onError`. */
export function TeachButton<A>({
  action,
  args,
  children,
  onError,
  onSuccess,
  tone,
  title,
  className,
}: {
  action: ActionRef<A, unknown>
  args: A
  children: ReactNode
  onError: (message: string | undefined) => void
  onSuccess?: () => void
  tone?: 'primary' | 'danger'
  title?: string
  className?: string
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      className={cn(
        'h-7 gap-1.5 px-2 font-sans text-[12px]',
        tone === 'primary' && 'border-brand/50 text-foreground hover:border-brand',
        tone === 'danger' && 'border-error/40 text-error hover:bg-error/10 hover:text-error',
        className,
      )}
      disabled={busy}
      onClick={() => {
        setBusy(true)
        onError(undefined)
        api
          .action(action, args)
          .then(() => onSuccess?.())
          .catch((error: unknown) => onError(errorMessage(error)))
          .finally(() => setBusy(false))
      }}
      size="sm"
      title={title}
      variant="outline"
    >
      {busy && <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />}
      {children}
    </Button>
  )
}

/** The recording light: a pulsing red dot while recording, amber bars while paused. */
function Light({ status }: { status: Segment['status'] }) {
  return status === 'recording' ? (
    <span
      aria-label="recording"
      className="size-2 shrink-0 animate-pulse-dot rounded-full bg-error"
    />
  ) : (
    <PauseIcon aria-label="paused" className="size-3 shrink-0 text-warning" />
  )
}

/** The facts of a live segment: time left, frames, drops with their reasons. */
function Counts({ segment, now }: { segment: Segment; now: number }) {
  const drops = dropped(segment)
  return (
    <span className="block min-w-0 leading-[1.6] text-muted-foreground tabular-nums [&>*+*]:before:mx-1.5 [&>*+*]:before:text-muted-foreground/50 [&>*+*]:before:content-['·']">
      <span className={segment.endsAt - now < 30000 ? 'text-warning' : 'text-foreground/90'}>
        {left(segment, now)} left
      </span>
      <span>{plural(segment.frames.length, 'frame')}</span>
      {drops.total > 0 && (
        <span title={drops.text}>
          <span className="text-warning">{drops.total} dropped</span>
          <span className="max-sm:hidden"> ({drops.text})</span>
        </span>
      )}
    </span>
  )
}

/**
 * The strip above the composer while a segment exists: recording or paused with Pause/Resume and Stop, then the
 * ended recording waiting for a draft, then the draft waiting for review.
 */
export function TeachStrip({
  segment,
  steps,
  conversation,
  now,
}: {
  segment: Segment
  steps?: Teach['steps']
  conversation: number
  now: number
}) {
  const [error, setError] = useState<string>()
  const args = { conversation }
  const drops = dropped(segment)
  const unreviewed = steps?.filter((s) => s.approved === undefined).length ?? 0
  const tone =
    segment.status === 'recording'
      ? 'border-l-error/70'
      : segment.status === 'paused' || segment.status === 'drafting' || unreviewed
        ? 'border-l-warning/70'
        : 'border-l-brand/50'
  return (
    <div
      className={cn(
        'mb-2 min-w-0 rounded-md border border-border border-l-2 bg-card font-mono text-[11.5px]',
        tone,
      )}
      data-teach-strip={segment.status}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-1.5">
        <span className="flex min-w-0 flex-1 basis-60 flex-wrap items-center gap-x-2 gap-y-0.5">
          {live(segment) ? (
            <>
              <Light status={segment.status} />
              <span className={segment.status === 'recording' ? 'text-error' : 'text-warning'}>
                {segment.status === 'recording' ? 'Watching' : 'Paused'}
              </span>
              <span className="text-foreground">{segment.app}</span>
              <span className="min-w-0 truncate text-muted-foreground" title={segment.title}>
                “{segment.title}”
              </span>
            </>
          ) : (
            <>
              <GraduationCapIcon className="size-3.5 shrink-0 text-brand" />
              <span className="text-foreground">
                {segment.status === 'drafting' ? 'Recording ended' : 'Draft ready'}
              </span>
              <span className="min-w-0 truncate text-muted-foreground" title={segment.title}>
                “{segment.title}”
              </span>
            </>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {segment.status === 'recording' && (
            <TeachButton
              action={TeachPauseAction}
              args={args}
              onError={setError}
              title="Stop capturing now, for a password or anything private; the deadline keeps running"
            >
              <PauseIcon className="size-3" />
              Pause
            </TeachButton>
          )}
          {segment.status === 'paused' && (
            <TeachButton action={TeachResumeAction} args={args} onError={setError} tone="primary">
              <PlayIcon className="size-3" />
              Resume
            </TeachButton>
          )}
          {live(segment) && (
            <TeachButton
              action={TeachStopAction}
              args={args}
              onError={setError}
              title="End the recording; the agent then drafts the steps for you to review"
            >
              <CircleStopIcon className="size-3" />
              Stop
            </TeachButton>
          )}
          {segment.status === 'drafting' && (
            <>
              <AskDraft conversation={conversation} onError={setError} />
              <TeachButton
                action={TeachRejectAction}
                args={args}
                onError={setError}
                title="Discard this recording and delete its frames now"
              >
                <Trash2Icon className="size-3" />
                Discard
              </TeachButton>
            </>
          )}
          {segment.status === 'review' && (
            <Button
              className="h-7 gap-1.5 px-2 font-sans text-[12px]"
              onClick={() =>
                document
                  .querySelector('[data-teach-review]')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              size="sm"
              variant="outline"
            >
              Review
            </Button>
          )}
        </span>
      </div>
      <div className="flex items-center gap-x-3 border-t border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground">
        {live(segment) ? (
          <Counts now={now} segment={segment} />
        ) : (
          <span className="min-w-0 flex-1 leading-[1.6] [&>*+*]:before:mx-1.5 [&>*+*]:before:text-muted-foreground/50 [&>*+*]:before:content-['·']">
            <span>{plural(segment.frames.length, 'frame')}</span>
            {drops.total > 0 && (
              <span>
                <span className="text-warning">{drops.total} dropped</span> ({drops.text})
              </span>
            )}
            {segment.endedBy === 'unavailable' && (
              <span className="text-warning">ended early: the window could not be read</span>
            )}
            {segment.failure && <span className="text-error">the recorder failed</span>}
            {segment.status === 'drafting' && (
              <span>
                {segment.frames.length
                  ? 'the agent drafts the steps next'
                  : 'nothing to draft: discard it and start again'}
              </span>
            )}
            {segment.status === 'review' && steps && (
              <span className={unreviewed ? 'text-warning' : 'text-success'}>
                {unreviewed
                  ? `${unreviewed} of ${plural(steps.length, 'step')} to review`
                  : 'every step reviewed'}
              </span>
            )}
          </span>
        )}
      </div>
      {segment.failure && (
        <p
          className="border-t border-border/60 px-2.5 py-1 text-[11px] leading-[1.5] break-words text-muted-foreground"
          data-teach-failure
        >
          {segment.failure}
        </p>
      )}
      {error && <p className="px-2.5 pb-1.5 break-words text-error">{error}</p>}
    </div>
  )
}

/** Ask the operator to draft: the same as typing it, into this conversation. */
function AskDraft({
  conversation,
  onError,
}: {
  conversation: number
  onError: (message: string | undefined) => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      className="h-7 gap-1.5 border-brand/50 px-2 font-sans text-[12px] text-foreground hover:border-brand"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        onError(undefined)
        api
          .submit(
            'Draft the procedure from the teaching segment I just recorded.',
            'followUp',
            conversation,
          )
          .catch((error: unknown) => onError(errorMessage(error)))
          .finally(() => setBusy(false))
      }}
      size="sm"
      variant="outline"
    >
      {busy ? (
        <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />
      ) : (
        <SparklesIcon className="size-3" />
      )}
      Draft steps
    </Button>
  )
}

/** Above the operator's composer, while it has a recording, a draft to make or steps to review. */
export function TeachComposer({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const { conversationId } = useUltimate()
  const operator = useOperator(conversationId)
  const teach = useDocOf(operator ? conversationId : undefined, TeachDoc)
  const segment = teach?.segment
  const shown =
    segment &&
    conversationId !== undefined &&
    (live(segment) ||
      segment.status === 'drafting' ||
      (segment.status === 'review' && teach.steps?.some((s) => s.approved === undefined)))
  const now = useNow(1000, !!shown && live(segment))
  if (!shown) return core
  return (
    <>
      <div className={cn('mx-auto w-full', dock ? 'px-2' : 'max-w-[46rem] px-3 sm:px-6')}>
        <TeachStrip conversation={conversationId} now={now} segment={segment} steps={teach.steps} />
      </div>
      {core}
    </>
  )
}

/** The composer toolbar's Teach button, in an operator's conversation with no live segment. */
export function TeachToolbar() {
  const { conversationId, open } = useUltimate()
  const operator = useOperator(conversationId)
  const segment = useDocOf(operator ? conversationId : undefined, TeachDoc)?.segment
  if (!operator || live(segment)) return null
  return (
    <button
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      data-teach-open
      onClick={() => open(teachDialog)}
      title="Show the agent a procedure once while it watches"
      type="button"
    >
      <GraduationCapIcon className="size-3.5 shrink-0" />
      <span className="@max-md:hidden">teach</span>
    </button>
  )
}

const statusButton =
  '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent'

/** The status-line item while a segment records or is paused: state, app, time left; Pause or Resume one click away. */
export function TeachStatusView({
  segment,
  conversation,
  now,
}: {
  segment: Segment
  conversation: number
  now: number
}) {
  const [error, setError] = useState<string>()
  const recording = segment.status === 'recording'
  const args = { conversation }
  return (
    <span className="flex items-center gap-2.5" data-teach-status={segment.status}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            className={cn(statusButton, recording ? 'text-error' : 'text-warning')}
            title="Teaching: the agent is watching this window"
            type="button"
          >
            <Light status={segment.status} />
            {recording ? 'Watching' : 'Paused'}
            <span className="max-md:hidden"> · {segment.app}</span>
            <span className="text-muted-foreground tabular-nums">{left(segment, now)}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[24rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
          side="top"
        >
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2 text-[10.5px] tracking-wider text-muted-foreground uppercase">
            <GraduationCapIcon className="size-3" />
            Teaching
          </div>
          <div className="space-y-1.5 px-3 py-2 text-[11.5px] leading-[1.55]">
            <p className="font-sans text-[12.5px] leading-snug">“{segment.title}”</p>
            <p>
              <span className={recording ? 'text-error' : 'text-warning'}>
                {recording ? 'Watching' : 'Paused, recording nothing'}
              </span>{' '}
              <span className="text-foreground">{segment.app}</span>
            </p>
            <Counts now={now} segment={segment} />
            <p className="text-[10.5px] leading-snug text-muted-foreground/80">
              Only window pictures are kept, never keystrokes or clicks. Pause before you type a
              password; the timer keeps running.
            </p>
          </div>
          <div className="flex items-center justify-end gap-1.5 border-t border-border/70 px-3 py-1.5">
            <TeachButton action={TeachStopAction} args={args} onError={setError}>
              <CircleStopIcon className="size-3" />
              Stop
            </TeachButton>
          </div>
          {error && <p className="px-3 pb-2 text-[11px] text-error">{error}</p>}
        </PopoverContent>
      </Popover>
      <button
        className={cn(statusButton, recording ? 'text-foreground/85' : 'text-brand')}
        data-teach-quick={recording ? 'pause' : 'resume'}
        onClick={() => {
          setError(undefined)
          api
            .action(recording ? TeachPauseAction : TeachResumeAction, args)
            .catch((failure: unknown) => setError(errorMessage(failure)))
        }}
        title={
          error ??
          (recording ? 'Pause: record nothing until you resume' : 'Resume watching this window')
        }
        type="button"
      >
        {recording ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
        {recording ? 'Pause' : 'Resume'}
      </button>
    </span>
  )
}

/** The live teach item for one operator conversation. */
export function TeachStatus({ conversation }: { conversation: number }) {
  const segment = useDocOf(conversation, TeachDoc)?.segment
  const now = useNow(1000, live(segment))
  if (!segment || !live(segment)) return null
  return <TeachStatusView conversation={conversation} now={now} segment={segment} />
}

/** Start a segment: a title, the windows to watch, and how long. */
export function TeachDialog() {
  const [open, setOpen] = useDialog(teachDialog)
  const { conversationId } = useUltimate()
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[34rem]"
        data-teach-dialog
      >
        {open && conversationId !== undefined && (
          <TeachStartForm conversation={conversationId} onClose={() => setOpen(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

const field =
  'h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-brand/60 focus-visible:ring-2 focus-visible:ring-ring/30 max-md:h-10'

/** The form inside the dialog; exported for the session view's empty state too. */
export function TeachStartForm({
  conversation,
  onClose,
}: {
  conversation: number
  onClose: () => void
}) {
  const session = useDocOf(conversation, SessionDoc)
  const suggested = session?.journal.at(-1)?.app ?? session?.task?.spec.scope.apps[0] ?? ''
  const listed = useAction(TeachWindowsAction, { conversation }, { onError: () => {} })
  const [title, setTitle] = useState('')
  const [chosen, setPicks] = useState<Pick[]>()
  const [minutes, setMinutes] = useState(5)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const windows = listed.data?.windows ?? []
  // Until the user ticks or unticks, the frontmost window of the app the session used last is ticked for them.
  const suggestion = listed.data && suggestedPick(windows, suggested)
  const picks = chosen ?? (suggestion ? [suggestion] : [])
  const payload = startWindows(windows, picks)
  const picked = payload.map((p) => windows.find((w) => w.window === p.window)!)
  const needs = [...new Set(picked.filter((w) => w.consent !== 'granted').map((w) => w.app))]
  const invalid = picked.some((w) =>
    matchProblem(w, picks.find((p) => p.window === w.window)!.match, windows),
  )
  const ready = !!title.trim() && payload.length > 0 && !needs.length && !invalid && !busy
  const start = () => {
    if (!ready) return
    setBusy(true)
    setFailure(undefined)
    api
      .action(TeachStartAction, { conversation, title: title.trim(), minutes, windows: payload })
      .then(onClose)
      .catch((error: unknown) => setFailure(errorMessage(error)))
      .finally(() => setBusy(false))
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        start()
      }}
    >
      <div className="space-y-4 px-6 pt-6 pb-5">
        <div className="space-y-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <GraduationCapIcon className="size-4 text-brand" />
            Teach the agent
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
            Do the task once while the agent watches. It keeps a picture of the window each time it
            changes and settles, never your keystrokes or clicks. You review the steps it drafts
            before anything is saved.
          </DialogDescription>
        </div>
        <label className="block space-y-1.5">
          <span className="text-[12px] text-muted-foreground">What you'll show</span>
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type the lesson's title.
            autoFocus
            className={field}
            data-teach-title
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Upload a skill to OpsMate"
            value={title}
          />
        </label>
        <WindowPicker
          conversation={conversation}
          listed={listed}
          onPicks={(next) => {
            // A failure names the old selection; the consent hint below must show for the new one.
            setFailure(undefined)
            setPicks(next)
          }}
          picks={picks}
        />
        <label className="block space-y-1.5">
          <span className="flex items-baseline justify-between text-[12px] text-muted-foreground">
            Up to
            <span className="font-mono text-foreground tabular-nums">{minutes} min</span>
          </span>
          <input
            aria-label="Minutes"
            className="w-full accent-brand"
            max={10}
            min={1}
            onChange={(event) => setMinutes(Number(event.target.value))}
            step={1}
            type="range"
            value={minutes}
          />
        </label>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          <span className="text-foreground">Pause</span> before you type a password: pictures
          showing a password field are dropped, but pausing records nothing at all. The timer keeps
          running while paused.
        </p>
      </div>
      <footer className="space-y-3 border-t border-border/60 bg-muted/30 px-6 py-4">
        {failure && (
          <StartFailure
            app={picked[0]?.app ?? ''}
            conversation={conversation}
            failure={failure}
            onGranted={() => void listed.refetch()}
          />
        )}
        {!failure && needs.length > 0 && (
          <p className="text-[12px] leading-relaxed text-warning">
            Allow {needs.join(' and ')} first: watching needs your consent for each app.
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose} size="sm" type="button" variant="ghost">
            Not now
          </Button>
          <Button data-teach-start disabled={!ready} size="sm" type="submit">
            {busy && <LoaderCircleIcon className="motion-safe:animate-spin" />}
            Start watching
          </Button>
        </div>
      </footer>
    </form>
  )
}

/** Why starting failed, in the user's words, with the grant it needs when that is the reason. */
function StartFailure({
  failure,
  app,
  conversation,
  onGranted,
}: {
  failure: string
  app: string
  conversation: number
  onGranted: () => void
}) {
  const [error, setError] = useState<string>()
  const consent = failure.includes('app_identity')
    ? undefined
    : /consent_required(?:: (.+))?$/.exec(failure)
  if (consent) {
    // The canonical name the server resolved, which the picked window's app may only approximate.
    const name = consent[1]?.trim() || app
    return (
      <div className="space-y-2 text-[12px] leading-relaxed">
        <p className="text-warning">
          Watching needs your consent for <span className="text-foreground">{name}</span> in this
          conversation. An “allow once” grant covers one lesson only.
        </p>
        <TeachButton
          action={GrantAction}
          args={{ conversation, app: name, scope: 'conversation' }}
          onError={setError}
          onSuccess={onGranted}
          tone="primary"
        >
          Allow {name} in this conversation
        </TeachButton>
        {error && <p className="text-error">{error}</p>}
      </div>
    )
  }
  // Windows come from the live list, so a window or app that no longer resolves closed or quit since it was listed.
  const words =
    failure.includes('window is ambiguous') || failure.includes('app_identity')
      ? 'A picked window closed or its app quit since the list was made. Refresh the list and pick again.'
      : failure.includes('already active')
        ? 'A recording is already running in this conversation.'
        : failure.includes('act is running')
          ? 'The agent is operating the computer right now. Stop it first.'
          : failure.includes('stopped')
            ? 'Computer use is stopped for this project. Resume it from the status line first.'
            : failure
  return <p className="text-[12px] leading-relaxed break-words text-error">{words}</p>
}
