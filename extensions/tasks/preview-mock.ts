// PREVIEW ONLY: removed before submit. Seeds task states the paused copy lacks (landing, schedule, blocked, long chore).
import type { ConversationId, TaskGraph, TaskGraphNode, TaskId } from '@earendil-works/pi-durable'
import type { TaskFacts } from './refs.ts'

const at = Date.now()
const node = (id: number, kind: string, conversation: number, rest: Partial<TaskGraphNode>) =>
  ({
    id: id as TaskId,
    kind,
    conversationId: conversation as ConversationId,
    background: true,
    abortRequested: false,
    state: { status: 'running', phase: 'run' },
    conversations: [],
    ...rest,
  }) as TaskGraphNode

const nodes = [
  node(9_000_001, 'workspaces.lander', 418469, { state: { status: 'running', phase: 'land' } }),
  node(9_000_002, 'ultimate.automation-scheduler', 1, {
    state: { status: 'sleeping', phase: 'sleep', until: at + 3 * 3600_000 + 12 * 60_000 },
  }),
  node(9_000_003, 'watchdog.failure', 418434, {
    state: { status: 'sleeping', phase: 'wait', until: at + 45_000 },
  }),
  node(9_000_004, 'board.delivery', 1, { state: { status: 'running', phase: 'deliver' } }),
  node(9_000_005, 'board.delivery', 1, { state: { status: 'running', phase: 'reply' } }),
  node(9_000_006, 'conversations.summary', 428039, {
    state: { status: 'running', phase: 'generate' },
  }),
  node(9_000_007, 'codemode.summary', 428055, {
    state: { status: 'pending', phase: 'summarize' },
    blocked: 'restart_limit',
  }),
  node(9_000_008, 'lineage.landing-note', 1, { state: { status: 'running', phase: 'deliver' } }),
]

const facts: Record<string, TaskFacts> = {
  9_000_001: { source: '/home/user/my-app', conversation: 428055 },
  9_000_002: { automation: 'Nightly dependency check' },
  9_000_003: { conversation: 428039 },
  9_000_004: {
    message: {
      id: 9001,
      from: 418434,
      to: 428039,
      reply: true,
      note: false,
      gist: 'Size: assessment. Read the code and history and build nothing before the go.',
    },
  },
  9_000_005: {
    message: {
      id: 9002,
      from: 418434,
      to: 429867,
      reply: true,
      note: false,
      gist: 'Which of the graveyard entries should link their commits?',
    },
  },
  9_000_008: { conversation: 428691 },
}

const started: Record<string, number> = {
  9_000_001: at - 95_000,
  9_000_004: at - 22 * 60_000,
  9_000_005: at - 4_000,
  9_000_006: at - 14 * 60_000,
  9_000_008: at - 3_000,
}

export const mockGraph = (graph: TaskGraph | undefined): TaskGraph => ({
  tasks: { ...graph?.tasks, ...Object.fromEntries(nodes.map((task) => [task.id, task])) },
})
export const mockFacts = (known: Record<string, TaskFacts>) => ({ ...known, ...facts })
export const mockStarted = (known: Record<string, number>) => ({ ...known, ...started })
