import { ArrowLeftIcon, PlayIcon, RadarIcon, SquareIcon } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnsiOutput } from '@/components/ai/ansi-output'
import { CodeBlock, languageFromPath } from '@/components/ai/code-block'
import { Button } from '@/components/ui/button'
import {
  api,
  cn,
  errorMessage,
  shortenPath,
  useAction,
  useExtensionUiState,
  useNow,
  useStore,
  useSystem,
  useUiState,
  useUltimate,
  useViewport,
} from '@/sdk'
import { Dot, refreshSubscriptions, since, stateLine, states, useSubscriptions } from './parts.tsx'
import { LogAction, ScriptAction, StartAction, StopAction } from './refs.ts'
import type { SubscriptionListItem } from './types.ts'

const subscribe = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
/**
 * Whether the panel is open in a visible tab: polling runs only then. Below desktop width the panel overlays the
 * conversation and stays mounted while folded away, so its open state is read as the shell keeps it.
 */
function useLive() {
  const visible = useSyncExternalStore(subscribe, () => document.visibilityState === 'visible')
  const on = useViewport()
  const [docked] = useUiState<boolean>('shell.panelOpen', false)
  const overlaid = useStore((state) =>
    on === 'desktop' ? false : (state.ui.open?.[on]?.panels ?? false),
  )
  return visible && (on === 'desktop' ? docked : overlaid)
}

const heading = 'font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase'

/**
 * The right panel's Subscriptions tab. It follows the shown conversation: a subscription's agent shows that
 * subscription's script beside it, any other conversation the list of all of them.
 */
