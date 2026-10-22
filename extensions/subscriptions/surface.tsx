import {
  ArrowLeftIcon,
  PlayIcon,
  RadarIcon,
  SquareArrowOutUpRightIcon,
  SquareIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnsiOutput } from '@/components/ai/ansi-output'
import { CodeBlock, languageFromPath } from '@/components/ai/code-block'
import { Button } from '@/components/ui/button'
import {
  api,
  cn,
  Conversation,
  errorMessage,
  Header,
  shortenPath,
  StatusLine,
  useAction,
  useConversation,
  useExtensionUiState,
  useNow,
  useSystem,
  useStore,
  useUltimate,
  useViewport,
} from '@/sdk'
import {
  Dot,
  refreshSubscriptions,
  since,
  stateLine,
  states,
  showAgent,
  takePick,
  useOpenAgent,
  useSubscriptions,
} from './parts.tsx'
import { LogAction, ScriptAction, StartAction, StopAction } from './refs.ts'
import type { SubscriptionListItem } from './types.ts'

const subscribe = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
/** Whether the surface is on screen in a visible tab: polling runs only then. */
function useLive() {
  const visible = useSyncExternalStore(subscribe, () => document.visibilityState === 'visible')
  return useUltimate().surface === 'subscriptions' && visible
}

const heading = 'font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase'

