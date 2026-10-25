import { ChevronRightIcon, CircleAlertIcon, LockIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, cn, errorMessage, refusedForPairing, usePairing } from '@/sdk'
import { REVIEW_POINTS, ROLES, SetConfigAction, SetRubricAction } from './refs.ts'
import type {
  AdvisorConfig,
  AdvisorSpec,
  ConfigView,
  Role,
  RoleProfile,
  Threshold,
} from './refs.ts'

type Scope = 'user' | 'project'
type Source = 'default' | 'user' | 'project' | 'fixed'

const input =
  'h-7 w-full min-w-0 rounded-md border border-input bg-transparent px-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-error/70 disabled:opacity-50'
const heading = 'font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase'
const NAME = /^[a-z0-9-]{1,40}$/
const MODEL = /^[^/\s:]+\/[^\s:]+(?::(off|minimal|low|medium|high|xhigh|max))?$/
const thresholds: Threshold[] = ['never', 'nit', 'concern', 'blocker']

/** Whatever the reader typed, kept even when invalid so validation can say why. */
type Loose = Record<string, unknown>
const object = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v)

/** A copy with `path` set to `value`, or removed when `value` is undefined; empty parents go too. */
function setPath(config: AdvisorConfig, path: string[], value: unknown): AdvisorConfig {
  const next = structuredClone(config) as Loose
  let at = next
  const parents: Loose[] = []
  for (const key of path.slice(0, -1)) {
    if (!object(at[key])) at[key] = {}
    parents.push(at)
    at = at[key] as Loose
  }
  const last = path.at(-1)!
  if (value === undefined) delete at[last]
  else at[last] = value
  for (let i = parents.length - 1; i >= 0; i--) {
    const child = parents[i][path[i]] as Loose
    if (Object.keys(child).length === 0) delete parents[i][path[i]]
  }
  return next
}

/** What the server would refuse, by field path, so the reader sees it before saving. */
export function validate(config: AdvisorConfig): Record<string, string> {
  const problems: Record<string, string> = {}
  const num = (path: string, v: unknown, min: number, max = Infinity, integer = false) => {
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v)) problems[path] = 'must be a number'
    else if (integer && !Number.isInteger(v)) problems[path] = 'must be a whole number'
    else if (v < min || v > max)
      problems[path] = max === Infinity ? `must be at least ${min}` : `must be ${min}–${max}`
  }
  const model = (path: string, v: unknown) => {
    if (v !== undefined && (typeof v !== 'string' || !MODEL.test(v)))
      problems[path] = 'use provider/id or provider/id:thinking'
  }
  model('model', config.model)
  num('dayUsd', config.dayUsd, 0)
  for (const [name, spec] of Object.entries(config.advisors ?? {})) {
    if (!NAME.test(name)) problems[`advisors.${name}`] = 'name: lowercase letters, digits, hyphens'
    model(`advisors.${name}.model`, spec.model)
    if (spec.rubric !== undefined && !NAME.test(spec.rubric))
      problems[`advisors.${name}.rubric`] = 'lowercase letters, digits, hyphens'
    num(`advisors.${name}.maxToolCalls`, spec.maxToolCalls, 1, 20, true)
    num(`advisors.${name}.maxNotes`, spec.maxNotes, 1, 10, true)
  }
  for (const [role, profile] of Object.entries(config.roles ?? {})) {
    if (!profile) continue
    num(`roles.${role}.every`, profile.every, 1, Infinity, true)
    num(`roles.${role}.quietMs`, profile.quietMs, 0)
    num(`roles.${role}.idleMs`, profile.idleMs, 0)
    num(`roles.${role}.dayUsd`, profile.dayUsd, 0)
    if (profile.advisors?.length === 0)
      problems[`roles.${role}.advisors`] = 'pick at least one advisor'
    if (profile.at?.length === 0) problems[`roles.${role}.at`] = 'pick at least one review point'
  }
  return problems
}

