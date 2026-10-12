import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import type { Workspace } from '../../shared/protocol.ts'

export const WorkspaceDoc = defineDoc<{ workspace?: Workspace; preparationTask?: TaskId }>({
  kind: 'ultimate.workspace',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export type LifecycleResult = {
  text: string
  landed?: string
  paths?: string[]
  needsRestart?: boolean
  state?: 'discarded'
}
export const LifecycleQueue = defineDoc<{
  checkouts: Record<string, TaskId>
  predecessors: Record<string, TaskId>
  children: Record<string, TaskId[]>
  requests: Record<string, TaskId<LifecycleResult>>
  creations: Record<string, { id: ConversationId; source: string }>
  hostApply?: {
    id: ConversationId
    caller: TaskId
    source: string
    path: string
    branch: string
    tip: string
    handoff?: boolean
  }
}>({
  kind: 'ultimate.workspace-queue',
  version: 1,
  scope: 'session',
  initial: () => ({ checkouts: {}, predecessors: {}, children: {}, requests: {}, creations: {} }),
})
