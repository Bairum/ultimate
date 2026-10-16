import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleIcon,
  FolderCogIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  ReplaceIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { ComponentType, ReactNode, RefObject } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import {
  api,
  cn,
  elidePath,
  errorMessage,
  events,
  shortenPath,
  useCommands,
  useConversation,
  useModels,
  useStore,
  useSystem,
  useUltimate,
} from '@/sdk'
import type { Status } from './parts.tsx'

/**
 * The extensions the first run recommends, a few words each; `needs` names one that must be on with it, turned on
 * with it when it is not in the list itself.
 */
const recommended: readonly { name: string; line: string; needs?: string }[] = [
  { name: 'subagents', line: 'Hands bounded work to helper agents' },
  { name: 'plan', line: 'Durable epics and tasks for long work' },
  { name: 'automations', line: 'Prompts that run on a schedule', needs: 'subagents' },
  { name: 'documents', line: 'Extension state in the right panel' },
  { name: 'tasks', line: 'What runs right now, live' },
  { name: 'info', line: 'Machine, code, and extensions at a glance' },
  { name: 'parallel', line: 'Web search and fetch (parallel.ai)', needs: 'secrets' },
]

/**
 * One page over the surface: modal for focus, closed with Escape or its close button but not by a stray click
 * outside. It opens with focus on `focus`; `onClosed` runs once it has gone, to move focus.
 */
function Page({
  open,
  onClose,
  onClosed,
  focus,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  onClosed: () => void
  focus: RefObject<HTMLElement | null>
  className?: string
  children: ReactNode
}) {
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      open={open}
    >
      <DialogContent
        className={cn(
          'flex max-h-[min(48rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl',
          className,
        )}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onClosed()
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focus.current?.focus({ preventScroll: true })
        }}
        showCloseButton={false}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}

function Close({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      className="-mr-2 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      title={label}
      type="button"
    >
      <Kbd>Esc</Kbd>
      <XIcon className="size-4" />
    </button>
  )
}

/** The wordmark, the page's title and its one sentence. */
function Header({
  title,
  description,
  onClose,
}: {
  title: string
  description: string
  onClose: () => void
}) {
  return (
    <header className="shrink-0 px-5 pt-5 sm:px-7 sm:pt-6">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[12px] font-semibold tracking-[0.3em] text-brand">
          ULTIMATE
        </span>
        <Close label="Skip setup" onClick={onClose} />
      </div>
      <DialogTitle className="mt-5 text-[22px] font-semibold tracking-tight text-foreground">
        {title}
      </DialogTitle>
      <DialogDescription className="mt-1.5 text-[14px] text-muted-foreground">
        {description}
      </DialogDescription>
    </header>
  )
}

/** Which of the two pages shows: two short bars, the current one in the brand colour. */
function Progress({ page }: { page: 1 | 2 }) {
  return (
    <span aria-label={`Step ${page} of 2`} className="flex items-center gap-1.5" role="img">
      {[1, 2].map((step) => (
        <span
          className={cn('h-1 w-4 rounded-full', step === page ? 'bg-brand' : 'bg-border')}
          key={step}
        />
      ))}
    </span>
  )
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <footer className="flex shrink-0 items-center gap-2 border-t border-border/70 bg-sidebar px-5 py-3 sm:px-7">
      {children}
    </footer>
  )
}

/** One checklist row: whether it is done, what it is, its state in one line, and its action. */
function Step({
  done,
  checking,
  title,
  state,
  children,
}: {
  done: boolean
  checking: boolean
  title: string
  state: ReactNode
  children?: ReactNode
}) {
  const Icon: ComponentType<{ className?: string }> = checking
    ? LoaderCircleIcon
    : done
      ? CircleCheckIcon
      : CircleIcon
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Icon
        className={cn(
          'size-5 shrink-0',
          checking && 'animate-spin text-muted-foreground',
          !checking && (done ? 'text-success' : 'text-muted-foreground/50'),
        )}
      />
      <span className="sr-only">{checking ? 'Checking: ' : done ? 'Done: ' : 'To do: '}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">{state}</p>
      </div>
      {children}
    </li>
  )
}

/**
 * Page 1: the two things Ultimate needs, checked live: a logged-in provider (through the `models` login) and an
 * available model for the conversation (through its picker). Continue waits for both.
 */
