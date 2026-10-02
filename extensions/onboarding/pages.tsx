import {
  ArrowRightIcon,
  BlocksIcon,
  CheckIcon,
  FolderCogIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  XIcon,
} from 'lucide-react'
import { Fragment, useRef, useState } from 'react'
import type { ComponentType, ReactNode, RefObject } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  api,
  cn,
  formatKeys,
  shortenPath,
  useCommands,
  useConversation,
  useModels,
  useSystem,
  useUltimate,
} from '@/sdk'
import type { SystemInfo } from '@/sdk'
import { Heading, Line, message, projectLists, useLines } from './parts.tsx'
import type { Status } from './parts.tsx'

/**
 * One page over the surface: modal for focus, closed with Escape or its close button but not by a stray click
 * outside. `onClosed` runs once it has gone, to move focus.
 */
function Page({
  open,
  onClose,
  onClosed,
  focus,
  wide,
  children,
}: {
  open: boolean
  onClose: () => void
  onClosed: () => void
  focus: RefObject<HTMLElement | null>
  wide?: boolean
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
          'flex max-h-[min(56rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl',
          wide && 'lg:max-w-5xl',
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

function Keys({ keys }: { keys: string }) {
  return (
    <KbdGroup>
      {formatKeys(keys)[0]?.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </KbdGroup>
  )
}

const code = 'font-mono text-[0.92em] text-foreground/80'

/** Login state: the Pi login flow of `models` when no provider is configured, otherwise the current model. */
function Login() {
  const models = useModels()
  const { agent } = useConversation()
  const commands = useCommands()
  const ui = useUltimate()
  const has = (id: string) => commands.some((command) => command.id === id)
  const model = agent.model && `${agent.model.provider}/${agent.model.modelId}`
  // The faux demo provider (`ULTIMATE_FAUX=1`) is always there and is no login.
  const configured =
    models?.providers.filter((provider) => provider.status.configured && provider.id !== 'faux') ??
    []
  if (!models) return <div className="h-[4.25rem] rounded-lg border border-border/70 bg-card" />
  if (configured.length > 0)
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-card px-4 py-3">
        <CheckIcon className="size-4 shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-foreground/90">
            Logged in to {configured.map((provider) => provider.name).join(', ')}
          </p>
          <p className="truncate font-mono text-[11.5px] text-muted-foreground">
            {model ? (
              <>
                model <span className="text-foreground/80">{model}</span>
                {agent.thinkingLevel &&
                  agent.thinkingLevel !== 'off' &&
                  ` · ${agent.thinkingLevel}`}
              </>
            ) : (
              <span className="text-warning">no model chosen yet</span>
            )}
          </p>
        </div>
        {has('model.pick') && (
          <Button onClick={() => ui.runCommand('model.pick')} size="xs" variant="outline">
            Change model
          </Button>
        )}
      </div>
    )
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-brand/30 bg-brand/5 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">Log in to a model provider</p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            A subscription or an API key, through Pi; the login is shared with Pi in{' '}
            <code className={code}>~/.pi/agent</code>.
            {model && (
              <>
                {' '}
                For now it runs on <code className={code}>{model}</code>.
              </>
            )}
          </p>
        </div>
      </div>
      {has('auth.login') ? (
        <Button
          className="self-end sm:self-auto"
          onClick={() => ui.runCommand('auth.login')}
          size="sm"
        >
          Log in…
        </Button>
      ) : (
        <p className="text-[12px] text-muted-foreground sm:max-w-44">
          Turn on <code className={code}>models</code> in the Extensions panel to log in here.
        </p>
      )}
    </div>
  )
}

function Card({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border border-border/70 px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <Icon className="size-4 text-muted-foreground" />
        {title}
      </div>
      <div className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{children}</div>
    </div>
  )
}

/** What is on: the default set with its lines, then what settings or folders added on top, by name. */
function OnNow({ system }: { system: SystemInfo }) {
  const line = useLines()
  const on = system.extensions.filter((extension) => extension.enabled)
  const available = system.extensions.length - on.length
  const defaults = on.filter((extension) => extension.layer === 'default')
  const added = on.filter((extension) => extension.layer !== 'default')
  const origins = [
    ...new Set(
      added.map((extension) =>
        extension.layer === 'user'
          ? 'your settings'
          : extension.layer === 'project' || extension.source === 'project'
            ? "this project's setup"
            : 'your extensions',
      ),
    ),
  ]
  return (
    <section className="px-5 pt-6 sm:px-7">
      <Heading meta={`${on.length} on · ${available} available`}>On now</Heading>
      <dl className="mt-2.5 grid grid-cols-[minmax(0,6.25rem)_minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] sm:gap-x-4">
        {defaults.map((extension) => (
          <Fragment key={extension.name}>
            <dt className="truncate font-mono text-[12px] leading-5 text-foreground/85">
              {extension.name}
            </dt>
            <dd className="truncate text-[12.5px] leading-5 text-muted-foreground">
              <Line text={line(extension.name)} />
            </dd>
          </Fragment>
        ))}
      </dl>
      {added.length > 0 && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
          Also on, from {origins.join(' and ')}:{' '}
          <span className="font-mono text-[12px] text-foreground/85">
            {added.map((extension) => extension.name).join(' · ')}
          </span>
        </p>
      )}
    </section>
  )
}

