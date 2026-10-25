/**
 * The drafted procedure, for the user to review before it becomes a skill: every step with every field that will be
 * saved, its expected screen, and approve, reject, edit, reorder, insert and delete; then save as a skill or discard.
 * All step text was read off the screen or written by the model, so it renders as plain text with the screen-text
 * marker, never as Markdown. Every change goes to the server as a full replacement (`teachEdit`), which validates it
 * and recomputes which steps are consequential.
 */
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CircleDashedIcon,
  EllipsisIcon,
  GraduationCapIcon,
  ImageOffIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, cn, errorMessage, formatTime, useSystem } from '@/sdk'
import { TeachEditAction, TeachRejectAction, TeachSaveAction } from './refs.ts'
import type { FrameMeta, TaughtStep, Teach } from './refs.ts'
import { ScreenMark } from './shared.tsx'
import { dropped } from './teach-live.tsx'
import type { Segment } from './teach-live.tsx'

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
const actions: TaughtStep['action'][] = [
  'click',
  'type',
  'type_secret',
  'key',
  'wait',
  'upload',
  'select',
]
const actionWords: Record<TaughtStep['action'], string> = {
  click: 'click',
  type: 'type',
  type_secret: 'type secret',
  key: 'press',
  wait: 'wait',
  upload: 'upload',
  select: 'select',
}
/** `m:ss` after the segment started: when this frame was captured. */
const offset = (segment: Segment, at: number) => {
  const seconds = Math.max(0, Math.round((at - segment.startedAt) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const kebab = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
const validName = (name: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64

/** Steps renumbered 1…n, as the server requires. */
const numbered = (steps: TaughtStep[]) => steps.map((step, index) => ({ ...step, n: index + 1 }))

// ---- reading a step ------------------------------------------------------------------------------------------------

/** Screen text, quoted, plain, with the marker once at the end of the row. */
function Quoted({ items }: { items: readonly string[] }) {
  return (
    <>
      {items.map((item, index) => (
        <span key={index}>
          {index > 0 && <span className="text-muted-foreground/50"> · </span>}“{item}”
        </span>
      ))}
    </>
  )
}

/** A label: value row of a step. Its value is screen or model text; the step's label line carries the marker. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2 leading-[1.6]">
      <span className="w-[4.5rem] shrink-0 text-muted-foreground/80">{label}</span>
      <span className="min-w-0 flex-1 break-words text-foreground/90">{children}</span>
    </div>
  )
}

/**
 * Every field a step saves, always shown, so approving means having seen all of it. Values are untrusted: plain text,
 * quoted, in the same colour as any other value; nothing here is styled as if it were an instruction from us.
 * teachDetails: once the server's `ComputerDetails.teach.steps` carries anchors, expects, wait and pitfalls as
 * `UntrustedText`, read them from there (`.text`) instead of the document's raw strings.
 */
function StepFields({ step }: { step: TaughtStep }) {
  const appears = step.expect.appears ?? []
  const gone = step.expect.disappears ?? []
  return (
    <div className="space-y-0.5 text-[11.5px]">
      {step.target.anchors.length > 0 && (
        <Field label="near">
          <Quoted items={step.target.anchors} />
        </Field>
      )}
      {step.value && (
        <Field label="value">
          <span className="text-brand">{`{${step.value.param}}`}</span>
          <span className="text-muted-foreground">
            {step.action === 'type_secret'
              ? ' · a secret, asked for at run time'
              : ' · filled in at run time'}
          </span>
        </Field>
      )}
      {appears.length > 0 && (
        <Field label="appears">
          <Quoted items={appears} />
          {step.expect.timeoutSeconds !== undefined && (
            <span className="text-muted-foreground"> · within {step.expect.timeoutSeconds}s</span>
          )}
        </Field>
      )}
      {gone.length > 0 && (
        <Field label="goes away">
          <Quoted items={gone} />
          {!appears.length && step.expect.timeoutSeconds !== undefined && (
            <span className="text-muted-foreground"> · within {step.expect.timeoutSeconds}s</span>
          )}
        </Field>
      )}
      {step.wait && (
        <Field label="wait">
          until “{step.wait.until}”
          <span className="text-muted-foreground"> · up to {step.wait.timeoutSeconds}s</span>
        </Field>
      )}
      {step.pitfalls && step.pitfalls.length > 0 && (
        <Field label="pitfalls">
          <ul className="space-y-0.5">
            {step.pitfalls.map((pitfall, index) => (
              <li className="flex gap-1.5" key={index}>
                <span className="shrink-0 text-muted-foreground/60">–</span>
                <span className="min-w-0">“{pitfall}”</span>
              </li>
            ))}
          </ul>
        </Field>
      )}
    </div>
  )
}

/**
 * The expected screen: the frame captured just before the step. Frame images are private local files that no route
 * serves yet, so this shows the frame's time and what changed there instead of the picture.
 */
function Expected({ frame, segment }: { frame?: FrameMeta; segment: Segment }) {
  return (
    <figure
      className="w-40 shrink-0 self-start overflow-hidden rounded-sm border border-border/70 bg-background/50 text-[10.5px] max-sm:w-full"
      data-teach-frame
    >
      <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/40 px-1.5 py-1 text-muted-foreground tabular-nums">
        <ImageOffIcon className="size-3 shrink-0 text-muted-foreground/60" />
        {frame ? (
          <span>
            screen at {offset(segment, frame.at)}
            {!frame.file && <span className="text-muted-foreground/60"> · image not kept</span>}
          </span>
        ) : (
          <span className="text-error">frame missing</span>
        )}
      </div>
      {frame && (
        <figcaption
          className="line-clamp-4 px-1.5 py-1 leading-snug break-words text-muted-foreground"
          title={frame.inferred}
        >
          {frame.inferred}
        </figcaption>
      )}
    </figure>
  )
}

// ---- editing a step ------------------------------------------------------------------------------------------------

const input =
  'h-7 w-full min-w-0 rounded-sm border border-border bg-background px-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground/50 focus:border-brand/60 max-md:h-9'
const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
const seconds = (text: string) => (text.trim() ? Number(text) : undefined)

type Draft = {
  action: TaughtStep['action']
  label: string
  anchors: string
  param: string
  appears: string
  disappears: string
  timeout: string
  until: string
  waitSeconds: string
  pitfalls: string
  frame: string
}
const draftOf = (step: TaughtStep): Draft => ({
  action: step.action,
  label: step.target.label,
  anchors: step.target.anchors.join('\n'),
  param: step.value?.param ?? '',
  appears: (step.expect.appears ?? []).join('\n'),
  disappears: (step.expect.disappears ?? []).join('\n'),
  timeout: step.expect.timeoutSeconds?.toString() ?? '',
  until: step.wait?.until ?? '',
  waitSeconds: step.wait?.timeoutSeconds.toString() ?? '',
  pitfalls: (step.pitfalls ?? []).join('\n'),
  frame: step.frame,
})
/** The step a draft describes, or why it is not one yet (the server checks the same and more). */
function stepOf(draft: Draft, base: TaughtStep): TaughtStep | string {
  if (!draft.label.trim()) return 'Name the label on screen that the step acts on.'
  const typing = draft.action === 'type' || draft.action === 'type_secret'
  if (typing && !draft.param.trim()) return 'Typing needs a value name, such as skillFile.'
  if (draft.param.trim() && !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(draft.param.trim()))
    return 'A value name starts with a letter: letters, digits, _ and - only.'
  const timeout = seconds(draft.timeout)
  const wait = seconds(draft.waitSeconds)
  for (const value of [timeout, wait])
    if (value !== undefined && !(value > 0 && value <= 600)) return 'Seconds are 1–600.'
  if (draft.until.trim() && wait === undefined) return 'Say how long to wait, in seconds.'
  const appears = lines(draft.appears)
  const disappears = lines(draft.disappears)
  const pitfalls = lines(draft.pitfalls)
  return {
    n: base.n,
    action: draft.action,
    target: {
      label: draft.label.trim(),
      anchors: lines(draft.anchors),
      ...(base.target.region ? { region: base.target.region } : {}),
    },
    ...(draft.param.trim() ? { value: { param: draft.param.trim() } } : {}),
    expect: {
      ...(appears.length ? { appears } : {}),
      ...(disappears.length ? { disappears } : {}),
      ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
    },
    ...(draft.until.trim() && wait !== undefined
      ? { wait: { until: draft.until.trim(), timeoutSeconds: wait } }
      : {}),
    ...(pitfalls.length ? { pitfalls } : {}),
    frame: draft.frame,
  }
}

function EditRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-2 max-sm:grid-cols-1 max-sm:gap-1">
      <span className="pt-1 text-[11px] text-muted-foreground">
        {label}
        {hint && <span className="block text-[10.5px] text-muted-foreground/60">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

function Lines({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <textarea
      className={cn(input, 'h-auto min-h-7 resize-y py-1 leading-[1.5]')}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      rows={Math.min(4, Math.max(1, value.split('\n').length))}
      value={value}
    />
  )
}

/** Every field of one step, as form fields; lists are one item per line. */
function StepEditor({
  step,
  segment,
  onSave,
  onCancel,
  fresh,
}: {
  step: TaughtStep
  segment: Segment
  onSave: (step: TaughtStep, approve: boolean) => Promise<void>
  onCancel: () => void
  fresh?: boolean
}) {
  const [draft, setDraft] = useState(() => draftOf(step))
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const set = (key: keyof Draft) => (value: string) => setDraft({ ...draft, [key]: value })
  const typing = draft.action === 'type' || draft.action === 'type_secret'
  const save = (approve: boolean) => {
    const next = stepOf(draft, step)
    if (typeof next === 'string') return setError(next)
    setBusy(true)
    setError(undefined)
    onSave(next, approve)
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }
  return (
    <form
      className="space-y-1.5 rounded-sm border border-brand/40 bg-background/70 p-2.5 font-mono"
      data-teach-editor
      onSubmit={(event) => {
        event.preventDefault()
        save(false)
      }}
    >
      <EditRow label="action">
        <select
          className={input}
          onChange={(event) => set('action')(event.target.value)}
          value={draft.action}
        >
          {actions.map((action) => (
            <option key={action} value={action}>
              {actionWords[action]}
            </option>
          ))}
        </select>
      </EditRow>
      <EditRow hint="as on screen" label="label">
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the editor opens to change the step's label. */}
        <input
          autoFocus
          className={input}
          onChange={(e) => set('label')(e.target.value)}
          value={draft.label}
        />
      </EditRow>
      <EditRow hint="one per line" label="near">
        <Lines onChange={set('anchors')} placeholder="Labels next to it" value={draft.anchors} />
      </EditRow>
      {(typing || draft.param) && (
        <EditRow hint="never the text itself" label="value name">
          <input
            className={input}
            onChange={(e) => set('param')(e.target.value)}
            placeholder="skillFile"
            value={draft.param}
          />
        </EditRow>
      )}
      <EditRow hint="one per line" label="appears">
        <Lines onChange={set('appears')} value={draft.appears} />
      </EditRow>
      <EditRow hint="one per line" label="goes away">
        <Lines onChange={set('disappears')} value={draft.disappears} />
      </EditRow>
      <EditRow hint="seconds" label="within">
        <input
          className={cn(input, 'w-20')}
          inputMode="numeric"
          onChange={(e) => set('timeout')(e.target.value)}
          value={draft.timeout}
        />
      </EditRow>
      <EditRow label="wait until">
        <span className="flex gap-1.5">
          <input
            className={input}
            onChange={(e) => set('until')(e.target.value)}
            placeholder="Label that shows it is ready"
            value={draft.until}
          />
          <input
            aria-label="Wait seconds"
            className={cn(input, 'w-20 shrink-0')}
            inputMode="numeric"
            onChange={(e) => set('waitSeconds')(e.target.value)}
            placeholder="s"
            value={draft.waitSeconds}
          />
        </span>
      </EditRow>
      <EditRow hint="one per line" label="pitfalls">
        <Lines onChange={set('pitfalls')} value={draft.pitfalls} />
      </EditRow>
      <EditRow hint="screen before" label="frame">
        <select
          className={input}
          onChange={(e) => set('frame')(e.target.value)}
          value={draft.frame}
        >
          {segment.frames.map((frame) => (
            <option key={frame.id} value={frame.id}>
              {offset(segment, frame.at)} · {frame.inferred.slice(0, 60)}
            </option>
          ))}
        </select>
      </EditRow>
      {error && <p className="text-[11.5px] break-words text-error">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1">
        <Button
          className="h-7 font-sans text-[12px]"
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          className="h-7 font-sans text-[12px]"
          disabled={busy}
          size="sm"
          type="submit"
          variant="outline"
        >
          {fresh ? 'Insert' : 'Save'}
        </Button>
        <Button
          className="h-7 gap-1.5 border-brand/50 font-sans text-[12px] hover:border-brand"
          disabled={busy}
          onClick={() => save(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy && <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />}
          {fresh ? 'Insert and approve' : 'Save and approve'}
        </Button>
      </div>
    </form>
  )
}

// ---- one step ------------------------------------------------------------------------------------------------------

function ReviewMark({ approved }: { approved?: boolean }) {
  return approved === true ? (
    <CheckIcon aria-label="approved" className="size-3.5 text-success" />
  ) : approved === false ? (
    <XIcon aria-label="rejected" className="size-3.5 text-muted-foreground" />
  ) : (
    <CircleDashedIcon aria-label="not reviewed" className="size-3.5 text-warning" />
  )
}

function Choice({
  on,
  tone,
  onClick,
  disabled,
  children,
}: {
  on: boolean
  tone: 'success' | 'muted'
  onClick: () => void
  disabled: boolean
  children: ReactNode
}) {
  return (
    <button
      aria-pressed={on}
      className={cn(
        'flex h-7 cursor-pointer items-center gap-1 px-2 font-sans text-[12px] transition-colors first:rounded-l-md last:rounded-r-md focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50 max-md:h-9',
        on
          ? tone === 'success'
            ? 'bg-success/15 text-success'
            : 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

function StepItem({
  step,
  index,
  count,
  segment,
  busy,
  flagged,
  editing,
  setEditing,
  change,
}: {
  step: TaughtStep
  index: number
  count: number
  segment: Segment
  busy: boolean
  flagged: boolean
  editing: boolean
  setEditing: (on: boolean) => void
  change: (next: (steps: TaughtStep[]) => TaughtStep[]) => Promise<void>
}) {
  const frame = segment.frames.find((f) => f.id === step.frame)
  const [inserting, setInserting] = useState(false)
  const rejected = step.approved === false
  const review = (approved: boolean | undefined) =>
    change((steps) => steps.map((s, i) => (i === index ? { ...s, approved } : s)))
  const move = (by: number) =>
    change((steps) => {
      const next = [...steps]
      const [item] = next.splice(index, 1)
      next.splice(index + by, 0, item)
      return next
    })
  const blank: TaughtStep = {
    n: index + 2,
    action: 'click',
    target: { label: '', anchors: [] },
    expect: {},
    frame: step.frame,
  }
  return (
    <li
      className={cn(
        'border-t border-border/60 first:border-t-0',
        step.consequential && !rejected && 'bg-warning/[0.05]',
      )}
      data-teach-step={
        step.approved === undefined ? 'unreviewed' : rejected ? 'rejected' : 'approved'
      }
    >
      <div
        className={cn(
          'flex gap-3 border-l-2 px-3 py-2.5 transition-colors max-sm:flex-col max-sm:gap-2',
          step.approved === undefined
            ? flagged
              ? 'border-l-warning bg-warning/[0.08]'
              : 'border-l-warning/60'
            : 'border-l-transparent',
        )}
      >
        <div className="min-w-0 flex-1 space-y-1.5 font-mono">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 shrink-0">
              <ReviewMark approved={step.approved} />
            </span>
            <span className="w-5 shrink-0 pt-px text-right text-[11px] text-muted-foreground tabular-nums">
              {step.n}
            </span>
            <span
              className={cn('min-w-0 flex-1 text-[12.5px] leading-5', rejected && 'opacity-55')}
            >
              <span className="mr-1.5 text-muted-foreground">{actionWords[step.action]}</span>
              <span
                className={cn(
                  'break-words text-foreground',
                  rejected && 'line-through decoration-muted-foreground/60',
                )}
              >
                “{step.target.label}”
              </span>
              <ScreenMark />
              {step.consequential && (
                <span
                  className="ml-2 inline-flex items-center gap-1 rounded-sm border border-warning/40 bg-warning/10 px-1 py-px align-[1px] text-[10.5px] text-warning"
                  title="Upload, install, send, delete and the like: the agent asks before doing this step"
                >
                  <ShieldAlertIcon className="size-3" />
                  consequential
                </span>
              )}
              {step.approved === undefined && (
                <span className="ml-2 text-[10.5px] text-warning">not reviewed</span>
              )}
            </span>
          </div>
          {editing ? (
            <StepEditor
              onCancel={() => setEditing(false)}
              onSave={async (next, approve) => {
                await change((steps) =>
                  steps.map((s, i) =>
                    i === index ? { ...next, approved: approve ? true : undefined } : s,
                  ),
                )
                setEditing(false)
              }}
              segment={segment}
              step={step}
            />
          ) : (
            <>
              <div className={cn('pl-12 max-sm:pl-0', rejected && 'opacity-55')}>
                <StepFields step={step} />
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pt-1 pl-12 max-sm:pl-0">
                <span className="flex rounded-md border border-border">
                  <Choice
                    disabled={busy}
                    on={step.approved === true}
                    onClick={() => void review(step.approved === true ? undefined : true)}
                    tone="success"
                  >
                    <CheckIcon className="size-3" />
                    Approve
                  </Choice>
                  <Choice
                    disabled={busy}
                    on={rejected}
                    onClick={() => void review(rejected ? undefined : false)}
                    tone="muted"
                  >
                    <XIcon className="size-3" />
                    Reject
                  </Choice>
                </span>
                <Button
                  className="h-7 gap-1 px-2 font-sans text-[12px] text-muted-foreground max-md:h-9"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                  size="sm"
                  variant="ghost"
                >
                  <PencilIcon className="size-3" />
                  Edit
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={`More for step ${step.n}`}
                      className="size-7 text-muted-foreground max-md:size-9"
                      disabled={busy}
                      size="icon"
                      variant="ghost"
                    >
                      <EllipsisIcon className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44">
                    <DropdownMenuItem
                      className="text-[12.5px]"
                      disabled={index === 0}
                      onSelect={() => void move(-1)}
                    >
                      <ArrowUpIcon />
                      Move up
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-[12.5px]"
                      disabled={index === count - 1}
                      onSelect={() => void move(1)}
                    >
                      <ArrowDownIcon />
                      Move down
                    </DropdownMenuItem>
                    <DropdownMenuItem className="text-[12.5px]" onSelect={() => setInserting(true)}>
                      <PlusIcon />
                      Insert a step after
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-[12.5px]"
                      disabled={count === 1}
                      onSelect={() => void change((steps) => steps.filter((_, i) => i !== index))}
                      variant="destructive"
                    >
                      <Trash2Icon />
                      Delete step
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
        </div>
        {!editing && <Expected frame={frame} segment={segment} />}
      </div>
      {inserting && (
        <div className="px-3 pb-2.5 pl-[3.75rem] max-sm:pl-3">
          <p className="pb-1 font-mono text-[11px] text-muted-foreground">New step {index + 2}</p>
          <StepEditor
            fresh
            onCancel={() => setInserting(false)}
            onSave={async (next, approve) => {
              await change((steps) => {
                const copy = [...steps]
                copy.splice(index + 1, 0, { ...next, ...(approve ? { approved: true } : {}) })
                return copy
              })
              setInserting(false)
            }}
            segment={segment}
            step={blank}
          />
        </div>
      )}
    </li>
  )
}

// ---- the card ------------------------------------------------------------------------------------------------------

function Frame({
  header,
  tone,
  children,
}: {
  header: ReactNode
  tone: 'brand' | 'warning' | 'success' | 'muted'
  children?: ReactNode
}) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-md border border-border border-l-2 bg-muted/20',
        tone === 'brand' && 'border-l-brand/50',
        tone === 'warning' && 'border-l-warning/70',
        tone === 'success' && 'border-l-success/60',
        tone === 'muted' && 'border-l-border',
      )}
      data-teach-review
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground last:border-b-0">
        {header}
      </header>
      {children}
    </section>
  )
}

/** The review of a teaching document's draft, or its outcome once saved or discarded. */
export function TeachReview({ teach, conversation }: { teach: Teach; conversation: number }) {
  const segment = teach.segment
  const steps = teach.steps ?? []
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<number>()
  const [flagged, setFlagged] = useState(false)
  if (!segment) return null
  const title = (
    <>
      <GraduationCapIcon className="size-3.5 text-brand" />
      <span className="text-foreground">Taught procedure</span>
      <span
        className="min-w-0 truncate font-sans text-[12px] text-foreground/90"
        title={segment.title}
      >
        “{segment.title}”
      </span>
    </>
  )
  if (segment.status === 'rejected')
    return (
      <Frame
        header={
          <>
            {title}
            <span className="ml-auto">discarded · frames deleted</span>
          </>
        }
        tone="muted"
      />
    )
  if (segment.status === 'saved' && teach.saved)
    return <Saved path={teach.saved.path} segment={segment} steps={steps} title={title} />
  if (segment.status !== 'review' || !steps.length) return null
  const approved = steps.filter((s) => s.approved === true).length
  const rejected = steps.filter((s) => s.approved === false).length
  const unreviewed = steps.length - approved - rejected
  const risky = steps.filter((s) => s.consequential && s.approved !== false).length
  const change = async (next: (steps: TaughtStep[]) => TaughtStep[]) => {
    setBusy(true)
    setError(undefined)
    try {
      await api.action(TeachEditAction, {
        conversation,
        steps: numbered(next(steps.map((s) => ({ ...s })))),
      })
    } catch (failure) {
      setError(errorMessage(failure))
      throw failure
    } finally {
      setBusy(false)
    }
  }
  const drops = dropped(segment)
  return (
    <Frame
      header={
        <>
          {title}
          <span className="ml-auto flex flex-wrap items-center gap-x-2 tabular-nums [&>*+*]:before:mr-2 [&>*+*]:before:text-muted-foreground/50 [&>*+*]:before:content-['·']">
            {approved > 0 && <span className="text-success">{approved} approved</span>}
            {rejected > 0 && <span>{rejected} rejected</span>}
            {unreviewed > 0 && <span className="text-warning">{unreviewed} to review</span>}
          </span>
        </>
      }
      tone={unreviewed ? 'warning' : 'brand'}
    >
      <div className="space-y-1 border-b border-border/60 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
        <p>
          <span className="text-foreground">
            Saved, this becomes instructions an agent follows.
          </span>{' '}
          Each label was read off the screen or written by the model: check that every step says
          what you did, and reject anything you did not do.
        </p>
        <p className="font-mono text-[11px]">
          {plural(steps.length, 'step')} from {plural(segment.frames.length, 'frame')}
          {drops.total > 0 && ` · ${drops.total} frames dropped (${drops.text})`}
          {risky > 0 && (
            <span className="text-warning">
              {' '}
              · {risky} consequential: the agent asks before each
            </span>
          )}
        </p>
      </div>
      <ol>
        {steps.map((step, index) => (
          <StepItem
            busy={busy}
            change={change}
            count={steps.length}
            editing={editing === index}
            flagged={flagged}
            index={index}
            key={`${step.n}:${step.frame}:${step.target.label}`}
            segment={segment}
            setEditing={(on) => setEditing(on ? index : undefined)}
            step={step}
          />
        ))}
      </ol>
      {error && (
        <p className="border-t border-border/60 px-3 py-2 font-mono text-[11.5px] break-words text-error">
          {error}
        </p>
      )}
      <SaveBar
        approved={approved}
        conversation={conversation}
        onRefused={() => {
          setFlagged(true)
          document
            .querySelector('[data-teach-step="unreviewed"]')
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }}
        segment={segment}
        steps={steps}
        unreviewed={unreviewed}
      />
    </Frame>
  )
}

/** Where the skill goes and under which name, and the buttons that save or discard the draft. */
function SaveBar({
  segment,
  steps,
  approved,
  unreviewed,
  conversation,
  onRefused,
}: {
  segment: Segment
  steps: TaughtStep[]
  approved: number
  unreviewed: number
  conversation: number
  onRefused: () => void
}) {
  const system = useSystem()
  const [scope, setScope] = useState<'project' | 'personal'>('project')
  const [name, setName] = useState(() => kebab(segment.title))
  const [overwrite, setOverwrite] = useState(false)
  const [exists, setExists] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const root = scope === 'project' ? (system?.project.root ?? '<project>') : '~'
  const shown = scope === 'project' ? '' : '~/'
  const pending = steps
    .filter((s) => s.approved === undefined)
    .map((s) => s.n)
    .join(', ')
  const save = () => {
    if (unreviewed) {
      setRefusal(
        `Review every step first: ${plural(unreviewed, 'step')} still open (${pending}). Approve or reject each.`,
      )
      onRefused()
      return
    }
    if (!approved) return setRefusal('Approve at least one step to save.')
    if (!validName(name))
      return setRefusal('Name it in lowercase words joined by hyphens, such as upload-skill.')
    setBusy(true)
    setRefusal(undefined)
    api
      .action(TeachSaveAction, { conversation, scope, name, ...(overwrite ? { overwrite } : {}) })
      .catch((failure: unknown) => {
        const message = errorMessage(failure)
        if (message.includes('overwrite')) {
          setExists(true)
          setRefusal(`A skill named ${name} already exists here.`)
        } else setRefusal(message)
      })
      .finally(() => setBusy(false))
  }
  return (
    <footer
      className="space-y-2.5 border-t border-border/60 bg-muted/30 px-3 py-2.5"
      data-teach-save
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex rounded-md border border-border" role="radiogroup">
          {(
            [
              ['project', 'This project'],
              ['personal', 'Personal'],
            ] as const
          ).map(([value, label]) => (
            <Choice
              disabled={busy}
              key={value}
              on={scope === value}
              onClick={() => {
                setScope(value)
                setExists(false)
                setOverwrite(false)
              }}
              tone="muted"
            >
              {label}
            </Choice>
          ))}
        </span>
        <label className="flex min-w-0 flex-1 basis-56 items-center gap-2">
          <span className="shrink-0 text-[12px] text-muted-foreground">Skill name</span>
          <input
            aria-invalid={!!name && !validName(name)}
            className={cn(input, 'aria-invalid:border-error/60')}
            data-teach-name
            maxLength={64}
            onChange={(event) => {
              setName(event.target.value)
              setExists(false)
              setOverwrite(false)
            }}
            placeholder="upload-skill"
            value={name}
          />
        </label>
      </div>
      <p
        className="font-mono text-[11px] leading-[1.6] break-all text-muted-foreground"
        title={`${root}/.ultimate/skills/${name}/SKILL.md`}
      >
        → {shown}.ultimate/skills/{name || '…'}/SKILL.md
        <span className="break-normal">
          {scope === 'project'
            ? ' · in this project; loads only while it is trusted'
            : ' · for you, in every project'}
        </span>
      </p>
      {exists && (
        <label className="flex items-center gap-2 text-[12px] text-warning">
          <Checkbox checked={overwrite} onCheckedChange={(value) => setOverwrite(value === true)} />
          Replace the existing {name} skill
        </label>
      )}
      {refusal && (
        <p className="text-[12px] leading-relaxed break-words text-warning" data-teach-refusal>
          {refusal}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {discarding ? (
          <span className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            Discard the draft and delete its {plural(segment.frames.length, 'frame')}?
            <Button
              className="h-7 border-error/40 font-sans text-[12px] text-error hover:bg-error/10 hover:text-error"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                api
                  .action(TeachRejectAction, { conversation })
                  .catch((failure: unknown) => setRefusal(errorMessage(failure)))
                  .finally(() => setBusy(false))
              }}
              size="sm"
              variant="outline"
            >
              Discard
            </Button>
            <Button
              className="h-7 font-sans text-[12px]"
              onClick={() => setDiscarding(false)}
              size="sm"
              variant="ghost"
            >
              Keep
            </Button>
          </span>
        ) : (
          <Button
            className="h-7 gap-1.5 px-2 font-sans text-[12px] text-muted-foreground"
            onClick={() => setDiscarding(true)}
            size="sm"
            variant="ghost"
          >
            <Trash2Icon className="size-3" />
            Discard draft
          </Button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span
            className={cn(
              'font-mono text-[11px]',
              unreviewed ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            {unreviewed
              ? `${plural(unreviewed, 'step')} to review`
              : `saves ${plural(approved, 'approved step')}`}
          </span>
          <Button
            className="h-7 font-sans text-[12px]"
            data-teach-save-button
            disabled={busy || (exists && !overwrite)}
            onClick={save}
            size="sm"
          >
            {busy && <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />}
            {exists ? 'Replace skill' : 'Save as skill'}
          </Button>
        </span>
      </div>
    </footer>
  )
}

/** A saved lesson: where the skill is, what went in, and what it now is. */
function Saved({
  segment,
  steps,
  path,
  title,
}: {
  segment: Segment
  steps: TaughtStep[]
  path: string
  title: ReactNode
}) {
  const kept = steps.filter((s) => s.approved)
  const left = steps.length - kept.length
  const risky = kept.filter((s) => s.consequential).length
  return (
    <Frame
      header={
        <>
          {title}
          <span className="ml-auto text-success">saved as a skill</span>
        </>
      }
      tone="success"
    >
      <div className="space-y-1 px-3 py-2.5 font-mono text-[11.5px] leading-[1.6]">
        <p className="break-all text-foreground">{path}/SKILL.md</p>
        <p className="text-muted-foreground">
          {plural(kept.length, 'step')}
          {left > 0 && ` · ${left} rejected, left out`}
          {risky > 0 && <span className="text-warning"> · {risky} consequential</span>} ·{' '}
          {plural(segment.frames.length, 'frame')} recorded
          {segment.startedAt ? ` · ${formatTime(segment.startedAt)}` : ''}
        </p>
        <p className="font-sans text-[12px] leading-relaxed text-muted-foreground">
          Agents now load it as instructions. Its screen text stays marked as data, never commands;
          values such as passwords are asked for by name at run time.
        </p>
      </div>
    </Frame>
  )
}
