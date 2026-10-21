import { useEffect, useState } from 'react'
import { api, cn, useExtensionUiState, useUltimate } from '@/sdk'
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

/** The subscriptions, fetched again every `ms` while `live` and whenever `key` changes. */
export function useSubscriptions(live: boolean, ms: number, key?: unknown) {
  const [state, setState] = useState<{ data?: SubscriptionListItem[]; error?: unknown }>({})
  useEffect(() => {
    const controller = new AbortController()
    const load = () =>
      api
        .action(ListAction, null, { signal: controller.signal })
        .then((data) => setState({ data }))
        .catch((error: unknown) => {
          // Aborted when the surface hides or the key changes; the next fetch owns the state.
          if (!controller.signal.aborted) setState((previous) => ({ ...previous, error }))
        })
    void load()
    const timer = live ? setInterval(() => void load(), ms) : undefined
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [live, ms, key])
  return state
}

/**
 * Opens subscription `id` in the surface: selects it and shows its agent's conversation there, so the transcript on
 * top is the agent that wrote it.
 */
export function useOpenSubscription() {
  const [, setSelected] = useExtensionUiState<string | null>('selected', null)
  const { showSurface, switchConversation } = useUltimate()
  return async (id: string, conversation?: number) => {
    setSelected(id)
    showSurface('subscriptions')
    const agent =
      conversation ?? (await api.action(ListAction)).find((sub) => sub.id === id)?.conversationId
    if (agent !== undefined) switchConversation(agent)
  }
}
