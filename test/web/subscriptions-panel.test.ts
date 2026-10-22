import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SubscriptionListItem } from '../../extensions/subscriptions/types.ts'

const shell = vi.hoisted(() => ({ requested: undefined as number | undefined }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  // Server rendering has no store to subscribe to: read each external store's current value.
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}))
vi.mock('@/sdk', () => ({
  api: { action: () => Promise.resolve(null) },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  errorMessage: (error: unknown) => String(error),
  shortenPath: (path: string) => path,
  useAction: (_ref: unknown, args: { id: string; lines?: number }) => ({
    data:
      args.lines === undefined
        ? { path: `/subs/${args.id}/run`, text: '#!/bin/sh' }
        : { text: 'checking\nFIRE build green' },
    refetch: () => Promise.resolve(undefined),
  }),
  useExtensionUiState: <T>(_key: string, initial: T) => [initial, () => {}],
  useNow: () => 1_000_000,
  useStore: (select: (state: { requested?: number; ui: object }) => unknown) =>
    select({ requested: shell.requested, ui: {} }),
  useSystem: () => undefined,
  useUiState: <T>(_key: string, initial: T) => [initial, () => {}],
  useUltimate: () => ({
    conversationId: shell.requested,
    openPanel: () => {},
    switchConversation: () => {},
  }),
  useViewport: () => 'desktop',
}))
const sub = (id: string, conversationId: number, extra: Partial<SubscriptionListItem> = {}) =>
  ({
    id,
    title: `watch ${id}`,
    ask: 'watch it',
    once: false,
    enabled: true,
    conversationId,
    subscribers: [1],
    createdAt: 0,
    updatedAt: 0,
    state: 'running',
    fires: 1,
    alive: true,
    ...extra,
  }) satisfies SubscriptionListItem
const list = [
  sub('S1', 41),
  sub('ci-watch', 42, { scope: 'project', state: 'failed', error: 'exit 2' }),
]
vi.mock('../../extensions/subscriptions/parts.tsx', async (original) => ({
  ...(await original<typeof import('../../extensions/subscriptions/parts.tsx')>()),
  useSubscriptions: () => ({ data: list }),
}))
Object.assign(globalThis, { document: { visibilityState: 'visible' } })
const { SubscriptionsPanel } = await import('../../extensions/subscriptions/panel.tsx')

const render = () => renderToStaticMarkup(createElement(SubscriptionsPanel))
beforeEach(() => {
  shell.requested = undefined
})

it('shows the script of the subscription whose agent is the shown conversation', () => {
  shell.requested = 42
  const html = render()
  expect(html).toContain('data-subscription-script="ci-watch"')
  expect(html).toContain('/subs/ci-watch/run')
  expect(html).toContain('exit 2')
  expect(html).toContain('>project<')
  // Only that subscription, not the list.
  expect(html).not.toContain('data-subscription="S1"')
})

it('marks FIRE lines in the output of the shown subscription', () => {
  shell.requested = 41
  const html = render()
  expect(html).toContain('data-subscription-script="S1"')
  expect(html).toMatch(/border-success[^>]*><span[^>]*>FIRE<\/span> build green/)
})

it('lists every subscription beside a conversation that is no subscription agent', () => {
  shell.requested = 7
  const html = render()
  expect(html).toContain('data-subscription="S1"')
  expect(html).toContain('data-subscription="ci-watch"')
  expect(html).not.toContain('data-subscription-script')
})
