import { useEffect, useSyncExternalStore } from 'react'
import { api, cn, useUltimate } from '@/sdk'
import { ListAction } from './refs.ts'
import type { Subscription, SubscriptionListItem } from './types.ts'

export type State = Subscription['state']

/** Each state's dot, text tone and word: purple writing, green running, yellow investigating, red failed. */
export const states: Record<State, { dot: string; text: string; word: string; busy?: boolean }> = {
  writing: { dot: 'bg-brand', text: 'text-brand', word: 'writing', busy: true },
  running: { dot: 'bg-success', text: 'text-success', word: 'running' },
  investigating: { dot: 'bg-warning', text: 'text-warning', word: 'investigating', busy: true },
  failed: { dot: 'bg-error', text: 'text-error', word: 'failed' },
  stopped: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', word: 'stopped' },
  done: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', word: 'done' },
}

/** Worst first: what the status-line chip colours itself by. */
const severity: State[] = ['failed', 'investigating', 'writing', 'running', 'done', 'stopped']
export const worst = (list: readonly Subscription[]) =>
  severity.find((state) => list.some((sub) => sub.state === state))

export function Dot({ state, className }: { state: State; className?: string }) {
  const look = states[state]
  return (
    <span
      aria-label={look.word}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        look.dot,
        look.busy && 'animate-pulse-dot',
        className,
      )}
      role="img"
    />
  )
}

/** `12s`, `5m`, `3h 12m`, `2d 4h`: how long since `at`, in whole units. */
export function since(at: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`
}

/** The one line under a subscription's title: what it is doing right now. */
export function stateLine(sub: SubscriptionListItem, now: number) {
  const parts: string[] = []
  if (sub.state === 'running' && sub.startedAt) parts.push(`up ${since(sub.startedAt, now)}`)
  if (sub.state === 'writing') parts.push('agent is writing run')
  if (sub.state === 'investigating') parts.push('agent is investigating')
  if (sub.state === 'failed' && sub.error) parts.push(sub.error)
  if (sub.fires > 0)
    parts.push(`fired ${sub.fires}${sub.lastFireAt ? ` · ${since(sub.lastFireAt, now)} ago` : ''}`)
  else if (sub.state === 'running') parts.push('not fired yet')
  return parts.join(' · ')
}

type Polled = { data?: SubscriptionListItem[]; error?: unknown }
/**
 * One list poll for the whole page: the chip, the sidebar and the panel share it, and it runs at the fastest rate
 * any of them asks for.
 */
const poll = {
  state: {} as Polled,
  listeners: new Set<() => void>(),
  rates: new Map<symbol, number>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  rate: 0,
  loading: undefined as Promise<void> | undefined,
}
function publish(state: Polled) {
  poll.state = state
  for (const listener of poll.listeners) listener()
}
/** Fetch the list now; a fetch in flight is reused. Call it after an action changes a subscription. */
export function refreshSubscriptions() {
  poll.loading ??= api
    .action(ListAction)
    .then((data) => publish({ data }))
    .catch((error: unknown) => publish({ ...poll.state, error }))
    .finally(() => (poll.loading = undefined))
  return poll.loading
}
function reschedule() {
  const rate = Math.min(...poll.rates.values())
  if (rate === poll.rate) return
  clearInterval(poll.timer)
  poll.rate = rate
  poll.timer = Number.isFinite(rate)
    ? setInterval(() => void refreshSubscriptions(), rate)
    : undefined
}
const listen = (listener: () => void) => {
  poll.listeners.add(listener)
  return () => void poll.listeners.delete(listener)
}

/** The subscriptions, fetched again every `ms` while this component is mounted (`false`: once). */
export function useSubscriptions(ms: number | false): Polled {
  useEffect(() => {
    const key = Symbol()
    poll.rates.set(key, ms === false ? Infinity : ms)
    reschedule()
    // oxlint-disable-next-line typescript/no-floating-promises -- refreshSubscriptions catches failures and publishes them in poll.state.error.
    void refreshSubscriptions()
    return () => {
      poll.rates.delete(key)
      reschedule()
    }
  }, [ms])
  return useSyncExternalStore(listen, () => poll.state)
}

/** Opens the Subscriptions panel, on the Agent surface: other surfaces, such as System, have no panels. */
export function openSubscriptionsPanel(shell: {
  showSurface: (id: string) => void
  openPanel: (id?: string) => void
}) {
  shell.showSurface('agent')
  shell.openPanel('subscriptions')
}

/**
 * Opens subscription `id`: its agent's conversation in the middle and the Subscriptions panel beside it, which then
 * shows its script. An id the list does not know yet (a card for a subscription just created) is looked up first;
 * one that is gone opens the panel on the list.
 */
export function useOpenSubscription() {
  const { switchConversation, ...shell } = useUltimate()
  const agent = (id: string) => poll.state.data?.find((sub) => sub.id === id)?.conversationId
  const show = (id: string) => {
    const to = agent(id)
    if (to !== undefined) switchConversation(to)
    // After the switch, which closes an overlaid panel on a phone.
    openSubscriptionsPanel(shell)
  }
  return (id: string) => {
    if (agent(id) !== undefined) return show(id)
    // oxlint-disable-next-line typescript/no-floating-promises -- refreshSubscriptions catches failures and publishes them in poll.state.error.
    void refreshSubscriptions().then(() => show(id))
  }
}