/** Every subscription: a list beside the selected one's agent and its running script. */
export function Subscriptions() {
  const live = useLive()
  const now = useNow(1000, live)
  const { data, error } = useSubscriptions(live ? 2000 : false)
  const [stored, setSelected] = useExtensionUiState<string | null>('selected', null)
  const { switchConversation } = useUltimate()
  // The conversation shown or loading: a switch sets it at once, so the selection follows without a gap.
  const shown = useStore((state) => state.requested)
  const phone = useViewport() === 'phone'
  const list = data ?? []
  // The shell's conversation decides: a pick switches it, and so do Back or any other navigation to an agent.
  const byShown = list.find((sub) => sub.conversationId === shown)
  const selected = byShown ?? list.find((sub) => sub.id === stored) ?? (phone ? undefined : list[0])
  // On a phone the detail replaces the list; which one shows is separate from the selection, which follows the shell.
  const [phoneList, setPhoneList] = useState(!stored)
  const select = (sub: SubscriptionListItem) => {
    setSelected(sub.id)
    setPhoneList(false)
    showAgent(switchConversation, sub.conversationId)
  }
  useEffect(() => {
    if (byShown && byShown.id !== stored) setSelected(byShown.id)
  }, [byShown, stored, setSelected])
  // On screen, open a pick made elsewhere, or else the selection's agent when the shell shows none.
  const agent = selected?.conversationId
  useEffect(() => {
    if (!live || !data) return
    const pick = takePick()
    const picked = list.find((sub) => sub.id === pick)
    if (picked) setPhoneList(false)
    const to = picked?.conversationId ?? (byShown ? undefined : agent)
    if (to !== undefined && to !== shown) showAgent(switchConversation, to)
    // Only arriving or a new selection acts; the shown conversation is read, not followed.
    // oxlint-disable-next-line react/exhaustive-deps -- shown, list and byShown are read at that moment
  }, [live, agent, data !== undefined])
  // A deleted selection falls back to the list.
  const open = !phoneList && !!selected
  const showList = !phone || !open
  const showDetail = !phone || open
  return (
    <>
      <Header>
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
          {phone && open ? (
            <button
              aria-label="All subscriptions"
              className="-ml-1 grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setPhoneList(true)}
              type="button"
            >
              <ArrowLeftIcon className="size-4" />
            </button>
          ) : (
            <RadarIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          {phone && open ? (
            <span className="truncate">
              <span className="font-mono text-muted-foreground">{selected.id}</span>{' '}
              {selected.title}
            </span>
          ) : (
            'Subscriptions'
          )}
        </span>
      </Header>
      <div className="flex min-h-0 flex-1">
        {showList && (
          <nav
            aria-label="Subscriptions"
            className={cn(
              'flex min-h-0 shrink-0 flex-col overflow-y-auto bg-sidebar',
              phone ? 'flex-1' : 'w-80 border-r border-border/70',
            )}
          >
            <div className={cn(heading, 'flex items-center gap-2 px-3 pt-3 pb-1.5')}>
              Watching
              <span className="ml-auto tracking-normal normal-case text-muted-foreground/70">
                {list.length || ''}
              </span>
            </div>
            {list.length === 0 && (
              <p className="px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
                {error
                  ? `Could not load subscriptions: ${errorMessage(error)}`
                  : !data
                    ? 'loading…'
                    : 'Nothing is being watched. Ask an agent to subscribe, for example "wake me when the CI of PR #812 finishes".'}
              </p>
            )}
            <ul className="px-1.5 pb-2">
              {list.map((sub) => (
                <li key={sub.id}>
                  <button
                    aria-current={sub.id === selected?.id && !phone ? 'true' : undefined}
                    className={cn(
                      'flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring',
                      sub.id === selected?.id && !phone && 'bg-accent',
                    )}
                    data-subscription={sub.id}
                    onClick={() => select(sub)}
                    type="button"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Dot state={sub.state} />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{sub.title}</span>
                      <span
                        className="shrink-0 font-mono text-[11px] text-muted-foreground/70"
                        title={
                          sub.scope === 'project'
                            ? 'Project subscription: committed in .ultimate/subscriptions/'
                            : undefined
                        }
                      >
                        {sub.scope === 'project' && (
                          <span className="text-muted-foreground/50">project · </span>
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
          </nav>
        )}
        {showDetail && selected && (
          <main className="flex min-w-0 flex-1 flex-col">
            <Agent sub={selected} />
            <Script
              live={live}
              now={now}
              onChange={() => void refreshSubscriptions()}
              sub={selected}
            />
          </main>
        )}
        {showDetail && !selected && !phone && data && (
          <main className="grid min-w-0 flex-1 place-items-center p-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
            No subscription selected
          </main>
        )}
      </div>
      <StatusLine />
    </>
  )
}

/** The agent that writes and repairs the script: its conversation, with a composer to refine it. */
function Agent({ sub }: { sub: SubscriptionListItem }) {
  const shown = useConversation((conversation) => conversation.id) === sub.conversationId
  const openAgent = useOpenAgent()
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-subscription-agent={sub.conversationId}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 pr-1.5 pl-3">
        <span className={heading}>Agent</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
          #{sub.conversationId} · {sub.once ? 'one-shot' : 'recurring'} ·{' '}
          {sub.subscribers.length === 1 ? '1 subscriber' : `${sub.subscribers.length} subscribers`}
        </span>
        <Button
          className="ml-auto h-6 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          onClick={openAgent}
          size="xs"
          title={`Open #${sub.conversationId} in the Agent surface`}
          variant="ghost"
        >
          <SquareArrowOutUpRightIcon className="size-3" />
          open conversation
        </Button>
      </div>
      {shown ? (
        <Conversation variant="main" />
      ) : (
        <p className="grid flex-1 place-items-center font-mono text-[11.5px] text-muted-foreground/70">
          loading #{sub.conversationId}…
        </p>
      )}
    </section>
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
      className="flex h-[42%] min-h-48 shrink-0 flex-col border-t border-border/70 font-mono text-[12px]"
      data-subscription-script={sub.id}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 pr-1.5 pl-3">
        <span className={heading}>Script</span>
        <span className={cn('flex shrink-0 items-center gap-1.5 text-[11px]', look.text)}>
          <Dot state={sub.state} />
          {look.word}
        </span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground tabular-nums">
          {facts.join(' · ')}
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
      <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-muted-foreground">
        <span className="shrink-0 text-muted-foreground/50">$</span>
        <span className="min-w-0 truncate text-foreground/90" title={path}>
          {path ? (home ? shortenPath(path, { home }) : path) : '…'}
        </span>
        {sub.error && sub.state !== 'running' && (
          <span
            className={cn('ml-auto max-w-[50%] shrink-0 truncate', look.text)}
            title={sub.error}
          >
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