/** The first-run welcome: what Ultimate is, what is on, login, and where to go next. */
export function Welcome({
  open,
  onDone,
  onClosed,
}: {
  open: boolean
  onDone: (next?: 'extensions') => void
  onClosed: () => void
}) {
  const system = useSystem()
  const start = useRef<HTMLButtonElement>(null)
  if (!system) return null
  const off = system.extensions.filter(
    (extension) => !extension.enabled && extension.source === 'builtin',
  )
  const examples = ['plan', 'subagents', 'info'].filter((name) =>
    off.some((extension) => extension.name === name),
  )
  return (
    <Page focus={start} onClose={() => onDone()} onClosed={onClosed} open={open}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="px-5 pt-5 sm:px-7 sm:pt-6">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[12px] font-semibold tracking-[0.3em] text-brand">
              ULTIMATE
            </span>
            <Close label="Close the welcome" onClick={() => onDone()} />
          </div>
          <DialogTitle className="mt-5 text-[22px] font-semibold tracking-tight text-foreground">
            Welcome
          </DialogTitle>
          <DialogDescription className="mt-2 max-w-[36rem] text-[14px] leading-relaxed text-muted-foreground">
            Ultimate is a coding agent in your browser: tell it what you want, and it reads, edits,
            and runs the code in this folder while you watch every step. Everything it is, from its
            tools to this page, is an extension it can change while it runs.
          </DialogDescription>
        </header>
        <div className="px-5 pt-5 sm:px-7">
          <Login />
        </div>
        <OnNow system={system} />
        <div className="grid gap-3 px-5 pt-6 pb-6 sm:grid-cols-2 sm:px-7">
          <Card icon={MessageSquareTextIcon} title="Just ask">
            Type a change, a question, or a bug into the composer. Ultimate works in this folder and
            shows each step; <Kbd>Esc</Kbd> stops it.
          </Card>
          <Card icon={BlocksIcon} title="More building blocks">
            {off.length > 0 ? (
              <>
                {off.length} more are built in and off
                {examples.length > 0 && (
                  <>
                    , such as{' '}
                    {examples.map((name, index) => (
                      <Fragment key={name}>
                        {index > 0 && (index === examples.length - 1 ? ' and ' : ', ')}
                        <code className={code}>{name}</code>
                      </Fragment>
                    ))}
                  </>
                )}
                . Mix and match in the Extensions panel, for this project or everywhere.
              </>
            ) : (
              'Every built-in is on. Mix and match in the Extensions panel, for this project or everywhere.'
            )}{' '}
            <button
              className="inline-flex items-center gap-1 text-brand outline-none hover:underline focus-visible:underline"
              onClick={() => onDone('extensions')}
              type="button"
            >
              Open Extensions
              <ArrowRightIcon className="size-3" />
            </button>
          </Card>
        </div>
      </div>
      <footer className="flex items-center gap-3 border-t border-border/70 bg-sidebar px-5 py-3 sm:px-7">
        <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Keys keys="mod+k" /> finds every command
        </span>
        <Button className="ml-auto" onClick={() => onDone()} ref={start} size="sm">
          Start
          <ArrowRightIcon />
        </Button>
      </footer>
    </Page>
  )
}

/**
 * What a project's setup brings: the built-ins its settings turn on or off, its own extensions with their lines, and
 * its agents and skills by name.
 */
