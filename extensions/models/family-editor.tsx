/**
 * Editing model families in place: a family's popover (model, thinking, color, the concurrency caps, removal), a new
 * family, and moving a feature to a family. Each saves this project's families at once through `SaveFamiliesAction`;
 * the Agents panel lists the families with who runs on each. An agent's family is its definition's, not saved here.
 */
import { ChevronsUpDownIcon, PlusIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, cn, errorMessage, useModels } from '@/sdk'
import {
  BUILTIN_FAMILIES,
  DEFAULT_FAMILY,
  FAMILY_COLORS,
  FEATURES,
  familyColor,
  familyTitle,
  isFamilyName,
} from '../../lib/families.ts'
import { refreshFamilies, runsOn } from './families.tsx'
import { ModelRow } from './picker.tsx'
import { SaveFamiliesAction } from './refs.ts'
import type { FamiliesView, FamilyLimits, FamilyView, SaveFamilies } from './refs.ts'

type Spec = SaveFamilies['families'][string]
const label = 'font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase'
const control =
  'h-7 w-full min-w-0 rounded-md border border-border/80 bg-background px-2 font-mono text-[11.5px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50'

const specOf = (family: FamilyView): Spec => ({
  ...(family.model ? { model: family.model } : {}),
  ...(family.thinking ? { thinking: family.thinking } : {}),
  color: family.color,
})

/** Save the families as `view` has them with `change` applied; feature assignments only, agents keep theirs in files. */
async function save(
  view: FamiliesView,
  change: Partial<Pick<SaveFamilies, 'families' | 'assign' | 'limits' | 'unpin' | 'switchRunning'>>,
) {
  const result = await api.action(SaveFamiliesAction, {
    families: Object.fromEntries(view.families.map((family) => [family.name, specOf(family)])),
    assign: Object.fromEntries(
      Object.entries(view.assign).filter(([id]) => Object.hasOwn(FEATURES, id)),
    ),
    limits: view.limits,
    unpin: [],
    ...change,
  })
  await refreshFamilies()
  return result
}

/** Run feature `id` (Summaries, Previews) on `family`; a pin in the user's settings gives way to it. */
export function moveFeature(view: FamiliesView, id: string, family: string) {
  const user = view.users.find((item) => item.id === id)
  return save(view, {
    assign: {
      ...Object.fromEntries(
        Object.entries(view.assign).filter(([key]) => Object.hasOwn(FEATURES, key)),
      ),
      [id]: family,
    },
    unpin: user?.pinnedIn?.startsWith('user') ? [id] : [],
  })
}

/**
 * A family's settings in a popover over `children`: model, thinking, color and caps as a draft, saved together.
 * When the change moves open conversations, a ticked box moves those still on the family's old model along.
 */
export function FamilyPopover({
  family,
  view,
  children,
}: {
  family: FamilyView
  view: FamiliesView
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        {open && <FamilyForm close={() => setOpen(false)} family={family} view={view} />}
      </PopoverContent>
    </Popover>
  )
}

