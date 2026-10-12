import { expect, it } from 'vitest'
import { agentsOf } from '../../extensions/canvas/model.tsx'
import type { Inputs } from '../../extensions/canvas/model.tsx'
import type { CanvasConclusion, CanvasReason } from '../../extensions/canvas/types.ts'
import type { OverviewRow } from '../../extensions/conversations/types.ts'

const unlanded: CanvasReason = {
  kind: 'unlanded',
  conversationId: 2,
  detail: 'W2: 1 commit not landed',
}
const concluded: CanvasConclusion = {
  headline: 'Reviewed and landed',
  commits: 2,
  pushed: false,
  landed: ['Review fixes'],
  subagents: 2,
  files: 3,
  screenshot: false,
  through: 31,
  at: 1,
}

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
  trees: {},
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
  // Its conclusion rides on the card.
  expect(agentsOf(inputs({ trees: { 1: { conclusion: concluded } } }))[0]).toMatchObject({
    shape: 'card',
    conclusion: concluded,
  })
  // A finished worker's commits were never landed: the tree stays open, the worker keeps its panel and says why.
  const decision = { 1: { decision: { reasons: [unlanded] }, conclusion: concluded } }
  expect(shapes({ trees: decision })).toEqual([
    { id: 1, shape: 'panel', status: 'decision', reasons: [unlanded] },
    { id: 2, shape: 'panel', status: 'decision', reasons: [unlanded] },
    { id: 3, shape: 'pill', status: 'replied', reasons: [] },
  ])
  // While anything in the tree works, unlanded work is expected: no reasons show, not even a stale record's.
  expect(
    shapes({
      trees: decision,
      tasks: { tasks: { 9: { conversationId: 2 } } } as unknown as Inputs['tasks'],
    }),
  ).toEqual([
    { id: 1, shape: 'panel', status: 'done', reasons: [] },
    { id: 2, shape: 'panel', status: 'working', reasons: [] },
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
