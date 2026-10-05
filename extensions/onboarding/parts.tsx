import { CheckIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ReactNode, Ref } from 'react'
import { cn, useAction, useSystem } from '@/sdk'
import type { ExtensionInfo, SystemInfo } from '@/sdk'

/**
 * What the `status` action returns: first-run state, and what the project's setup brings, read even while undecided:
 * its own agents, skills, and extension folders, the folders that replace a built-in of the same name, and the names
 * its settings turn on and off.
 */
export interface Status {
  firstRun: boolean
  adds: {
    agents: string[]
    skills: string[]
    extensions: string[]
    replaces: string[]
    enable: string[]
    disable: string[]
  }
}
/** One entry of the `extensions` action: the first sentence of its README is the line the UI shows. */
interface Described {
  name: string
  source: ExtensionInfo['source']
  readme: string
  /** A project folder named like a built-in: with the project's setup it runs instead. */
  replaces?: 'builtin'
}

/** The dialog id of the project page; the Extensions panel opens it again. */
export const projectDialog = 'onboarding.project'

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const sources: Record<ExtensionInfo['source'], string> = {
  builtin: 'built-in',
  user: 'yours',
  project: 'this project',
}

/**
 * Each extension's line by name, and whether a project folder replaces a built-in of that name; read when mounted and
 * again when the set of extension folders changes.
 */
export function useDescribed() {
  const system = useSystem()
  const described = useAction<Described[]>('onboarding', 'extensions')
  const folders = system?.extensions.map((extension) => extension.path).join('\n')
  const seen = useRef(folders)
  const { refetch } = described
  useEffect(() => {
    if (folders === seen.current) return
    seen.current = folders
    void refetch()
  }, [folders, refetch])
  const entry = (name: string) => described.data?.find((candidate) => candidate.name === name)
  return {
    /** With `source`, the line of that folder: a built-in a project folder replaces has its own. */
    line: (name: string, source?: ExtensionInfo['source']) => {
      const known = entry(name)
      if (known && (!source || known.source === source)) return known.readme
      const readme = system?.extensions.find((extension) => extension.name === name)?.readme
      return readme && !readme.startsWith('#') ? readme : ''
    },
    replaces: (name: string) => entry(name)?.replaces === 'builtin',
  }
}

/** The names a project's `.ultimate/settings.json` enables and disables. */
export function projectLists(system: SystemInfo) {
  const extensions = system.project.settings.extensions
  const names = (key: string) => {
    const value =
      extensions && typeof extensions === 'object' && !Array.isArray(extensions)
        ? extensions[key]
        : undefined
    return Array.isArray(value)
      ? value.filter((name): name is string => typeof name === 'string')
      : []
  }
  return { enable: names('enable'), disable: names('disable') }
}

/** A README line with its `code` spans set in monospace. */
export function Line({ text, className }: { text: string; className?: string }) {
  if (!text) return null
  return (
    <span className={className} title={text.replaceAll('`', '')}>
      {text.split('`').map((part, index) =>
        index % 2 ? (
          <code className="font-mono text-[0.92em] text-foreground/75" key={index}>
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </span>
  )
}

/** A small uppercase heading with a meta value on the right, as in the Agents and Info panels. */
export function Heading({
  children,
  meta,
  className,
}: {
  children: ReactNode
  meta?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase',
        className,
      )}
    >
      {children}
      {meta !== undefined && (
        <span className="ml-auto truncate pl-2 tracking-normal normal-case text-muted-foreground/70">
          {meta}
        </span>
      )}
    </div>
  )
}

/** An on/off switch. While `busy` it ignores presses but keeps focus, which a disabled button would drop. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  busy,
  title,
  ref,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  busy?: boolean
  title?: string
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      aria-busy={busy || undefined}
      aria-checked={checked}
      aria-label={label}
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-brand' : 'bg-input',
        busy && 'animate-pulse cursor-progress',
      )}
      disabled={disabled}
      onClick={() => !busy && onChange(!checked)}
      ref={ref}
      role="switch"
      title={title}
      type="button"
    >
      <span
        className={cn(
          'block size-3 rounded-full shadow-sm transition-transform',
          checked
            ? 'translate-x-3.5 bg-brand-foreground'
            : 'translate-x-0.5 bg-muted-foreground/80',
        )}
      />
    </button>
  )
}

/** Two or three exclusive choices as one control; `value` null selects none. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T | null
  options: readonly { value: T; label: ReactNode; disabled?: boolean; title?: string }[]
  onChange: (value: T) => void
  label: string
  className?: string
}) {
  return (
    <div
      aria-label={label}
      className={cn(
        'inline-flex rounded-md border border-border/80 bg-background p-0.5 font-mono text-[11px]',
        className,
      )}
      role="group"
    >
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={cn(
            'flex h-6 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2 whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground',
            option.value === value && 'bg-accent text-foreground shadow-xs',
          )}
          disabled={option.disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** A checkbox in the brand colour; inside a `<label>`, the whole row toggles it. */
export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'border-brand bg-brand text-brand-foreground' : 'border-input bg-background',
      )}
      onClick={() => onChange(!checked)}
      role="checkbox"
      type="button"
    >
      {checked && <CheckIcon className="size-3" strokeWidth={3} />}
    </button>
  )
}