function GetReady({
  primary,
  onContinue,
  onSkip,
}: {
  primary: RefObject<HTMLButtonElement | null>
  onContinue: () => void
  onSkip: () => void
}) {
  const models = useModels()
  const { agent, loading } = useConversation()
  const commands = useCommands()
  const ui = useUltimate()
  const has = (id: string) => commands.some((command) => command.id === id)
  // The faux demo provider (`ULTIMATE_FAUX=1`) is always there and is no login; it counts only while its model is
  // the conversation's.
  const connected =
    models?.providers.filter((provider) => provider.status.configured && provider.id !== 'faux') ??
    []
  const ref = agent.model
  const model = models?.models.find(
    (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
  )
  const thinking =
    model?.reasoning && agent.thinkingLevel !== 'off' ? agent.thinkingLevel : undefined
  const demo = model?.available === true && model.provider === 'faux'
  const done = { provider: connected.length > 0 || demo, model: model?.available === true }
  const next = !done.provider ? 'provider' : !done.model ? 'model' : 'continue'
  // Focus goes to the next thing to do when the login or the picker closes (they return it to no trigger), and when
  // a step gets done while focus is on this page.
  const body = useRef<HTMLDivElement>(null)
  const covered = useStore((state) => Object.values(state.ui.dialogs).some(Boolean))
  const was = useRef({ covered, next })
  useEffect(() => {
    const before = was.current
    was.current = { covered, next }
    if (covered) return
    const active = document.activeElement
    const here = !active || active === document.body || body.current?.contains(active)
    if (!before.covered && (before.next === next || !here)) return
    // After the closing dialog has let go of focus.
    setTimeout(() => primary.current?.focus())
  }, [covered, next, primary])
  const action = (step: 'provider' | 'model', label: string, command: string) =>
    has(command) ? (
      <Button
        onClick={() => ui.runCommand(command)}
        ref={next === step ? primary : undefined}
        size="sm"
        variant={next === step ? 'default' : 'outline'}
      >
        {label}
      </Button>
    ) : undefined
  return (
    <div className="contents" ref={body}>
      <Header
        description="Two steps and Ultimate can start working in this folder."
        onClose={onSkip}
        title="Get ready"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-6 sm:px-7">
        {/* Live, so a finished login or a chosen model is announced. */}
        <ul
          aria-live="polite"
          className="divide-y divide-border/70 rounded-lg border border-border/70 bg-card"
        >
          <Step
            checking={!models}
            done={done.provider}
            state={
              !models
                ? 'Checking…'
                : connected.length > 0
                  ? `Connected · ${connected.map((provider) => provider.name).join(', ')}`
                  : demo
                    ? 'Demo provider · faux'
                    : has('auth.login')
                      ? 'A subscription or API key, shared with Pi'
                      : 'Turn on models to log in here'
            }
            title="Connect a model provider"
          >
            {action('provider', connected.length > 0 ? 'Manage' : 'Connect', 'auth.login')}
          </Step>
          <Step
            checking={!models || loading}
            done={done.model}
            state={
              !models || loading ? (
                'Checking…'
              ) : !ref ? (
                'No model chosen yet'
              ) : (
                <>
                  <span className="font-mono text-[12px] text-foreground/85">{ref.modelId}</span>
                  {done.model ? (thinking ? ` · ${thinking}` : '') : ' · needs its provider'}
                </>
              )
            }
            title="Choose a model"
          >
            {action('model', done.model ? 'Change' : 'Choose', 'model.pick')}
          </Step>
        </ul>
      </div>
      <Footer>
        <Progress page={1} />
        <Button
          className="ml-auto"
          disabled={next !== 'continue'}
          onClick={onContinue}
          ref={next === 'continue' ? primary : undefined}
          size="sm"
        >
          Continue
          <ArrowRightIcon />
        </Button>
      </Footer>
    </div>
  )
}

/** A small monospace tag; `tone` marks a project's own folder (brand) or one in place of a built-in (warning). */
function Chip({
  children,
  icon: Icon,
  tone,
  title,
  className,
}: {
  children: ReactNode
  icon?: ComponentType<{ className?: string }>
  tone?: 'brand' | 'warning'
  title?: string
  className?: string
}) {
  return (
    <li
      className={cn(
        'inline-flex h-[22px] items-center gap-1 rounded-sm border px-1.5 font-mono text-[11px]',
        tone === 'warning'
          ? 'border-warning/40 bg-warning/8 text-warning'
          : tone === 'brand'
            ? 'border-brand/30 text-brand'
            : 'border-border/80 text-foreground/80',
        className,
      )}
      title={title}
    >
      {Icon && <Icon className="size-3 shrink-0" />}
      {children}
    </li>
  )
}

/**
 * What a project's setup brings, as chips: folders that replace a built-in, its own extensions, the built-ins its
 * settings turn on and off, its agents, and its skills.
 */
function SetupChips({ adds }: { adds?: Status['adds'] }) {
  if (!adds) return <div className="h-[22px]" />
  const own = adds.extensions
  const builtins = adds.enable.filter(
    (name) => !own.includes(name) && !adds.replaces.includes(name),
  )
  const empty =
    [own, builtins, adds.replaces, adds.disable, adds.agents, adds.skills].flat().length === 0
  return (
    <ul aria-label="What it brings" className="flex flex-wrap gap-1.5">
      {adds.replaces.map((name) => (
        <Chip
          icon={ReplaceIcon}
          key={`replaces:${name}`}
          title={`Its own ${name} runs in place of the built-in`}
          tone="warning"
        >
          {name}
          <span className="font-sans text-[10.5px] opacity-80">replaces built-in</span>
        </Chip>
      ))}
      {own.map((name) => (
        <Chip key={`own:${name}`} title="Its own extension" tone="brand">
          {name}
        </Chip>
      ))}
      {builtins.map((name) => (
        <Chip key={`on:${name}`} title="A built-in it turns on">
          {name}
        </Chip>
      ))}
      {adds.disable.map((name) => (
        <Chip
          className="text-muted-foreground line-through"
          key={`off:${name}`}
          title="A built-in it turns off"
        >
          {name}
        </Chip>
      ))}
      {adds.agents.map((name) => (
        <Chip icon={BotIcon} key={`agent:${name}`} title="Agent">
          <span className="sr-only">agent </span>
          {name}
        </Chip>
      ))}
      {adds.skills.map((name) => (
        <Chip icon={SparklesIcon} key={`skill:${name}`} title="Skill">
          <span className="sr-only">skill </span>
          {name}
        </Chip>
      ))}
      {empty && <Chip className="text-muted-foreground">settings only</Chip>}
    </ul>
  )
}

/** The project's `.ultimate/README.md`, behind a disclosure. */
function WhatsInIt({ readme }: { readme?: string }) {
  if (!readme) return null
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm text-[12.5px] text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        What's in it
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          aria-label="This project's README"
          className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border/70 bg-background px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="region"
          tabIndex={0}
        >
          <MessageResponse className="text-[13px] leading-relaxed">{readme}</MessageResponse>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function FolderPath() {
  const system = useSystem()
  if (!system) return null
  const path = shortenPath(system.project.root, { home: system.machine.home })
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
      <FolderCogIcon className="size-3.5 shrink-0 text-brand" />
      <span className="truncate" title={path}>
        {elidePath(path, 64)}
      </span>
    </span>
  )
}

/** A row's short note: what it needs, or that the project's setup decides it. */
function Hint({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('shrink-0 font-mono text-[10.5px] text-muted-foreground/70', className)}>
      {text}
    </span>
  )
}