/** The editor: a draft of one layer, the effective value and source of every field, rubrics, and saving. */
export function Editor({
  view,
  onSaved,
}: {
  view: ConfigView
  onSaved: (view: ConfigView) => void
}) {
  const [scope, setScope] = useState<Scope>('user')
  const [draft, setDraft] = useState<AdvisorConfig>(view.user)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const paired = usePairing().whoami?.host
  const saved = view[scope]
  // A fresh view (a save, a reload) resets the draft of the layer shown.
  useEffect(() => setDraft(view[scope]), [view, scope])
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const problems = validate(draft)
  const invalid = Object.keys(problems).length > 0
  const set = (path: string[], value: unknown) => {
    setError(undefined)
    setDraft((previous) => setPath(previous, path, value))
  }
  /** Where a field's value comes from with this draft in place of its layer. */
  const layers = {
    user: scope === 'user' ? draft : view.user,
    project: scope === 'project' ? draft : view.project,
  }
  const pick = (path: string[]): { value: unknown; source: Source } => {
    const read = (config: AdvisorConfig) =>
      path.reduce<unknown>((at, key) => (object(at) ? at[key] : undefined), config)
    for (const layer of ['project', 'user'] as const) {
      const value = read(layers[layer])
      if (value !== undefined) return { value, source: layer }
    }
    // Unset in both: the effective value is the default unless a saved layer set it, which the draft just removed.
    const fromSaved = read(view.project) !== undefined || read(view.user) !== undefined
    return { value: fromSaved ? undefined : read(view.effective), source: 'default' }
  }
  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      const empty = Object.keys(draft).length === 0
      onSaved(await api.action(SetConfigAction, { scope, config: empty ? null : draft }))
    } catch (failure) {
      setError(
        refusedForPairing(failure)
          ? 'Saving needs a paired browser. Open Ultimate on this machine and pair it, then save again.'
          : errorMessage(failure).replace(/^advisor\/setConfig: /, ''),
      )
    } finally {
      setSaving(false)
    }
  }
  const roster = [
    ...new Set([
      ...Object.keys(view.effective.advisors ?? {}),
      ...Object.keys(draft.advisors ?? {}),
      ...view.rubrics.map((r) => r.name),
    ]),
  ].toSorted()
  const model = pick(['model']).value as string | undefined
  const dayUsd = pick(['dayUsd']).value as number | undefined
  return (
    <div className="pb-24" data-advisor-editor={scope}>
      <div className="space-y-2 px-3 pt-1 pb-3">
        <ScopeSwitch scope={scope} trusted={view.projectTrusted} setScope={setScope} />
        {paired === false && (
          <Callout icon={LockIcon}>
            Saving needs a paired browser. You can look around and draft changes here; pair this
            browser to save them.
          </Callout>
        )}
        {view.problems.map((problem) => (
          <Callout error icon={CircleAlertIcon} key={problem}>
            {problem}
          </Callout>
        ))}
      </div>

      <Group title="Defaults">
        <FieldRow error={problems.model} label="Model" source={pick(['model']).source}>
          <TextField
            invalid={!!problems.model}
            onChange={(v) => set(['model'], v || undefined)}
            placeholder={model ?? 'provider/id:thinking'}
            value={draft.model ?? ''}
          />
        </FieldRow>
        {model === undefined && (
          <p className="-mt-1 pb-1 pl-22 text-[11.5px] text-warning">
            No model: every review skips until you set one.
          </p>
        )}
        <FieldRow error={problems.dayUsd} label="$ / day" source={pick(['dayUsd']).source}>
          <NumberField
            invalid={!!problems.dayUsd}
            onChange={(v) => set(['dayUsd'], v)}
            placeholder={String(dayUsd ?? 5)}
            value={draft.dayUsd}
          />
        </FieldRow>
      </Group>

      <Group meta="all off by default" title="Roles">
        {ROLES.map((role) => (
          <RoleRow
            key={role}
            pick={(key) => pick(['roles', role, key])}
            problems={problems}
            role={role}
            roster={roster}
            set={(key, value) => set(['roles', role, key], value)}
          />
        ))}
      </Group>

      <Group title="Advisors">
        {roster.map((name) => (
          <AdvisorRow
            key={name}
            name={name}
            pick={(key) => pick(['advisors', name, key])}
            problems={problems}
            set={(key, value) => set(['advisors', name, key], value)}
          />
        ))}
        <NewAdvisor names={roster} onAdd={(name) => set(['advisors', name], {})} />
      </Group>

      <Rubrics scope={scope} trusted={view.projectTrusted} view={view} onSaved={onSaved} />

      <footer className="sticky bottom-0 z-10 border-t border-border/70 bg-background/95 px-3 py-2 backdrop-blur">
        {error && (
          <p
            className="mb-2 flex items-start gap-1.5 text-[12px] leading-snug text-error"
            role="alert"
          >
            <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
            {error}
          </p>
        )}
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
            {invalid ? (
              <span className="text-error">
                {Object.keys(problems).length === 1
                  ? '1 field needs fixing'
                  : `${Object.keys(problems).length} fields need fixing`}
              </span>
            ) : dirty ? (
              'Unsaved changes'
            ) : (
              `${scope === 'user' ? '~/.ultimate' : '.ultimate'}/settings.json`
            )}
          </span>
          <Button
            className="h-7 text-[12px]"
            disabled={!dirty || saving}
            onClick={() => {
              setError(undefined)
              setDraft(saved)
            }}
            size="sm"
            variant="ghost"
          >
            Revert
          </Button>
          <Button
            className="h-7 text-[12px]"
            disabled={!dirty || invalid || saving}
            onClick={() => void save()}
            size="sm"
          >
            {saving ? 'Saving…' : `Save ${scope}`}
          </Button>
        </div>
      </footer>
    </div>
  )
}