function FamilyForm({
  family,
  view,
  close,
}: {
  family: FamilyView
  view: FamiliesView
  close: () => void
}) {
  const models = useModels()
  const initial = specOf(family)
  const [draft, setDraft] = useState(initial)
  const [limits, setLimits] = useState<FamilyLimits>(view.limits)
  const [switching, setSwitching] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const model = draft.model ?? family.follows
  const info = models?.models.find((item) => `${item.provider}/${item.id}` === model)
  const levels = info?.reasoning ? info.thinkingLevels : info ? ['off'] : []
  // A built-in level can be changed but not cleared: settings keep only what differs from it.
  const inherit = !BUILTIN_FAMILIES[family.name]?.thinking
  const builtin = Object.hasOwn(BUILTIN_FAMILIES, family.name)
  const shared = view.families.filter(
    (other) => other.name !== family.name && model && runsOn(other) === model,
  )
  const changed =
    JSON.stringify(draft) !== JSON.stringify(initial) ||
    JSON.stringify(limits) !== JSON.stringify(view.limits)
  const runs = draft.model !== initial.model || draft.thinking !== initial.thinking
  const affected = runs
    ? view.users.reduce(
        (sum, user) => (user.family === family.name ? sum + (view.open[user.id] ?? 0) : sum),
        family.name === DEFAULT_FAMILY ? (view.open[DEFAULT_FAMILY] ?? 0) : 0,
      )
    : 0
  const set = (change: Partial<Spec>) => {
    setDraft((previous) => ({ ...previous, ...change }))
    setError(undefined)
  }
  const families = (next?: Spec) => {
    const all = Object.fromEntries(view.families.map((item) => [item.name, specOf(item)]))
    if (next) all[family.name] = next
    else delete all[family.name]
    return all
  }
  async function apply(change: Parameters<typeof save>[1]) {
    setPending(true)
    setError(undefined)
    try {
      await save(view, change)
      close()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }
  const capOf = (ref: string | undefined) => (ref ? limits.models[ref] : undefined)
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12.5px] font-medium">{familyTitle(family.name)}</span>
        {family.project && (
          <span className={cn(label, 'tracking-normal normal-case')}>
            · the project's settings change it
          </span>
        )}
        <div className="ml-auto flex gap-1" role="radiogroup" aria-label="Color">
          {Object.keys(FAMILY_COLORS).map((name) => (
            <button
              aria-checked={name === draft.color}
              aria-label={name}
              className={cn(
                'size-3 rounded-full ring-offset-1 ring-offset-popover transition-transform hover:scale-125',
                name === draft.color && 'ring-1 ring-foreground/70',
              )}
              key={name}
              onClick={() => set({ color: name })}
              role="radio"
              style={{ backgroundColor: familyColor(name) }}
              title={name}
              type="button"
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className={label}>Model</div>
        <ModelSelect
          onChange={(next) => set({ model: next })}
          onClear={
            family.name === DEFAULT_FAMILY && draft.model && family.follows
              ? () => set({ model: undefined })
              : undefined
          }
          placeholder={family.follows ? `Pi's default · ${short(family.follows)}` : undefined}
          value={draft.model}
        />
        {model && (!info || !info.available) && (
          <p className="text-[11px] text-warning">
            {info ? `No ${info.provider} login: ` : 'Not in the model list: '}
            what runs on it takes the default model until there is one.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <div className={label}>Thinking</div>
        <select
          aria-label="Thinking"
          className={control}
          onChange={(event) =>
            set({
              thinking: event.target.value ? (event.target.value as Spec['thinking']) : undefined,
            })
          }
          value={draft.thinking ?? ''}
        >
          {inherit && (
            <option value="">
              {family.name === DEFAULT_FAMILY && family.followsThinking
                ? `Pi's default · ${family.followsThinking}`
                : 'inherit'}
            </option>
          )}
          {[...new Set([...levels, ...(draft.thinking ? [draft.thinking] : [])])].map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div
          className="flex flex-col gap-1"
          title="Requests over a cap wait for a free slot. The cap is the model's, so families on the same model share it."
        >
          <div className={label}>At most, at once</div>
          <LimitInput
            disabled={!model}
            label="This model's cap"
            onChange={(value) => {
              if (!model) return
              const { [model]: _old, ...rest } = limits.models
              setLimits({ ...limits, models: value ? { ...rest, [model]: value } : rest })
            }}
            value={capOf(model)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className={label}>All models</div>
          <LimitInput
            label="Overall cap"
            onChange={(global) => setLimits({ ...limits, global })}
            value={limits.global}
          />
        </div>
        {shared.length > 0 && (
          <p className="col-span-2 -mt-1 text-[11px] text-muted-foreground/80">
            {short(model!)} is shared with {shared.map((item) => familyTitle(item.name)).join(', ')}
          </p>
        )}
      </div>
      {changed && affected > 0 && (
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Checkbox checked={switching} onCheckedChange={(value) => setSwitching(value === true)} />
          also switch {affected} open conversation{affected === 1 ? '' : 's'}
        </label>
      )}
      {error && <p className="font-mono text-[11px] break-words text-error">{error}</p>}
      <div className="flex items-center gap-1 border-t border-border/70 pt-2.5">
        {!builtin && (
          <Button
            className="h-7 px-2 text-[12px] text-muted-foreground hover:text-error"
            disabled={pending}
            onClick={() => void apply({ families: families() })}
            size="sm"
            title="What runs on it goes back to the default family"
            variant="ghost"
          >
            Remove
          </Button>
        )}
        <Button className="ml-auto h-7 px-2 text-[12px]" onClick={close} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button
          className="h-7 px-3 text-[12px]"
          disabled={!changed || pending}
          onClick={() =>
            void apply({
              families: families(draft),
              limits,
              switchRunning: switching && affected > 0,
            })
          }
          size="sm"
        >
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

/** "+ Family": name a new family; it starts on no model of its own until its popover picks one. */
export function AddFamily({ view }: { view: FamiliesView }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const taken = view.families.map((family) => family.name)
  const problem = !name
    ? undefined
    : !isFamilyName(name)
      ? 'Lowercase letters, digits and - only'
      : taken.includes(name)
        ? 'There is a family of that name'
        : undefined
  async function add() {
    if (!name || problem) return
    const colors = Object.keys(FAMILY_COLORS)
    try {
      await save(view, {
        families: {
          ...Object.fromEntries(view.families.map((family) => [family.name, specOf(family)])),
          [name]: { color: colors[taken.length % colors.length] },
        },
      })
      setName('')
      setOpen(false)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className="h-5 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          size="xs"
          title="A new model family"
          variant="ghost"
        >
          <PlusIcon className="size-3" />
          Family
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 space-y-2 p-3">
        <div className={label}>New family</div>
        <input
          aria-invalid={problem ? true : undefined}
          aria-label="New family name"
          autoFocus
          className={control}
          onChange={(event) => {
            setName(event.target.value.trim().toLowerCase())
            setError(undefined)
          }}
          onKeyDown={(event) => {
            // oxlint-disable-next-line typescript/no-floating-promises -- add shows its own failure.
            if (event.key === 'Enter') void add()
          }}
          placeholder="local"
          spellCheck={false}
          value={name}
        />
        {(problem ?? error) && <p className="text-[11px] text-error">{problem ?? error}</p>}
        <Button
          className="h-7 w-full text-[12px]"
          disabled={!name || !!problem}
          onClick={() => void add()}
          size="sm"
          variant="outline"
        >
          Add family
        </Button>
      </PopoverContent>
    </Popover>
  )
}

const short = (ref: string) => ref.slice(ref.indexOf('/') + 1)

function LimitInput({
  value,
  label: name,
  disabled,
  onChange,
}: {
  value: number | undefined
  label: string
  disabled?: boolean
  onChange: (value: number | undefined) => void
}) {
  return (
    <input
      aria-label={name}
      className={cn(control, 'tabular-nums')}
      disabled={disabled}
      min={0}
      onChange={(event) => {
        const next = Number.parseInt(event.target.value, 10)
        onChange(Number.isFinite(next) && next > 0 ? next : undefined)
      }}
      placeholder="no limit"
      step={1}
      type="number"
      value={value ?? ''}
    />
  )
}

const LIMIT = 150

/** A searchable model choice, as the model picker lists them: logged-in ones until you type. */
function ModelSelect({
  value,
  placeholder = 'Pick a model',
  onChange,
  onClear,
}: {
  value: string | undefined
  placeholder?: string
  onChange: (value: string) => void
  /** Offered as the first row: go back to no model of its own. */
  onClear?: () => void
}) {
  const models = useModels()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const all = models?.models ?? []
    const found = terms.length
      ? all.filter((model) =>
          terms.every((term) =>
            `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(term),
          ),
        )
      : all.filter((model) => model.available || `${model.provider}/${model.id}` === value)
    return [
      ...Map.groupBy(
        found.toSorted((a, b) => Number(b.available) - Number(a.available)).slice(0, LIMIT),
        (model) => model.provider,
      ),
    ]
  }, [models, query, value])
  const choose = (next: () => void) => {
    next()
    setOpen(false)
    setQuery('')
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(control, 'flex items-center gap-1 text-left')}
          title={value}
          type="button"
        >
          {value ? (
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">
                {value.slice(0, value.indexOf('/') + 1)}
              </span>
              {short(value)}
            </span>
          ) : (
            <span className="min-w-0 truncate text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDownIcon className="ml-auto size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(34rem,90vw)] p-0">
        <Command
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:uppercase"
          shouldFilter={false}
          {...(value ? { defaultValue: value } : {})}
        >
          <CommandInput
            className="text-[13px]"
            onValueChange={setQuery}
            placeholder={`Search ${(models?.models.length ?? 0).toLocaleString()} models…`}
            value={query}
          />
          <CommandList className="max-h-[45vh]">
            <CommandEmpty className="py-6 text-center text-[12px] text-muted-foreground">
              No model matches.
            </CommandEmpty>
            {onClear && !query && (
              <CommandGroup heading="Default">
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left font-mono text-[12px] hover:bg-accent"
                  onClick={() => choose(onClear)}
                  type="button"
                >
                  <span className="w-3.5" />
                  {placeholder}
                </button>
              </CommandGroup>
            )}
            {groups.map(([provider, items]) => (
              <CommandGroup heading={provider} key={provider}>
                {items.map((model) => (
                  <ModelRow
                    current={`${model.provider}/${model.id}` === value}
                    key={`${model.provider}/${model.id}`}
                    model={model}
                    onSelect={() => choose(() => onChange(`${model.provider}/${model.id}`))}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <div className="border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
            {query ? 'all providers' : 'logged-in providers · type to search all'}
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
