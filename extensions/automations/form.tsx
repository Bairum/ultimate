import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CoinsIcon,
  LoaderCircleIcon,
  SlidersHorizontalIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, cn, errorMessage, events, formatKeys, useAction, useEvent, useNow } from '@/sdk'
import { clock, full, until, words } from './parts.tsx'
import type { Automation, Described } from './parts.tsx'

type Mode = 'cron' | 'at' | 'every'
interface Draft {
  name: string
  prompt: string
  mode: Mode
  cron: string
  tz: string
  /** `in 30m`, a local `2026-12-01 09:00`, or an ISO time with an offset. */
  at: string
  every: string
  /** An agent definition's name; empty for a copy of the main agent. */
  agent: string
}
type Model = { model?: { provider: string; modelId: string }; thinking?: string }
/** The `definitions` action of `subagents`: what an automation can name as its agent, and the main agent's model. */
interface Definitions {
  definitions: (Model & {
    name: string
    description: string
    source: 'builtin' | 'user' | 'project'
  })[]
  main?: Model
}
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const zones = Intl.supportedValuesOf('timeZone')
const pad = (value: number) => String(value).padStart(2, '0')

const presets: { label: string; draft: Partial<Draft> }[] = [
  { label: 'Every weekday at 9', draft: { mode: 'cron', cron: '0 9 * * 1-5' } },
  { label: 'Every hour', draft: { mode: 'every', every: '1h' } },
  { label: 'In 30 minutes', draft: { mode: 'at', at: 'in 30m' } },
]
const modes: { value: Mode; label: string; hint: string }[] = [
  { value: 'cron', label: 'Cron', hint: 'minute hour day month weekday · Sunday is 0' },
  { value: 'at', label: 'At', hint: 'once: in 30m, in 2h, or a local date and time' },
  { value: 'every', label: 'Every', hint: 'an interval: 30s, 15m, 2h, 1d · at least 1s' },
]

function draftOf(automation?: Automation): Draft {
  const blank: Draft = {
    name: '',
    prompt: '',
    mode: 'cron',
    cron: '0 9 * * 1-5',
    tz: zone,
    at: 'in 30m',
    every: '1h',
    agent: '',
  }
  if (!automation) return blank
  const { schedule } = automation
  const draft = { ...blank, name: automation.name, prompt: automation.prompt, mode: schedule.kind }
  draft.agent = automation.agent ?? ''
  if (schedule.kind === 'cron') return { ...draft, cron: schedule.expr, tz: schedule.tz }
  if (schedule.kind === 'every') return { ...draft, every: interval(schedule.ms) }
  const date = new Date(schedule.time)
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return { ...draft, at: date.getSeconds() ? `${local}:${pad(date.getSeconds())}` : local }
}

function interval(ms: number) {
  for (const [unit, size] of [
    ['d', 86400000],
    ['h', 3600000],
    ['m', 60000],
  ] as const)
    if (ms % size === 0) return `${ms / size}${unit}`
  return `${ms / 1000}s`
}

/** The schedule in the tool's grammar, which the actions accept; undefined while a field is empty. */
function scheduleOf(draft: Draft): string | undefined {
  if (draft.mode === 'cron')
    return draft.cron.trim() ? `cron "${draft.cron.trim()}" ${draft.tz.trim() || zone}` : undefined
  if (draft.mode === 'every') return draft.every.trim() ? `every ${draft.every.trim()}` : undefined
  const at = draft.at.trim()
  if (!at) return undefined
  if (/^in\s/.test(at)) return at.replace(/^in\s+/, 'in ')
  // A date and time without an offset is local to this browser, which runs on the machine Ultimate runs on.
  const local = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?$/.test(at) && new Date(at.replace(' ', 'T'))
  return `at ${local && Number.isFinite(local.getTime()) ? local.toISOString() : at}`
}

const matches = (draft: Draft, preset: Partial<Draft>) =>
  Object.entries(preset).every(([key, value]) => draft[key as keyof Draft] === value)

/** Waits `ms` after the last change of `value`. */
function useSettled<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

const input =
  'h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40'

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12.5px] font-medium text-foreground/90" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

