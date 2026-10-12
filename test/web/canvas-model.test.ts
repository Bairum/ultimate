import { expect, it } from 'vitest'
import { agentsOf, decisions } from '../../extensions/canvas/model.tsx'
import type { Inputs } from '../../extensions/canvas/model.tsx'
import type { OverviewRow } from '../../extensions/conversations/types.ts'
import type { Workspace } from '../../extensions/workspaces/types.ts'

const checkout = (state: Workspace['state'], landed?: string): Workspace => ({
  path: '/w',
  branch: 'b',
  base: 'a',
  source: '/s',
  target: 'main',
  state,
  ...(landed ? { landed } : {}),
})

it('needs a decision for Luna’s needs-input and for ready checkouts never landed', () => {
  expect(decisions([{ id: 1, top: true, assessment: 'done' }])).toEqual([])
  expect(decisions([{ id: 1, top: true, assessment: 'needs_input' }])).toEqual(['needs input'])
  expect(decisions([{ id: 1, top: true, workspace: checkout('ready') }])).toEqual([
    'workspace not landed',
  ])
  expect(decisions([{ id: 12, top: false, workspace: checkout('ready') }])).toEqual([
    'worktree #12 not landed',
  ])
  // Landed, being prepared, failed or removed: nothing waits on it.
  for (const workspace of [
    checkout('ready', 'abc123'),
    checkout('preparing'),
    checkout('failed'),
    checkout('removed'),
  ])
    expect(decisions([{ id: 3, top: false, workspace }])).toEqual([])
  // A tree's reasons, each once.
  expect(
    decisions([
      { id: 1, top: true, assessment: 'needs_input' },
      { id: 2, top: false, assessment: 'needs_input', workspace: checkout('ready') },
      { id: 3, top: false, workspace: checkout('ready', 'abc123') },
    ]),
  ).toEqual(['needs input', 'worktree #2 not landed'])
})

const replied = (
  inputId: number,
  answerId: number,
  value?: 'done' | 'needs_input',
): OverviewRow => ({
  runState: 'done',
  inputId,
  answerId,
  ...(value && { assessment: { inputId, answerId, value } as OverviewRow['assessment'] }),
})
const inputs = (overrides: Partial<Inputs>): Inputs => ({
  conversations: [
    { id: 1, busy: false, inputAt: 1, title: 'Review' },
    { id: 2, busy: false, inputAt: 2, parentConversationId: 1, ownerTaskId: 7, label: 'worker' },
    { id: 3, busy: false, inputAt: 3, parentConversationId: 1, ownerTaskId: 8, label: 'scout' },
    // A history fork has a parent but no owner task: it stays off the map.
    { id: 4, busy: false, inputAt: 4, parentConversationId: 1 },
  ],
  tasks: { tasks: {} },
  agents: {},
  rows: { 1: replied(10, 11, 'done'), 2: replied(20, 21), 3: replied(30, 31) },
  workspaces: {},
  archived: [],
  showArchived: false,
  shown: undefined,
  ...overrides,
})
const shapes = (overrides: Partial<Inputs>) =>
  agentsOf(inputs(overrides)).map(({ id, shape, status, reasons }) => ({
    id,
    shape,
    status,
    reasons,
  }))

it('folds a settled tree into its conclusion card, but not while a decision waits or it is shown', () => {
  expect(agentsOf(inputs({}))).toEqual([
    expect.objectContaining({
      id: 1,
      shape: 'card',
      status: 'done',
      folded: 2,
      members: [1, 2, 3],
    }),
  ])
  // A finished worker's checkout was never landed: the tree stays open, the worker keeps its panel and says why.
  expect(shapes({ workspaces: { 2: checkout('ready') } })).toEqual([
    { id: 1, shape: 'panel', status: 'decision', reasons: ['worktree #2 not landed'] },
    { id: 2, shape: 'panel', status: 'decision', reasons: ['worktree #2 not landed'] },
    { id: 3, shape: 'pill', status: 'replied', reasons: [] },
  ])
  // Shown, the tree opens; its finished subagents are pills.
  expect(shapes({ shown: 1 }).map(({ id, shape }) => [id, shape])).toEqual([
    [1, 'panel'],
    [2, 'pill'],
    [3, 'pill'],
  ])
  // A subagent still working keeps the tree open and its own panel; its parent waits on it.
  expect(
    shapes({
      tasks: {
        tasks: { 9: { conversationId: 3 }, 10: { conversationId: 1 } },
      } as unknown as Inputs['tasks'],
      agents: { 1: { tools: [], edits: [], waitingOn: [3], updatedAt: 0 } },
    }).map(({ id, shape, status }) => [id, shape, status]),
  ).toEqual([
    [1, 'panel', 'waiting'],
    [2, 'pill', 'replied'],
    [3, 'panel', 'working'],
  ])
  // Archived trees stay off the map unless asked for.
  expect(shapes({ archived: [1] })).toEqual([])
  expect(agentsOf(inputs({ archived: [1], showArchived: true }))[0]).toMatchObject({
    archived: true,
  })
})
