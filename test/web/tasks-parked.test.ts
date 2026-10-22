import { createElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ConversationId, TaskGraphNode, TaskId } from '@earendil-works/pi-durable'

const { action } = vi.hoisted(() => ({
  action: vi.fn<(...args: unknown[]) => Promise<null>>(() => Promise.resolve(null)),
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  // Lets the test call a component outside a render to reach its click handler.
  useState: <T>(initial: T) => [initial, () => {}],
}))
vi.mock('@/sdk', () => ({
  api: { action },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (extension: unknown) => extension,
  formatDuration: (ms: number) => `${ms}ms`,
  provide: () => ({}),
  RunStart: {},
}))
vi.mock('@/components/ai/tool', () => ({
  ToolStatusIcon: ({ state }: { state: string }) => createElement('i', { 'data-state': state }),
}))
vi.mock('../../extensions/workspaces/ui.tsx', () => ({}))
vi.mock('../../extensions/conversations/ui.tsx', () => ({}))
vi.mock('../../extensions/plan/ui.tsx', () => ({}))
const { RetryButton, TaskRow } = await import('../../extensions/tasks/web.tsx')
const { RetryAction } = await import('../../extensions/tasks/refs.ts')

const task = (blocked?: TaskGraphNode['blocked']): TaskGraphNode => ({
  id: 7 as TaskId,
  kind: 'pi.generation',
  conversationId: 3 as ConversationId,
  background: false,
  abortRequested: false,
  state: { status: 'running', phase: 'stream' },
  conversations: [],
  ...(blocked ? { blocked } : {}),
})
const tree = {
  children: new Map(),
  roots: new Map(),
  summaries: new Map(),
  tools: new Map(),
  started: {},
  features: new Map(),
  now: 0,
}
const row = (node: TaskGraphNode) =>
  renderToStaticMarkup(createElement(TaskRow, { task: node, tree, depth: 0 }) as ReactNode)

it('shows a parked task with its reason and a Retry button', () => {
  const html = row(task('restart_limit'))
  expect(html).toContain('parked after 5 crashes')
  expect(html).toContain('data-state="interrupted"')
  expect(html).toContain('data-retry="7"')
  expect(row(task())).not.toContain('data-retry')
})

it('names another blocked reason without offering Retry, which only runs parked tasks', () => {
  const html = row(task('missing_task'))
  expect(html).toContain('blocked · missing task')
  expect(html).not.toContain('data-retry')
})

it('Retry calls the retry action with the task id', () => {
  const button = RetryButton({ id: 7 }) as ReactElement<{ onClick: () => void }>
  button.props.onClick()
  expect(action).toHaveBeenCalledWith(RetryAction, { id: 7 })
})