export function SubscriptionsPanel() {
  const live = useLive()
  const now = useNow(1000, live)
  const { data, error } = useSubscriptions(live ? 2000 : false)
  const { conversationId, openPanel, switchConversation } = useUltimate()
  // The conversation shown or loading: a switch sets it at once, so the panel follows without a gap.
  const shown = useStore((state) => state.requested) ?? conversationId
  // "All subscriptions" from an agent: the list, until the shell shows another conversation.
  const [listing, setListing] = useState<number>()
  // Another conversation ends it, so coming back to the agent shows its script again.
  if (listing !== undefined && listing !== shown) setListing(undefined)
  const list = data ?? []
  const current = list.find((sub) => sub.conversationId === shown)
  const open = (sub: SubscriptionListItem) => {
    setListing(undefined)
    if (sub.conversationId === shown) return
    switchConversation(sub.conversationId)
    // A switch folds an overlaid panel away below desktop width; this one stays to show the script.
    openPanel('subscriptions')
  }
  if (current && listing !== shown)
    return <Detail live={live} now={now} onBack={() => setListing(shown)} sub={current} />
  return (
    <div className="pb-3">
      <div className={cn(heading, 'flex items-center gap-2 px-3 pt-2 pb-1.5')}>
        Subscriptions
        {list.length > 0 && (
          <span className="ml-auto tracking-normal normal-case text-muted-foreground/70">
            {list.length}
          </span>
        )}
      </div>
      {list.length === 0 ? (
        error ? (
          <p className="px-3 py-2 font-mono text-[11.5px] leading-snug text-error">
            Could not load subscriptions: {errorMessage(error)}
          </p>
        ) : !data ? (
          <p className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">loading…</p>
        ) : (
          <div className="flex flex-col items-center px-6 pt-8 pb-6 text-center">
            <RadarIcon className="size-5 text-muted-foreground/60" />
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
              Nothing is being watched. Ask an agent to subscribe, for example "wake me when the CI
              of PR #812 finishes".
            </p>
          </div>
        )
      ) : (
        <ul className="px-1.5" aria-label="Subscriptions">
          {list.map((sub) => (
            <li key={sub.id}>
              <button
                aria-current={sub.id === current?.id ? 'true' : undefined}
                className={cn(
                  'flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring',
                  sub.id === current?.id && 'bg-accent/70',
                )}
                data-subscription={sub.id}
                onClick={() => open(sub)}
                title={`Show ${sub.id}'s agent #${sub.conversationId}`}
                type="button"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Dot state={sub.state} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{sub.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
                    {sub.scope === 'project' && (
                      <span
                        className="text-muted-foreground/50"
                        title="Project subscription: committed in .ultimate/subscriptions/"
                      >
                        project ·{' '}
                      </span>
                    )}
                    {sub.id}
                  </span>
                </span>
                <span
                  className={cn(
                    'truncate pl-3.5 font-mono text-[11px]',
                    sub.state === 'failed' || sub.state === 'investigating'
                      ? states[sub.state].text
                      : 'text-muted-foreground',
                  )}
                >
                  {states[sub.state].word}
                  {stateLine(sub, now) && ` · ${stateLine(sub, now)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One subscription beside its agent: what it is and who it wakes, then its running script. */
function Detail({
  sub,
  live,
  now,
  onBack,
}: {
  sub: SubscriptionListItem
  live: boolean
  now: number
  onBack: () => void
}) {
  const subscribers =
    sub.subscribers.length === 1 ? '1 subscriber' : `${sub.subscribers.length} subscribers`
  return (
    <div className="flex h-full min-h-80 flex-col" data-subscription-panel={sub.id}>
      <header className="shrink-0 px-3 pt-1.5 pb-2.5">
        <div className="-ml-1.5 flex h-7 items-center gap-2">
          <button
            className={cn(
              heading,
              'flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
            )}
            onClick={onBack}
            title="All subscriptions"
            type="button"
          >
            <ArrowLeftIcon className="size-3" />
            Subscriptions
          </button>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground/70">{sub.id}</span>
        </div>
        <h2 className="mt-1 line-clamp-2 text-[13.5px] leading-snug font-medium" title={sub.ask}>
          {sub.title}
        </h2>
        <p className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          {sub.scope === 'project' && (
            <span
              className="shrink-0 rounded-sm border border-border/80 px-1 text-[10px] leading-4"
              title="Project subscription: committed in .ultimate/subscriptions/"
            >
              project
            </span>
          )}
          <span className="truncate">
            {sub.once ? 'one-shot' : 'recurring'} · {subscribers}
          </span>
        </p>
      </header>
      <Script live={live} now={now} onChange={() => void refreshSubscriptions()} sub={sub} />
    </div>
  )
}

/** The supervised script: its command and process, the live output tail, and start or stop. */
function Script({
  sub,
  live,
  now,
  onChange,
}: {
  sub: SubscriptionListItem
  live: boolean
  now: number
  onChange: () => void
}) {
  const home = useSystem()?.machine.home
  const [view, setView] = useExtensionUiState<'output' | 'script'>('pane', 'output')
  const [busy, setBusy] = useState(false)
  // Read errors show inline in the pane instead of as a notice on every poll.
  const log = useAction(LogAction, { id: sub.id, lines: 200 }, { onError: () => {} })
  // Always read once for the command's path; only the script tab polls it for edits.
  const script = useAction(ScriptAction, { id: sub.id }, { onError: () => {} })
  const { refetch: refetchLog } = log
  const { refetch: refetchScript } = script
  // Poll with the list, so new output arrives as the script prints it.
  useEffect(() => {
    if (!live) return undefined
    const timer = setInterval(() => {
      // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
      void refetchLog()
      // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
      if (view === 'script') void refetchScript()
    }, 2000)
    return () => clearInterval(timer)
  }, [live, view, refetchLog, refetchScript])
  const output = log.data?.text ?? ''
  const scroller = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [output, view])
  const running = sub.state === 'running'
  const path = script.data?.path
  const act = async (start: boolean) => {
    setBusy(true)
    try {
      await api.action(start ? StartAction : StopAction, { id: sub.id })
    } finally {
      setBusy(false)
      onChange()
      // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
      void refetchLog()
    }
  }
  const look = states[sub.state]
  const facts = [
    sub.pid !== undefined && `pid ${sub.pid}`,
    running && sub.startedAt && `up ${since(sub.startedAt, now)}`,
    !running && sub.exitCode !== undefined && `exit ${sub.exitCode}`,
    `fired ${sub.fires}`,
    running && sub.lastOutputAt && `output ${since(sub.lastOutputAt, now)} ago`,
  ].filter(Boolean)
  return (
    <section
      className="flex min-h-0 flex-1 flex-col border-t border-border/70 font-mono text-[12px]"
      data-subscription-script={sub.id}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <span className={heading}>Script</span>
        <span className={cn('flex shrink-0 items-center gap-1.5 text-[11px]', look.text)}>
          <Dot state={sub.state} />
          {look.word}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {(['output', 'script'] as const).map((name) => (
            <button
              aria-pressed={view === name}
              className={cn(
                'h-6 cursor-pointer rounded-md px-2 text-[11px] text-muted-foreground transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
                view === name ? 'bg-accent text-foreground' : 'hover:text-foreground',
              )}
              key={name}
              onClick={() => setView(name)}
              type="button"
            >
              {name}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border/70" />
          {running ? (
            <Button
              className="h-6 gap-1 px-2 font-mono text-[11px]"
              disabled={busy}
              onClick={() => void act(false)}
              size="xs"
              variant="outline"
            >
              <SquareIcon className="size-2.5 fill-current" />
              Stop
            </Button>
          ) : (
            <Button
              className="h-6 gap-1 px-2 font-mono text-[11px]"
              disabled={busy || sub.state === 'writing'}
              onClick={() => void act(true)}
              size="xs"
              title={
                sub.state === 'writing' ? 'The agent starts it once run is written' : undefined
              }
              variant="outline"
            >
              <PlayIcon className="size-2.5 fill-current" />
              {sub.state === 'done' || sub.state === 'stopped' ? 'Start again' : 'Start'}
            </Button>
          )}
        </span>
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 border-b border-border/70 px-3 pb-2 text-[11px] text-muted-foreground">
        <span className="truncate tabular-nums">{facts.join(' · ')}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-muted-foreground/50">$</span>
          <span className="min-w-0 truncate text-foreground/90" title={path}>
            {path ? (home ? shortenPath(path, { home }) : path) : '…'}
          </span>
        </span>
        {sub.error && sub.state !== 'running' && (
          <span className={cn('line-clamp-3 break-words', look.text)} title={sub.error}>
            {sub.error}
          </span>
        )}
      </div>
      {view === 'output' ? (
        <pre
          className="min-h-0 flex-1 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85"
          onScroll={(event) => {
            const element = event.currentTarget
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
          }}
          ref={scroller}
        >
          {log.error && (
            <div className="text-destructive">Could not read output: {errorMessage(log.error)}</div>
          )}
          {output ? (
            <Output text={output} />
          ) : (
            !log.error && (
              <span className="text-muted-foreground/70">
                {sub.state === 'writing' ? 'no output yet · the agent is writing run' : 'no output'}
              </span>
            )
          )}
          {running && (
            <span className="ml-px inline-block h-3.5 w-1.5 animate-pulse-dot bg-success align-middle" />
          )}
        </pre>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-terminal">
          {script.error && script.data?.text && (
            <p className="px-3 pt-2 text-destructive">
              Could not read run: {errorMessage(script.error)}
            </p>
          )}
          {script.data?.text ? (
            <CodeBlock
              className="rounded-none border-none bg-transparent"
              code={script.data.text}
              language={scriptLanguage(script.data.text)}
              showLineNumbers
            />
          ) : (
            <p
              className={cn(
                'px-3 py-2',
                script.error ? 'text-destructive' : 'text-muted-foreground/70',
              )}
            >
              {script.error
                ? `Could not read run: ${errorMessage(script.error)}`
                : script.loading && !script.data
                  ? 'loading…'
                  : 'run is not written yet'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

/** The log with each `FIRE` line marked, since those are what woke the subscribers. */
function Output({ text }: { text: string }) {
  const lines = text.split('\n')
  if (!lines.some((line) => /^FIRE(\s|$)/.test(line))) return <AnsiOutput output={text} />
  return lines.map((line, index) =>
    /^FIRE(\s|$)/.test(line) ? (
      <div className="-mx-3 border-l-2 border-success bg-success/10 px-2.5" key={index}>
        <span className="font-semibold text-success">FIRE</span>
        {line.slice(4)}
      </div>
    ) : (
      <div key={index}>
        <AnsiOutput output={line || ' '} />
      </div>
    ),
  )
}

/** Highlighting from the shebang: `#!/usr/bin/env python3` reads as Python. */
function scriptLanguage(text: string) {
  const shebang = /^#!\S*?(?:env\s+)?(\S+)/.exec(text)?.[1]?.split('/').pop() ?? 'sh'
  const ext: Record<string, string> = {
    bash: 'sh',
    sh: 'sh',
    zsh: 'sh',
    python: 'py',
    python3: 'py',
    node: 'js',
    bun: 'ts',
    deno: 'ts',
    ruby: 'rb',
  }
  return languageFromPath(`run.${ext[shebang] ?? 'sh'}`)
}