/** What the backend makes of the schedule: in words, the next fire times, and how often it costs a run. */
function Preview({ schedule }: { schedule: string | undefined }) {
  const settled = useSettled(schedule, 250)
  const described = useAction<Described>(
    'automations',
    'describe',
    { schedule: settled ?? '' },
    { enabled: settled !== undefined, onError: () => {} },
  )
  const now = useNow(1000)
  const data = settled === schedule ? described.data : undefined
  const error = settled === schedule ? described.error : undefined
  const perDay =
    data && data.next.length > 1 ? Math.round(86400000 / (data.next[1] - data.next[0])) : 0
  return (
    <div className="min-h-[5.25rem] rounded-md border border-border/70 bg-card/60 px-2.5 py-2">
      {/* Announces what the schedule means, not the ticking countdown below. */}
      <span aria-live="polite" className="sr-only">
        {error ? error.message : data ? words(data.schedule, data.description, now) : ''}
      </span>
      {error ? (
        <p className="flex items-start gap-1.5 font-mono text-[11.5px] leading-snug text-error">
          <XIcon className="mt-px size-3 shrink-0" />
          {error.message.replace(/^automations\/describe: /, '')}
        </p>
      ) : !data ? (
        <p className="flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
          {schedule === undefined ? (
            'Fill in the schedule to see its next runs.'
          ) : (
            <>
              <LoaderCircleIcon className="size-3 animate-spin" /> reading the schedule…
            </>
          )}
        </p>
      ) : (
        <>
          <p className="text-[12.5px] text-foreground/90">
            {words(data.schedule, data.description, now)}
          </p>
          <ol className="mt-1 flex flex-col gap-0.5 font-mono text-[11.5px]">
            {data.next.map((at, index) => (
              <li className="flex gap-2" key={at} title={full(at)}>
                <span className="w-9 shrink-0 text-muted-foreground/60">
                  {index === 0 ? 'next' : 'then'}
                </span>
                <span className="text-foreground/85 tabular-nums">{clock(at, now)}</span>
                {index === 0 && (
                  <span className={at <= now ? 'text-warning' : 'text-muted-foreground'}>
                    {at <= now ? 'passed: fires at once' : until(at, now)}
                  </span>
                )}
              </li>
            ))}
          </ol>
          {perDay > 1 && (
            <p className="mt-1 font-mono text-[11px] text-warning">
              about {perDay.toLocaleString()} runs a day
            </p>
          )}
        </>
      )}
    </div>
  )
}

const model = (agent: Model | undefined, fallback: string) =>
  agent?.model ? `${agent.model.modelId}${agent.thinking ? ` · ${agent.thinking}` : ''}` : fallback