function Adds({ system, adds }: { system: SystemInfo; adds?: Status['adds'] }) {
  const line = useLines()
  const { enable, disable } = projectLists(system)
  const own = system.extensions.filter((extension) => extension.source === 'project')
  const builtins = enable.filter((name) => !own.some((extension) => extension.name === name))
  const groups: [string, readonly string[]][] = [
    ['Built-ins it turns on', builtins],
    ['Its own extensions', own.map((extension) => extension.name)],
  ]
  const named: [string, readonly string[]][] = [
    ['Turns off', disable],
    ['Agents', adds?.agents ?? []],
    ['Skills', adds?.skills ?? []],
  ]
  const empty = [...groups, ...named].every(([, names]) => names.length === 0)
  return (
    <div className="flex flex-col gap-5">
      {groups.map(
        ([title, names]) =>
          names.length > 0 && (
            <section key={title}>
              <Heading meta={names.length}>{title}</Heading>
              <ul className="mt-2 flex flex-col gap-2">
                {names.map((name) => (
                  <li key={name}>
                    <div className="font-mono text-[12px] text-foreground/90">{name}</div>
                    <Line
                      className="line-clamp-2 text-[12px] leading-snug text-muted-foreground"
                      text={line(name)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
      {named.map(
        ([title, names]) =>
          names.length > 0 && (
            <section key={title}>
              <Heading meta={names.length}>{title}</Heading>
              <p className="mt-2 font-mono text-[12px] leading-relaxed text-foreground/85">
                {names.join(' · ')}
              </p>
            </section>
          ),
      )}
      {empty && (
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          No extensions, agents, or skills; only settings, read by the extensions that use them.
        </p>
      )}
    </div>
  )
}

/**
 * The ask-once project page: what the folder's setup adds, its `.ultimate/README.md` as the explainer, and the choice.
 * Closing it without a choice keeps the global setup; the Extensions panel can choose later.
 */
export function ProjectPage({
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
  const focus = useRef<HTMLElement>(null)
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
      setError(message(failure))
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
    <Page
      focus={focus}
      onClose={onClose}
      onClosed={onClosed}
      open={open}
      wide={Boolean(project.readme)}
    >
      {/* Narrow, the header scrolls with the rest; wide, the two columns scroll on their own. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden">
        <header className="flex shrink-0 items-start gap-4 border-b border-border/70 px-5 pt-5 pb-4 sm:px-7 sm:pt-6 sm:pb-5">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
              <FolderCogIcon className="size-3.5 shrink-0 text-brand" />
              <span className="truncate">
                {shortenPath(project.root, { home: system.machine.home })}
              </span>
            </div>
            <DialogTitle className="mt-3 text-[22px] leading-tight font-semibold tracking-tight text-foreground">
              This folder has its own Ultimate setup
            </DialogTitle>
            <DialogDescription className="mt-2 max-w-[44rem] text-[13px] leading-relaxed text-muted-foreground sm:text-[14px]">
              It brings extensions, settings, agents, or skills for working here. Its extensions run
              code on this machine, so the setup stays off until you choose it; until then Ultimate
              uses your global setup.
            </DialogDescription>
          </div>
          <Close label="Decide later" onClick={onClose} />
        </header>
        <div className="flex flex-col lg:min-h-0 lg:flex-1 lg:flex-row">
          {project.readme && (
            <article
              className="min-w-0 px-5 py-6 outline-none sm:px-7 lg:flex-1 lg:overflow-y-auto"
              ref={(node) => {
                focus.current = node
              }}
              tabIndex={-1}
            >
              <MessageResponse className="text-[13.5px] leading-relaxed">
                {project.readme}
              </MessageResponse>
            </article>
          )}
          <aside
            className={cn(
              'px-5 py-5 outline-none sm:px-7',
              project.readme &&
                'order-first border-b border-border/70 bg-sidebar lg:order-none lg:w-80 lg:shrink-0 lg:overflow-y-auto lg:border-b-0 lg:border-l lg:px-5',
            )}
            ref={(node) => {
              if (!project.readme) focus.current = node
            }}
            tabIndex={-1}
          >
            <h3 className="mb-3 text-[13px] font-medium text-foreground">What it adds</h3>
            <Adds adds={adds} system={system} />
          </aside>
        </div>
      </div>
      <footer className="flex flex-col gap-3 border-t border-border/70 bg-sidebar px-5 py-3.5 sm:flex-row sm:items-center sm:px-7">
        <p className="min-w-0 flex-1 text-[12px] leading-snug text-muted-foreground">
          {error ? (
            <span className="text-error">{error}</span>
          ) : (
            'You can change this any time in the Extensions panel.'
          )}
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button
            disabled={busy !== undefined}
            onClick={() => void decide(false)}
            size="sm"
            variant="outline"
          >
            {choice(false)}
            Use my global setup
          </Button>
          <Button disabled={busy !== undefined} onClick={() => void decide(true)} size="sm">
            {choice(true)}
            Use this project's setup
          </Button>
        </div>
      </footer>
    </Page>
  )
}