/** One recommended extension; `locked`, the project's setup's state for it, shows in place of the user's choice. */
function Choice({
  entry,
  checked,
  locked,
  onChange,
}: {
  entry: (typeof recommended)[number]
  checked: boolean
  locked?: boolean
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  const hint =
    locked === undefined
      ? entry.needs && `needs ${entry.needs}`
      : `${locked ? 'on' : 'off'} in this project`
  return (
    <li>
      <label
        className={cn(
          'flex items-center gap-3 px-4 py-2.5 transition-colors',
          locked === undefined ? 'cursor-pointer hover:bg-accent/40' : 'cursor-default',
        )}
        id={id}
      >
        <Checkbox
          checked={locked ?? checked}
          disabled={locked !== undefined}
          aria-labelledby={id}
          onCheckedChange={(next) => onChange(next === true)}
        />
        {/* Narrow, the line goes under the name. */}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
          <span className="flex shrink-0 items-baseline gap-2 sm:w-24">
            <span className="font-mono text-[12.5px] text-foreground/90">{entry.name}</span>
            {hint && <Hint className="sm:hidden" text={hint} />}
          </span>
          <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">{entry.line}</span>
        </span>
        {hint && <Hint className="hidden sm:inline" text={hint} />}
      </label>
    </li>
  )
}

/**
 * Page 2: the recommended extensions as checkboxes and, for a folder with an undecided setup, whether to use it. While
 * it is in use, the rows its settings decide show its choice, locked; the user's own stays underneath.
 */
function Recommended({
  adds,
  askProject,
  checked,
  onCheck,
  local,
  onLocal,
  busy,
  error,
  primary,
  onBack,
  onSkip,
  onApply,
}: {
  adds?: Status['adds']
  askProject: boolean
  checked: Record<string, boolean>
  onCheck: (name: string, checked: boolean) => void
  local: boolean
  onLocal: (local: boolean) => void
  busy: boolean
  error?: string
  primary: RefObject<HTMLButtonElement | null>
  onBack: () => void
  onSkip: () => void
  onApply: () => void
}) {
  const system = useSystem()
  const locked = (name: string) => {
    if (!askProject || !local || !adds) return undefined
    if (adds.disable.includes(name)) return false
    if ([adds.enable, adds.extensions, adds.replaces].some((names) => names.includes(name)))
      return true
    return undefined
  }
  return (
    <>
      <Header
        description="Turn on what you want; change it any time under Extensions."
        onClose={onSkip}
        title="Recommended extensions"
      />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-5 pb-6 sm:px-7">
        <ul className="divide-y divide-border/70 rounded-lg border border-border/70 bg-card">
          {recommended.map((entry) => (
            <Choice
              checked={checked[entry.name] ?? false}
              entry={entry}
              key={entry.name}
              locked={locked(entry.name)}
              onChange={(on) => onCheck(entry.name, on)}
            />
          ))}
        </ul>
        {askProject && system && (
          <section
            aria-label="This folder"
            className="flex flex-col gap-3 rounded-lg border border-border/70 bg-card px-4 py-3"
          >
            <label className="flex cursor-pointer items-start gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13.5px] font-medium text-foreground">
                  Use this project's setup
                </span>
                <span className="text-[12px] text-muted-foreground">
                  Runs its extensions on this machine
                </span>
              </span>
              <Switch
                aria-label="Use this project's setup"
                checked={local}
                onCheckedChange={onLocal}
              />
            </label>
            <SetupChips adds={adds} />
            <WhatsInIt readme={system.project.readme} />
          </section>
        )}
      </div>
      <Footer>
        <Progress page={2} />
        {error && (
          <span className="min-w-0 flex-1 truncate text-[12px] text-error" title={error}>
            {error}
          </span>
        )}
        <Button className="ml-auto" disabled={busy} onClick={onBack} size="sm" variant="ghost">
          <ArrowLeftIcon />
          Back
        </Button>
        <Button disabled={busy} onClick={onSkip} size="sm" variant="ghost">
          Skip
        </Button>
        <Button disabled={busy} onClick={onApply} ref={primary} size="sm">
          {busy && <LoaderCircleIcon className="animate-spin" />}
          Continue
          {!busy && <ArrowRightIcon />}
        </Button>
      </Footer>
    </>
  )
}

/**
 * The first run, two pages in one dialog: what Ultimate needs (page 1), then the recommended extensions (page 2).
 * Continue on page 2 applies its choices at once with `applyFirstRun`. `onDone` reports whether it was skipped, by
 * Escape, the close button, or Skip; none of them interrupts Continue.
 */
export function FirstRun({
  open,
  status,
  askProject,
  onDone,
  onClosed,
}: {
  open: boolean
  status?: Status
  /** The folder has a setup and no decision yet: page 2 asks whether to use it. */
  askProject: boolean
  onDone: (skipped: boolean) => void
  onClosed: () => void
}) {
  const system = useSystem()
  const commands = useCommands()
  const [page, setPage] = useState<1 | 2>(1)
  // Page 2's choices live here, so Back keeps them: the checkboxes the user changed, and the project toggle, on to
  // start with only in Ultimate's own clone.
  const [changed, setChanged] = useState<Record<string, boolean>>({})
  const [local, setLocal] = useState(
    () => system !== undefined && system.project.root === system.code.ultimateRoot,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // Each starts checked unless the user's settings turn it off.
  const checked = Object.fromEntries(
    recommended.map(({ name }) => [name, changed[name] ?? !status?.user.disable.includes(name)]),
  )
  const check = (name: string, on: boolean) => {
    const next = { ...checked, [name]: on }
    for (const entry of recommended) {
      if (on && entry.name === name && entry.needs) next[entry.needs] = true
      if (!on && entry.needs === name) next[entry.name] = false
    }
    setChanged(next)
  }
  // The question stays while its answer applies, after which the folder is no longer undecided.
  const asking = askProject || busy
  // With web search on, its key comes next: once the page has gone and the Secrets panel has loaded, it opens at
  // PARALLEL_API_KEY if that is declared (parallel runs, which the project's setup may prevent) and missing.
  const [handoff, setHandoff] = useState<'applied' | 'closed'>()
  const secrets = commands.some((command) => command.id === 'secrets.panel')
  useEffect(() => {
    if (handoff !== 'closed' || !secrets) return
    setHandoff(undefined)
    void api
      .action('secrets', 'list')
      .then((list) => {
        const key = (list as { name: string; set: boolean }[]).find(
          (secret) => secret.name === 'PARALLEL_API_KEY',
        )
        if (key && !key.set) events.emit('secrets:open', { name: 'PARALLEL_API_KEY' })
      })
      .catch(() => {
        // Opening the optional key dialog is a convenience; onboarding remains usable without it.
      })
  }, [handoff, secrets])
  const apply = async () => {
    setBusy(true)
    setError(undefined)
    const extensions: Record<string, boolean> = { ...checked }
    for (const entry of recommended)
      if (entry.needs && checked[entry.name] && !(entry.needs in checked))
        extensions[entry.needs] = true
    try {
      await api.action('onboarding', 'applyFirstRun', {
        extensions,
        ...(askProject ? { local } : {}),
      })
      if (checked.parallel) setHandoff('applied')
      onDone(false)
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  // The page's next thing to do: the step to finish, or Continue.
  const primary = useRef<HTMLButtonElement>(null)
  const shown = useRef(page)
  useEffect(() => {
    if (shown.current === page) return
    shown.current = page
    primary.current?.focus()
  }, [page])
  const skip = () => {
    if (!busy) onDone(true)
  }
  return (
    <Page
      focus={primary}
      onClose={skip}
      onClosed={() => {
        onClosed()
        setHandoff((step) => step && 'closed')
      }}
      open={open}
    >
      {page === 1 ? (
        <GetReady onContinue={() => setPage(2)} onSkip={skip} primary={primary} />
      ) : (
        <Recommended
          adds={status?.adds}
          askProject={asking}
          busy={busy}
          checked={checked}
          error={error}
          local={local}
          onApply={() => void apply()}
          onBack={() => setPage(1)}
          onCheck={check}
          onLocal={setLocal}
          onSkip={skip}
          primary={primary}
        />
      )}
    </Page>
  )
}

/**
 * The project question outside the first run: one compact card with what the folder's setup brings and its README
 * behind a disclosure. Closing it without a choice keeps the global setup; the Extensions panel can choose later.
 */
export function ProjectCard({
  open,
  adds,
  onClose,
  onClosed,
}: {
  open: boolean
  adds?: Status['adds']
  onClose: () => void
  onClosed: () => void
}) {
  const system = useSystem()
  // A neutral place to start, so a stray Enter chooses nothing.
  const focus = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<boolean>()
  const [error, setError] = useState<string>()
  if (!system) return null
  const { project } = system
  const decide = async (local: boolean) => {
    if (project.decision === local) return onClose()
    setBusy(local)
    setError(undefined)
    try {
      await api.action('onboarding', 'decide', { local })
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(undefined)
    }
  }
  const choice = (local: boolean) =>
    busy === local ? (
      <LoaderCircleIcon className="animate-spin" />
    ) : (
      project.decision === local && <CheckIcon />
    )
  return (
    <Page className="sm:max-w-md" focus={focus} onClose={onClose} onClosed={onClosed} open={open}>
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pt-4 pb-5 outline-none"
        ref={focus}
        tabIndex={-1}
      >
        <div className="flex items-center gap-3">
          <FolderPath />
          <span className="ml-auto">
            <Close label="Decide later" onClick={onClose} />
          </span>
        </div>
        <DialogTitle className="text-[17px] font-semibold tracking-tight text-foreground">
          Use this project's setup?
        </DialogTitle>
        <DialogDescription className="-mt-2 text-[12.5px] text-muted-foreground">
          Runs its extensions on this machine
        </DialogDescription>
        <SetupChips adds={adds} />
        <WhatsInIt readme={project.readme} />
      </div>
      <Footer>
        {error && (
          <span className="min-w-0 flex-1 truncate text-[12px] text-error" title={error}>
            {error}
          </span>
        )}
        <Button
          className="ml-auto"
          disabled={busy !== undefined}
          onClick={() => void decide(false)}
          size="sm"
          title="Keep your global setup"
          variant="outline"
        >
          {choice(false)}
          Keep global
        </Button>
        <Button disabled={busy !== undefined} onClick={() => void decide(true)} size="sm">
          {choice(true)}
          Use it
        </Button>
      </Footer>
    </Page>
  )
}

/** What `workspaces` `isolation` reports for the project: why it cannot be isolated yet, and whether it is empty. */
export interface Isolation {
  reason?: string
  empty?: boolean
}

const situation: Record<string, string> = {
  'Isolation needs a Git repository': "This folder isn't a Git repository yet.",
  'Isolation needs a first commit': 'This repository has no commits yet.',
  'Isolation needs a checked-out branch': 'No branch is checked out here.',
}

/** The request the agent gets when the folder already holds files, so what the first commit holds is a judgement. */
const request = (reason: string) =>
  `Set up Git for this project so Ultimate can give each conversation its own checkout. Ultimate reports: "${reason}". Make it a Git repository with a checked-out branch if it is not one yet, and make the first commit of the files here: first write a .gitignore that fits the project, and leave out secrets (.env and the like), dependencies, build output and other generated or large files. Do not add a remote or push. Then tell me what the commit holds and what you left out.`

/**
 * The Git question: why conversations share this folder, and one step to change it. An empty folder gets `git init` and
 * an empty first commit at once; a folder with files gets an agent that chooses what its first commit holds.
 */
export function GitCard({
  open,
  isolation,
  onClose,
  onClosed,
}: {
  open: boolean
  isolation?: Isolation
  onClose: () => void
  onClosed: () => void
}) {
  const ui = useUltimate()
  const shown = useConversation((conversation) => conversation.id)
  const focus = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const reason = isolation?.reason
  const setUp = async () => {
    setBusy(true)
    setError(undefined)
    try {
      if (isolation?.empty) await api.action('workspaces', 'setupGit')
      else {
        const id = shown ?? 1
        await api.submit(request(reason ?? ''), 'followUp', id)
        ui.switchConversation(id)
      }
      events.emit('onboarding:git', null)
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Page className="sm:max-w-md" focus={focus} onClose={onClose} onClosed={onClosed} open={open}>
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pt-4 pb-5 outline-none"
        ref={focus}
        tabIndex={-1}
      >
        <div className="flex items-center gap-3">
          <FolderPath />
          <span className="ml-auto">
            <Close label="Not now" onClick={onClose} />
          </span>
        </div>
        <DialogTitle className="text-[17px] font-semibold tracking-tight text-foreground">
          Set up Git for this folder?
        </DialogTitle>
        <DialogDescription className="-mt-2 text-[12.5px] text-muted-foreground">
          {(reason && situation[reason]) ?? reason}
        </DialogDescription>
        <p className="text-[13px] leading-relaxed text-foreground/90">
          With Git, each conversation gets its own checkout, and finished work lands on your branch
          through the lander, which runs your checks first. Until then, conversations share this
          folder.
        </p>
        <p className="flex items-start gap-2 rounded-md border border-border/70 bg-sidebar px-3 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
          <GitBranchIcon className="mt-0.5 size-3.5 shrink-0 text-brand" />
          {isolation?.empty
            ? 'The folder is empty, so Ultimate runs git init and makes an empty first commit.'
            : 'The folder has files, so the agent chooses what the first commit holds: a .gitignore for the project, without secrets, dependencies or build output. It adds no remote and pushes nothing.'}
        </p>
      </div>
      <Footer>
        {error && (
          <span className="min-w-0 flex-1 truncate text-[12px] text-error" title={error}>
            {error}
          </span>
        )}
        <Button
          className="ml-auto"
          disabled={busy}
          onClick={onClose}
          size="sm"
          title="Keep sharing this folder"
          variant="outline"
        >
          Not now
        </Button>
        <Button disabled={busy || !reason} onClick={() => void setUp()} size="sm">
          {busy && <LoaderCircleIcon className="animate-spin" />}
          {isolation?.empty ? 'Set up Git' : 'Ask the agent'}
        </Button>
      </Footer>
    </Page>
  )
}
