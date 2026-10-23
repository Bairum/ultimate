import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AutomationListItem } from '../../extensions/automations/types.ts'

const shell = vi.hoisted(() => ({
  requested: undefined as number | undefined,
  list: [] as AutomationListItem[],
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  // Server rendering has no store to subscribe to: read each external store's current value.
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}))
vi.mock('@/sdk', () => ({
  api: { action: () => Promise.resolve(null) },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  errorMessage: (error: unknown) => String(error),
  formatDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
  formatTime: (date: Date) => date.toISOString(),
  shortenPath: (path: string) => path,
  useAction: (_ref: unknown, args: { id?: string; lines?: number; schedule?: unknown }) => ({
    data:
      args.schedule !== undefined
        ? { description: 'Every 15 minutes' }
        : args.lines === undefined
          ? { path: `/automations/${args.id}/run`, text: '#!/bin/sh' }
          : { text: 'checking\nFIRE build green' },
    refetch: () => Promise.resolve(undefined),
  }),
  useCommands: () => [],
  useConversations: () => [],
  useExtensionUiState: <T>(_key: string, initial: T) => [initial, () => {}],
  useNow: () => 1_000_000,
  useStore: (select: (state: { requested?: number; ui: object }) => unknown) =>
    select({ requested: shell.requested, ui: {} }),
  useSystem: () => undefined,
  useTasks: () => undefined,
  useUiState: <T>(_key: string, initial: T) => [initial, () => {}],
  useUltimate: () => ({
    conversationId: shell.requested,
    openPanel: () => {},
    showSurface: () => {},
    switchConversation: () => {},
  }),
  useViewport: () => 'desktop',
}))
vi.mock('../../extensions/automations/parts.tsx', async (original) => ({
  ...(await original<typeof import('../../extensions/automations/parts.tsx')>()),
  useAutomations: () => ({ data: shell.list }),
}))
// The form's agent picker reads subagent definitions; the panel test needs none of it.
vi.mock('../../extensions/automations/form.tsx', () => ({ AutomationForm: () => null }))
Object.assign(globalThis, { document: { visibilityState: 'visible' }, window: {} })
const { AutomationsPanel } = await import('../../extensions/automations/panel.tsx')
const { Chip } = await import('../../extensions/automations/chip.tsx')

const base = (id: string, createdAt: number, extra: Partial<AutomationListItem>) =>
  ({
    id,
    name: `automation ${id}`,
    enabled: true,
    createdAt,
    updatedAt: createdAt,
    subscribers: [],
    runs: [],
    fires: 0,
    alive: true,
    ...extra,
  }) satisfies AutomationListItem
const script = (
  state: NonNullable<AutomationListItem['script']>['state'],
  conversationId: number,
) => ({
  ask: 'watch it',
  once: false,
  conversationId,
  state,
})
const schedule = base('A1', 300, {
  schedule: { kind: 'every', ms: 900_000 },
  prompt: 'say hi',
  nextAt: 1_300_000,
})
const watching = base('A2', 200, { script: script('running', 41), subscribers: [7], fires: 1 })
const failed = base('ci-watch', 100, {
  scope: 'project',
  enabled: false,
  script: { ...script('failed', 42), error: 'exit 2' },
  subscribers: [7],
})

const render = () => renderToStaticMarkup(createElement(AutomationsPanel))
beforeEach(() => {
  shell.requested = undefined
  shell.list = [schedule, watching, failed]
})

it('lists both kinds, worst first: the failed script before the schedule and the watching script', () => {
  shell.requested = 7
  const html = render()
  const order = [...html.matchAll(/data-automation="([^"]+)"/g)].map((match) => match[1])
  expect(order).toEqual(['ci-watch', 'A1', 'A2'])
  expect(html).toContain('data-look="failed"')
  expect(html).toContain('Every 15 minutes')
  expect(html).toContain('aria-label="script"')
  expect(html).toContain('aria-label="schedule"')
  expect(html).toContain('1 need attention')
})

it("shows a script's output beside its watcher, with FIRE lines marked", () => {
  shell.requested = 42
  const html = render()
  expect(html).toContain('data-automation-script="ci-watch"')
  expect(html).toContain('/automations/ci-watch/run')
  expect(html).toContain('exit 2')
  expect(html).toMatch(/border-success[^>]*><span[^>]*>FIRE<\/span> build green/)
  expect(html).not.toContain('data-automation="A1"')
})

it('colours the chip by the worst state and hides it when nothing is active', () => {
  const chip = () => renderToStaticMarkup(createElement(Chip))
  expect(chip()).toContain('data-automations-chip="failed"')
  expect(chip()).toContain('3 automations')
  shell.list = [{ ...schedule, enabled: false }]
  expect(chip()).toBe('')
  shell.list = []
  expect(chip()).toBe('')
})