function ScopeSwitch({
  scope,
  trusted,
  setScope,
}: {
  scope: Scope
  trusted: boolean
  setScope: (scope: Scope) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground">Edit</span>
        <Segmented<Scope>
          label="Settings layer"
          onChange={setScope}
          options={[
            { value: 'user', label: 'user', title: 'Your settings, every project on this machine' },
            {
              value: 'project',
              label: 'project',
              title: trusted
                ? 'This project only; wins over user settings'
                : 'The project is not trusted, so its advisor settings are ignored',
              disabled: !trusted,
            },
          ]}
          value={scope}
        />
      </div>
      <p className="text-[11.5px] leading-snug text-muted-foreground/80">
        {scope === 'user'
          ? 'Applies to every project. A trusted project’s settings win field by field.'
          : 'Applies to this project and wins over your user settings.'}
        {!trusted &&
          ' Project settings are off: this project is not trusted, so Ultimate ignores its advisor settings and rubrics.'}
      </p>
    </div>
  )
}

function Group({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="border-t border-border/60 px-3 pt-2.5 pb-2">
      <h3 className={cn(heading, 'flex items-center pb-1.5')}>
        {title}
        {meta && (
          <span className="ml-auto tracking-normal normal-case text-muted-foreground/60">
            {meta}
          </span>
        )}
      </h3>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function Callout({
  icon: Icon,
  error,
  children,
}: {
  icon: typeof LockIcon
  error?: boolean
  children: ReactNode
}) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-md border px-2.5 py-2 text-[12px] leading-snug',
        error
          ? 'border-error/30 bg-error/5 text-error'
          : 'border-border/70 bg-muted/30 text-muted-foreground',
      )}
    >
      <Icon className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** Which layer set a value; the default stays unmarked so set values stand out. */
function SourceTag({ source }: { source: Source }) {
  if (source === 'default') return null
  return (
    <span
      className={cn(
        'ml-auto shrink-0 pl-1 text-right font-mono text-[10px]',
        source === 'fixed' ? 'text-muted-foreground/60' : 'text-brand/90',
      )}
      title={source === 'fixed' ? 'Fixed by Ultimate' : `Set in ${source} settings`}
    >
      {source}
    </span>
  )
}

function FieldRow({
  label,
  source,
  error,
  children,
}: {
  label: string
  source: Source
  error?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <div>
      <div className="flex min-h-7 items-center gap-2">
        <span className="w-20 shrink-0 text-[12px] text-muted-foreground" id={id}>
          {label}
        </span>
        <div aria-labelledby={id} className="flex min-w-0 flex-1 items-center" role="group">
          {children}
        </div>
        <SourceTag source={source} />
      </div>
      {error && <p className="pb-1 pl-22 font-mono text-[11px] text-error">{error}</p>}
    </div>
  )
}

