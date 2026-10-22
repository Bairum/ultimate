import { RadarIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { cn, defineWebExtension, Fold, useToolDuration, useUltimate } from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import {
  Dot,
  openSubscriptionsPanel,
  states,
  useOpenSubscription,
  useSubscriptions,
  worst,
} from './parts.tsx'
import type { State } from './parts.tsx'
import { WatchingSection } from './sidebar.tsx'
import { SubscriptionsPanel } from './panel.tsx'

/** The status-line chip: how many subscriptions, coloured by the worst; gone while there are none. */
function Chip() {
  const shell = useUltimate()
  // The chip only needs to notice a failure within a few seconds; the open panel polls faster for everyone.
  const { data } = useSubscriptions(5000)
  const list = data ?? []
  const state = worst(list)
  if (!state) return null
  const counts = (['failed', 'investigating', 'writing', 'running'] as const)
    .map((name) => [name, list.filter((sub) => sub.state === name).length] as const)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${states[name].word}`)
  return (
    <button
      aria-label={`${list.length} subscriptions${counts.length ? `: ${counts.join(', ')}` : ''}`}
      className={cn(
        '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground',
        (state === 'failed' || state === 'investigating') && states[state].text,
      )}
      data-subscriptions-chip={state}
      onClick={() => openSubscriptionsPanel(shell)}
      title={counts.join(' · ') || 'Subscriptions'}
      type="button"
    >
      <Dot state={state} />
      {list.length} {list.length === 1 ? 'watch' : 'watches'}
    </button>
  )
}

type Kind = 'fired' | 'failed' | 'escalated' | 'writing'
const kinds: Record<Kind, { state: State; word: string; border: string }> = {
  fired: { state: 'running', word: 'fired', border: 'border-l-success/70' },
  failed: { state: 'investigating', word: 'failed', border: 'border-l-warning/70' },
  escalated: { state: 'failed', word: 'escalated', border: 'border-l-error/70' },
  writing: { state: 'writing', word: 'assigned', border: 'border-l-brand/60' },
}

/** `text` of a FIRE line may be JSON: show it as a code block then. */
function body(text: string) {
  const trimmed = text.trim()
  if (/^[[{]/.test(trimmed))
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(trimmed), null, 2)}\n\`\`\``
    } catch {
      // Not JSON after all: it reads as Markdown like any other text.
    }
  return text
}

/** A subscription's input to a conversation: fired, failed, escalated, or the agent's first task. */
const card = (kind: Kind) =>
  function SubscriptionEntry({ entry }: { entry: EntryRecord }) {
    const { id, title, text } = entry.data as { id: string; title: string; text: string }
    const look = kinds[kind]
    const open = useOpenSubscription()
    const name: ReactNode = (
      <>
        <span className="shrink-0 text-muted-foreground">{id}</span>
        <span className="min-w-0 truncate text-foreground" title={title}>
          {title}
        </span>
        <span className={cn('shrink-0', states[look.state].text)}>{look.word}</span>
      </>
    )
    return (
      <Fold
        card={entry.id}
        summary={
          <>
            <Dot state={look.state} />
            <span className="flex min-w-0 items-center gap-1.5 text-foreground/80">{name}</span>
          </>
        }
      >
        <section
          className={cn(
            'min-w-0 rounded-md border border-l-2 border-border bg-muted/20',
            look.border,
          )}
          data-subscription-entry={kind}
        >
          <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px]">
            <RadarIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 items-center gap-1.5">{name}</span>
            <button
              className="ml-auto shrink-0 cursor-pointer text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => open(id)}
              title={`Show ${id}'s agent and script`}
              type="button"
            >
              open {id}
            </button>
          </header>
          {text && (
            <div
              className={cn(
                'min-w-0 px-3 py-2.5 text-[13px] leading-relaxed',
                kind === 'writing' && 'text-foreground/85',
              )}
            >
              <MessageResponse>{kind === 'writing' ? text : body(text)}</MessageResponse>
            </div>
          )}
        </section>
      </Fold>
    )
  }

const words = (value: unknown) => (typeof value === 'string' ? value : '')

/** The subscription id a call touched: its argument, or the `S<n>` its result starts with. */
const touched = (call: ToolCallView) =>
  words(call.args.id) || (/^(S\d+) /.exec(call.output)?.[1] ?? '')

/** One `subscription` call: the action and subscription, the ask on create, and the result line. */
function SubscriptionCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const open = useOpenSubscription()
  const shell = useUltimate()
  const action = words(call.args.action) || '…'
  const id = touched(call)
  const ask = words(call.args.ask)
  const result = /^S\d+ (\w+) /.exec(call.output)?.[1] as State | undefined
  const target = words(call.args.to)
  return (
    <Tool defaultOpen={call.status === 'error'}>
      <div className="flex items-center">
        <ToolHeader
          className="min-w-0 flex-1"
          meta={
            <>
              {result && states[result] && call.status === 'done' && (
                <span className={cn('flex items-center gap-1.5', states[result].text)}>
                  <Dot state={result} />
                  {states[result].word}
                </span>
              )}
              {duration && <span>{duration}</span>}
            </>
          }
          name="subscription"
          state={call.status}
          title={
            <>
              {action}
              {id && <span className="text-foreground/85"> {id}</span>}
              {words(call.args.title) && (
                <span className="text-foreground/85"> {words(call.args.title)}</span>
              )}
              {target && ` → ${target}`}
            </>
          }
        />
        <Button
          className="mr-1 h-6 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => (id ? open(id) : openSubscriptionsPanel(shell))}
          size="sm"
          title={id ? `Show ${id}'s agent and script` : 'Show Subscriptions'}
          variant="ghost"
        >
          <RadarIcon className="size-3" />
          {id || 'subscriptions'}
        </Button>
      </div>
      <ToolContent>
        {ask && (
          <ToolSection label="Ask">
            <p className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {ask}
            </p>
          </ToolSection>
        )}
        {words(call.args.reason) && (
          <ToolSection label="Reason">
            <p className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {words(call.args.reason)}
            </p>
          </ToolSection>
        )}
        <ToolOutput isError={call.status === 'error'} output={call.output} />
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({
  panels: [
    {
      id: 'subscriptions',
      title: 'Subscriptions',
      icon: RadarIcon,
      component: SubscriptionsPanel,
      // A working tab after Activity; also opened from WATCHING, the status-line chip, cards and ⌘K.
      order: 2.5,
    },
  ],
  commands: [
    {
      id: 'subscriptions.open',
      title: 'Subscriptions…',
      run: openSubscriptionsPanel,
    },
  ],
  slots: {
    'statusline.right': [{ component: Chip, order: -2 }],
    'sidebar.top': [{ component: WatchingSection, order: -20 }],
  },
  tools: { subscription: SubscriptionCall },
  entries: {
    'subscriptions.fired': card('fired'),
    'subscriptions.failed': card('failed'),
    'subscriptions.escalated': card('escalated'),
    'subscriptions.writing': card('writing'),
  },
})