/** Which agent runs the prompt: a copy of the main agent, or a shared agent definition with its own model. */
function AgentPicker({ value, onChange }: { value: string; onChange: (agent: string) => void }) {
  const { data, refetch } = useAction<Definitions>('subagents', 'definitions', null, {
    onError: () => {},
  })
  // A definition changed in its config dialog shows its new model here once the dialog closes, and focus comes back to
  // Configure: opened over the bus, that dialog has no trigger of its own to return focus to.
  const configure = useRef<HTMLButtonElement>(null)
  const opened = useRef(false)
  useEvent('subagents:definition-closed', () => {
    if (!opened.current) return
    opened.current = false
    void refetch()
    requestAnimationFrame(() => configure.current?.focus())
  })
  const definitions = data?.definitions ?? []
  const chosen = definitions.find((definition) => definition.name === value)
  const main = model(data?.main, "the main conversation's model")
  const inherits = `inherits · ${data?.main?.model?.modelId ?? 'main'}`
  return (
    <div className="flex gap-2">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Agent"
            className={cn(input, 'flex items-center gap-2 text-left')}
            id="automation-agent"
            type="button"
          >
            <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-foreground/90">{value || 'Main agent'}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {value
                ? chosen
                  ? model(chosen, inherits)
                  : 'not found'
                : `a copy of main · ${main}`}
            </span>
            <ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-72 w-(--radix-dropdown-menu-trigger-width) min-w-72"
        >
          <DropdownMenuRadioGroup onValueChange={onChange} value={value}>
            <DropdownMenuRadioItem className="items-start text-[12.5px]" value="">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline gap-2">
                  <span>Main agent</span>
                  <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground">
                    {main}
                  </span>
                </span>
                <span className="text-[11.5px] text-muted-foreground">
                  A copy of the main conversation's agent, its tools and model
                </span>
              </span>
            </DropdownMenuRadioItem>
            {definitions.map((definition) => (
              <DropdownMenuRadioItem
                className="items-start text-[12.5px]"
                key={definition.name}
                value={definition.name}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono">{definition.name}</span>
                    <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground">
                      {model(definition, inherits)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[11.5px] text-muted-foreground">
                    {definition.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
            {value && !chosen && data && (
              <DropdownMenuRadioItem className="text-[12.5px] text-error" value={value}>
                {value} (not found)
              </DropdownMenuRadioItem>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {chosen && (
        <Button
          className="h-8 shrink-0 gap-1.5 px-2.5 text-[12px]"
          onClick={() => {
            opened.current = true
            events.emit('subagents:open-definition', { name: chosen.name })
          }}
          ref={configure}
          size="sm"
          title={`Open the ${chosen.name} definition: model, thinking, tools, and instructions`}
          type="button"
          variant="outline"
        >
          <SlidersHorizontalIcon className="size-3.5" />
          Configure
        </Button>
      )}
    </div>
  )
}

/**
 * Create or edit an automation: name, prompt, schedule (presets or the raw forms) with the backend's preview, and the
 * agent. `automation` edits it; without one the form creates. `onClosed` runs once the dialog has gone, to move focus.
 * Mount it with a new `key` for each opening, so it starts from the automation as it is then, or blank.
 */
export function AutomationForm({
  open,
  automation,
  onOpenChange,
  onSaved,
  onClosed,
}: {
  open: boolean
  automation?: Automation
  onOpenChange: (open: boolean) => void
  onSaved: (automation: Automation) => void
  onClosed: () => void
}) {
  const [draft, setDraft] = useState(() => draftOf(automation))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const ids = useId()
  const name = useRef<HTMLInputElement>(null)
  const set = (change: Partial<Draft>) => setDraft((previous) => ({ ...previous, ...change }))
  const schedule = scheduleOf(draft)
  const ready = draft.name.trim() && draft.prompt.trim() && schedule !== undefined && !saving
  const save = async () => {
    if (!ready) return
    setSaving(true)
    setError(undefined)
    try {
      const fields = { name: draft.name.trim(), prompt: draft.prompt.trim(), schedule }
      const saved = automation
        ? await api.action<Automation>('automations', 'update', {
            id: automation.id,
            ...fields,
            agent: draft.agent,
          })
        : await api.action<Automation>('automations', 'create', {
            ...fields,
            ...(draft.agent ? { agent: draft.agent } : {}),
          })
      onSaved(saved)
      onOpenChange(false)
    } catch (failure) {
      setError(errorMessage(failure).replace(/^automations\/\w+: /, ''))
    } finally {
      setSaving(false)
    }
  }
  const mode = modes.find((candidate) => candidate.value === draft.mode)!
  const submitKeys = formatKeys('mod+enter')[0] ?? []
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex max-h-[min(48rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onClosed()
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          name.current?.focus()
        }}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="px-5 pt-5 pb-3">
            <DialogTitle className="text-[14px] font-medium">
              {automation ? 'Edit automation' : 'New automation'}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-[12.5px] leading-relaxed">
              Runs the prompt on a schedule. Each run is a new conversation you can open.
            </DialogDescription>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-1 pb-5">
            <Field htmlFor={`${ids}-name`} label="Name">
              <input
                autoComplete="off"
                className={input}
                id={`${ids}-name`}
                onChange={(event) => set({ name: event.target.value })}
                placeholder="Morning summary"
                ref={name}
                value={draft.name}
              />
            </Field>
            <Field htmlFor={`${ids}-prompt`} label="Prompt">
              <textarea
                className={cn(input, 'h-auto min-h-24 resize-y py-2 leading-relaxed')}
                id={`${ids}-prompt`}
                onChange={(event) => set({ prompt: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void save()
                  }
                }}
                placeholder="Summarise yesterday's commits and open questions."
                rows={4}
                value={draft.prompt}
              />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-[12.5px] font-medium text-foreground/90">
                Schedule
              </legend>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Presets">
                {presets.map((preset) => {
                  const pressed = matches(draft, preset.draft)
                  return (
                    <button
                      aria-pressed={pressed}
                      className={cn(
                        'flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        pressed
                          ? 'border-brand/60 bg-brand/10 text-foreground'
                          : 'border-border/80 text-muted-foreground hover:border-border hover:text-foreground',
                      )}
                      key={preset.label}
                      onClick={() => set(preset.draft)}
                      type="button"
                    >
                      {pressed && <CheckIcon className="size-3 text-brand" />}
                      {preset.label}
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-2">
                <div
                  aria-label="Schedule kind"
                  className="inline-flex shrink-0 rounded-md border border-border/80 bg-background p-0.5 font-mono text-[11px]"
                  role="radiogroup"
                >
                  {modes.map((option) => (
                    <button
                      aria-checked={option.value === draft.mode}
                      className={cn(
                        'flex h-6 items-center rounded-[5px] px-2.5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                        option.value === draft.mode && 'bg-accent text-foreground shadow-xs',
                      )}
                      key={option.value}
                      onClick={() => set({ mode: option.value })}
                      role="radio"
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground/70">
                  {mode.hint}
                </span>
              </div>
              {draft.mode === 'cron' ? (
                <div className="flex gap-2">
                  <input
                    aria-label="Cron expression"
                    autoComplete="off"
                    className={cn(input, 'flex-[3] font-mono text-[12.5px]')}
                    onChange={(event) => set({ cron: event.target.value })}
                    placeholder="0 9 * * 1-5"
                    spellCheck={false}
                    value={draft.cron}
                  />
                  <input
                    aria-label="Timezone"
                    autoComplete="off"
                    className={cn(input, 'flex-[2] font-mono text-[12.5px]')}
                    list={`${ids}-zones`}
                    onChange={(event) => set({ tz: event.target.value })}
                    placeholder={zone}
                    spellCheck={false}
                    value={draft.tz}
                  />
                  <datalist id={`${ids}-zones`}>
                    {zones.map((tz) => (
                      <option key={tz} value={tz} />
                    ))}
                  </datalist>
                </div>
              ) : draft.mode === 'at' ? (
                <input
                  aria-label="Time"
                  autoComplete="off"
                  className={cn(input, 'font-mono text-[12.5px]')}
                  onChange={(event) => set({ at: event.target.value })}
                  placeholder="in 30m · 2026-12-01 09:00"
                  spellCheck={false}
                  value={draft.at}
                />
              ) : (
                <input
                  aria-label="Interval"
                  autoComplete="off"
                  className={cn(input, 'font-mono text-[12.5px]')}
                  onChange={(event) => set({ every: event.target.value })}
                  placeholder="15m"
                  spellCheck={false}
                  value={draft.every}
                />
              )}
              <Preview schedule={schedule} />
            </fieldset>
            <Field htmlFor="automation-agent" label="Agent">
              <AgentPicker onChange={(agent) => set({ agent })} value={draft.agent} />
            </Field>
            {error && (
              <p className="flex items-start gap-1.5 font-mono text-[11.5px] leading-snug break-words text-error">
                <XIcon className="mt-px size-3 shrink-0" />
                {error}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
            <p className="flex min-w-0 items-start gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
              <CoinsIcon className="mt-px size-3.5 shrink-0 text-warning" />
              Each run uses the model and costs tokens.
            </p>
            <Button
              className="ml-auto"
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={!ready}
              size="sm"
              title={`${automation ? 'Save' : 'Create'} (${submitKeys.join('+')})`}
              type="submit"
            >
              {saving && <LoaderCircleIcon className="size-3.5 animate-spin" />}
              {automation ? 'Save' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