function TextField({
  value,
  placeholder,
  invalid,
  onChange,
}: {
  value: string
  placeholder?: string
  invalid?: boolean
  onChange: (value: string) => void
}) {
  return (
    <input
      aria-invalid={invalid || undefined}
      autoComplete="off"
      className={input}
      onChange={(event) => onChange(event.target.value.trim())}
      placeholder={placeholder}
      spellCheck={false}
      value={value}
    />
  )
}

/**
 * A number the reader types; `scale` converts what is stored (milliseconds) to what is shown (minutes). Empty is unset,
 * and text that is not a number is kept as typed so validation can name it.
 */
function NumberField({
  value,
  placeholder,
  invalid,
  scale = 1,
  onChange,
}: {
  value: unknown
  placeholder?: string
  invalid?: boolean
  scale?: number
  onChange: (value: unknown) => void
}) {
  const shown =
    typeof value === 'number'
      ? String(+(value / scale).toFixed(4))
      : ((value as string | undefined) ?? '')
  const [text, setText] = useState(shown)
  // Follow outside changes (revert, a save) without fighting the reader's typing.
  useEffect(() => {
    setText((current) => (Number(current) * scale === value || current === value ? current : shown))
  }, [shown, value, scale])
  return (
    <input
      aria-invalid={invalid || undefined}
      autoComplete="off"
      className={cn(input, 'w-24 flex-none text-right tabular-nums')}
      inputMode="decimal"
      onChange={(event) => {
        const raw = event.target.value.trim()
        setText(event.target.value)
        if (raw === '') onChange(undefined)
        else if (Number.isFinite(Number(raw))) onChange(Number(raw) * scale)
        else onChange(raw)
      }}
      placeholder={placeholder}
      value={text}
    />
  )
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: { value: T; label: string; title?: string; disabled?: boolean }[]
  value: T | undefined
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}) {
  return (
    <div
      aria-label={label}
      className="inline-flex max-w-full flex-wrap rounded-md border border-border/80 p-px"
      role="radiogroup"
    >
      {options.map((option) => (
        <button
          aria-checked={option.value === value}
          className={cn(
            'h-6 cursor-pointer rounded-[5px] px-1.5 font-mono text-[11px] text-muted-foreground transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
            option.value === value ? 'bg-accent text-foreground' : 'hover:text-foreground',
          )}
          disabled={disabled || option.disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** Several picks from a list, kept in the order picked. */
function Picks<T extends string>({
  options,
  value,
  onChange,
  invalid,
}: {
  options: readonly T[]
  value: T[]
  onChange: (value: T[]) => void
  invalid?: boolean
}) {
  return (
    <div
      className={cn('flex min-w-0 flex-wrap gap-1 rounded-md', invalid && 'ring-1 ring-error/60')}
    >
      {options.map((option) => {
        const on = value.includes(option)
        return (
          <button
            aria-pressed={on}
            className={cn(
              'h-6 cursor-pointer rounded-md border px-1.5 font-mono text-[11px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
              on
                ? 'border-brand/40 bg-brand/10 text-foreground'
                : 'border-border/70 text-muted-foreground hover:text-foreground',
            )}
            key={option}
            onClick={() => onChange(on ? value.filter((v) => v !== option) : [...value, option])}
            type="button"
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

const pointWords: Record<string, string> = {
  answer: 'final answers',
  rounds: 'every few tool rounds',
  signals: 'risk signals',
  idle: 'idle conversations',
}

/** One role: its switch and what it will do in a line; open, every field with the layer that set it. */
function RoleRow({
  role,
  roster,
  pick,
  set,
  problems,
}: {
  role: Role
  roster: string[]
  pick: (key: keyof RoleProfile) => { value: unknown; source: Source }
  set: (key: keyof RoleProfile, value: unknown) => void
  problems: Record<string, string>
}) {
  const [open, setOpen] = useState(false)
  const value = <K extends keyof RoleProfile>(key: K) => pick(key).value as RoleProfile[K]
  const enabled = value('enabled') === true
  const ultimate = role === 'ultimate'
  const p = (key: string) => problems[`roles.${role}.${key}`]
  const failing = Object.keys(problems).some((key) => key.startsWith(`roles.${role}.`))
  const advisors = value('advisors') ?? []
  const at = value('at') ?? []
  const continueOn = value('continueOn')
  const steerOn = value('steerOn')
  const summary = [
    `${advisors.join(', ') || 'no advisor'} on ${at.map((point) => pointWords[point]).join(', ') || 'nothing'}`,
    value('delivery') === 'card' ? 'shown to you only' : 'the agent reads notes next turn',
    !ultimate &&
      continueOn &&
      continueOn !== 'never' &&
      `a ${continueOn} sends an answer back once`,
    !ultimate && steerOn && steerOn !== 'never' && `a ${steerOn} steers mid-run`,
    value('dayUsd') !== undefined && `$${value('dayUsd')}/day`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      className={cn('-mx-1.5 rounded-md px-1.5', open && 'bg-muted/30 pb-2')}
      data-advisor-role={role}
    >
      <div className="flex min-h-8 items-center gap-2">
        <Switch
          aria-label={`Review ${role} conversations`}
          checked={enabled}
          onCheckedChange={(on) => set('enabled', on || undefined)}
        />
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setOpen(!open)}
          type="button"
        >
          <span
            className={cn(
              'shrink-0 font-mono text-[12px]',
              enabled ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {ultimate ? '@ultimate' : role}
          </span>
          {failing && <CircleAlertIcon className="size-3 shrink-0 text-error" />}
          <span
            className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground/70"
            title={summary}
          >
            {enabled ? summary : 'off'}
          </span>
          <ChevronRightIcon
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
        </button>
        <SourceTag source={pick('enabled').source} />
      </div>
      {enabled && !open && (
        <p className="pb-1.5 pl-9 text-[11.5px] leading-snug text-muted-foreground/80">{summary}</p>
      )}
      {open && (
        <div className="space-y-0.5 pt-1 pl-1">
          <FieldRow error={p('advisors')} label="Advisors" source={pick('advisors').source}>
            <Picks
              invalid={!!p('advisors')}
              onChange={(v) => set('advisors', v)}
              options={[...new Set([...roster, ...advisors])]}
              value={advisors}
            />
          </FieldRow>
          <FieldRow error={p('at')} label="Review at" source={pick('at').source}>
            <Picks
              invalid={!!p('at')}
              onChange={(v) => set('at', v)}
              options={REVIEW_POINTS}
              value={at}
            />
          </FieldRow>
          {at.includes('rounds') && (
            <FieldRow error={p('every')} label="Every N" source={pick('every').source}>
              <NumberField
                invalid={!!p('every')}
                onChange={(v) => set('every', v)}
                placeholder="5"
                value={value('every')}
              />
            </FieldRow>
          )}
          <FieldRow label="Gate" source={pick('gate').source}>
            <Segmented
              label="Gate"
              onChange={(v) => set('gate', v)}
              options={[
                { value: 'none', label: 'none', title: 'Review every time' },
                {
                  value: 'jev',
                  label: 'jev',
                  title: 'A cheap classifier decides first (not for final answers)',
                },
              ]}
              value={value('gate')}
            />
          </FieldRow>
          <FieldRow label="Delivery" source={pick('delivery').source}>
            <Segmented
              label="Delivery"
              onChange={(v) => set('delivery', v)}
              options={[
                { value: 'note', label: 'note', title: 'The agent reads it with its next request' },
                { value: 'card', label: 'card', title: 'Only you see it; the agent never does' },
              ]}
              value={value('delivery')}
            />
          </FieldRow>
          {(['continueOn', 'steerOn'] as const).map((key) => (
            <FieldRow
              key={key}
              label={key === 'continueOn' ? 'Send back' : 'Steer'}
              source={ultimate ? 'fixed' : pick(key).source}
            >
              {ultimate ? (
                <span
                  className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
                  title="@ultimate is never held, continued or steered"
                >
                  <LockIcon className="size-3" />
                  off · never for @ultimate
                </span>
              ) : (
                <Segmented
                  label={key === 'continueOn' ? 'Send the answer back on' : 'Steer the run on'}
                  onChange={(v) => set(key, v)}
                  options={thresholds.map((t) => ({
                    value: t,
                    label: t === 'never' ? 'off' : t,
                    title:
                      t === 'never'
                        ? 'Never'
                        : `On a ${t} or worse${key === 'continueOn' ? ', once per run' : ''}`,
                  }))}
                  value={value(key)}
                />
              )}
            </FieldRow>
          ))}
          <FieldRow error={p('quietMs')} label="Quiet min" source={pick('quietMs').source}>
            <NumberField
              invalid={!!p('quietMs')}
              onChange={(v) => set('quietMs', v)}
              placeholder="10"
              scale={60_000}
              value={value('quietMs')}
            />
            <span className="ml-2 truncate text-[11px] text-muted-foreground/70">
              after your input, no interrupting
            </span>
          </FieldRow>
          {at.includes('idle') && (
            <FieldRow error={p('idleMs')} label="Idle min" source={pick('idleMs').source}>
              <NumberField
                invalid={!!p('idleMs')}
                onChange={(v) => set('idleMs', v)}
                placeholder="30"
                scale={60_000}
                value={value('idleMs')}
              />
            </FieldRow>
          )}
          <FieldRow error={p('dayUsd')} label="$ / day" source={pick('dayUsd').source}>
            <NumberField
              invalid={!!p('dayUsd')}
              onChange={(v) => set('dayUsd', v)}
              placeholder="global only"
              value={value('dayUsd')}
            />
          </FieldRow>
        </div>
      )}
    </div>
  )
}

function AdvisorRow({
  name,
  pick,
  set,
  problems,
}: {
  name: string
  pick: (key: keyof AdvisorSpec) => { value: unknown; source: Source }
  set: (key: keyof AdvisorSpec, value: unknown) => void
  problems: Record<string, string>
}) {
  const [open, setOpen] = useState(false)
  const p = (key: string) => problems[`advisors.${name}.${key}`]
  const failing = Object.keys(problems).some((key) => key.startsWith(`advisors.${name}`))
  const model = pick('model').value as string | undefined
  return (
    <div
      className={cn('-mx-1.5 rounded-md px-1.5', open && 'bg-muted/30 pb-2')}
      data-advisor-spec={name}
    >
      <button
        aria-expanded={open}
        className="flex min-h-7 w-full cursor-pointer items-center gap-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="shrink-0 font-mono text-[12px] text-foreground/90">{name}</span>
        {failing && <CircleAlertIcon className="size-3 shrink-0 text-error" />}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70">
          {model ?? 'global model'}
        </span>
        <ChevronRightIcon
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      {open && (
        <div className="space-y-0.5 pt-1 pl-3">
          <FieldRow error={p('model')} label="Model" source={pick('model').source}>
            <TextField
              invalid={!!p('model')}
              onChange={(v) => set('model', v || undefined)}
              placeholder="global model"
              value={(pick('model').source !== 'default' ? model : '') ?? ''}
            />
          </FieldRow>
          <FieldRow error={p('rubric')} label="Rubric" source={pick('rubric').source}>
            <TextField
              invalid={!!p('rubric')}
              onChange={(v) => set('rubric', v || undefined)}
              placeholder={name}
              value={(pick('rubric').value as string | undefined) ?? ''}
            />
          </FieldRow>
          <FieldRow
            error={p('maxToolCalls')}
            label="Tool calls"
            source={pick('maxToolCalls').source}
          >
            <NumberField
              invalid={!!p('maxToolCalls')}
              onChange={(v) => set('maxToolCalls', v)}
              placeholder="6"
              value={pick('maxToolCalls').value}
            />
            <span className="ml-2 text-[11px] text-muted-foreground/70">1–20</span>
          </FieldRow>
          <FieldRow error={p('maxNotes')} label="Notes" source={pick('maxNotes').source}>
            <NumberField
              invalid={!!p('maxNotes')}
              onChange={(v) => set('maxNotes', v)}
              placeholder="3"
              value={pick('maxNotes').value}
            />
            <span className="ml-2 text-[11px] text-muted-foreground/70">1–10, blockers exempt</span>
          </FieldRow>
        </div>
      )}
    </div>
  )
}

function NewAdvisor({ names, onAdd }: { names: string[]; onAdd: (name: string) => void }) {
  const [name, setName] = useState('')
  const problem =
    name && !NAME.test(name)
      ? 'lowercase letters, digits, hyphens'
      : names.includes(name)
        ? 'already in the roster'
        : undefined
  return (
    <form
      className="flex items-center gap-1.5 pt-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (!name || problem) return
        onAdd(name)
        setName('')
      }}
    >
      <input
        aria-invalid={!!problem || undefined}
        aria-label="New advisor name"
        className={cn(input, 'w-40 flex-none')}
        onChange={(event) => setName(event.target.value.trim())}
        placeholder="new-advisor"
        value={name}
      />
      <Button
        className="h-7 gap-1 px-2 text-[12px]"
        disabled={!name || !!problem}
        size="sm"
        type="submit"
        variant="ghost"
      >
        <PlusIcon className="size-3" />
        Add
      </Button>
      {problem && <span className="font-mono text-[11px] text-error">{problem}</span>}
    </form>
  )
}

/** Rubric files by name; editing writes the shown layer's copy, which wins over a built-in or user one. */
function Rubrics({
  view,
  scope,
  trusted,
  onSaved,
}: {
  view: ConfigView
  scope: Scope
  trusted: boolean
  onSaved: (view: ConfigView) => void
}) {
  const [editing, setEditing] = useState<{ name: string; text: string }>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const disabled = scope === 'project' && !trusted
  const write = async (name: string, text: string | null) => {
    setBusy(true)
    setError(undefined)
    try {
      onSaved(await api.action(SetRubricAction, { scope, name, text }))
      setEditing(undefined)
    } catch (failure) {
      setError(
        refusedForPairing(failure)
          ? 'Saving needs a paired browser.'
          : errorMessage(failure).replace(/^advisor\/setRubric: /, ''),
      )
    } finally {
      setBusy(false)
    }
  }
  const bytes = editing ? new TextEncoder().encode(editing.text).length : 0
  return (
    <Group meta={`edits go to ${scope}`} title="Rubrics">
      {view.rubrics.map((rubric) => (
        <div key={rubric.name}>
          <div className="flex min-h-7 items-center gap-2">
            <button
              className="shrink-0 cursor-pointer text-left font-mono text-[12px] text-foreground/90 hover:underline disabled:cursor-default disabled:no-underline"
              disabled={disabled}
              onClick={() =>
                setEditing(
                  editing?.name === rubric.name
                    ? undefined
                    : { name: rubric.name, text: rubric.text },
                )
              }
              type="button"
            >
              {rubric.name}
            </button>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
              {rubric.text
                .split('\n')
                .find((line) => line.trim())
                ?.replace(/^#+\s*/, '')}
            </span>
            <SourceTag source={rubric.source === 'builtin' ? 'default' : rubric.source} />
          </div>
          {editing?.name === rubric.name && (
            <div className="space-y-1.5 pb-2">
              <textarea
                aria-label={`Rubric ${rubric.name}`}
                className={cn(input, 'h-auto min-h-48 resize-y py-2 leading-relaxed')}
                onChange={(event) => setEditing({ name: rubric.name, text: event.target.value })}
                spellCheck={false}
                value={editing.text}
              />
              {error && (
                <p className="flex items-start gap-1.5 text-[12px] text-error" role="alert">
                  <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
                  {error}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    'font-mono text-[11px] text-muted-foreground/70',
                    bytes > 20_480 && 'text-error',
                  )}
                >
                  {(bytes / 1024).toFixed(1)} / 20 KB
                </span>
                <span className="ml-auto" />
                {rubric.source === scope && (
                  <Button
                    className="h-7 gap-1 px-2 text-[12px] text-muted-foreground"
                    disabled={busy}
                    onClick={() => void write(rubric.name, null)}
                    size="sm"
                    title={`Delete the ${scope} copy; the next layer's applies again`}
                    variant="ghost"
                  >
                    <Trash2Icon className="size-3" />
                    Delete
                  </Button>
                )}
                <Button
                  className="h-7 text-[12px]"
                  disabled={busy}
                  onClick={() => setEditing(undefined)}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  className="h-7 text-[12px]"
                  disabled={busy || bytes > 20_480 || editing.text === rubric.text}
                  onClick={() => void write(rubric.name, editing.text)}
                  size="sm"
                >
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </Group>
  )
}
