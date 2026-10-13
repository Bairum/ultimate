export type Workspace = {
  path: string
  branch: string
  base: string
  source: string
  target: string
  state: 'preparing' | 'ready' | 'failed' | 'removed'
  error?: string
  landed?: string
}
/** One `workspace submit`, waiting for or being processed by its source's lander. */
export type QueueEntry = {
  id: string
  conversationId: number
  source: string
  target: string
  tip: string
  at: number
  state: 'queued' | 'landing'
  step?: string
}
export type WorkspaceIndex = {
  items: Record<string, Workspace>
  queue: QueueEntry[]
  /** Live lander task per source checkout. */
  landers: Record<string, number>
}
export type WorkspaceInfo = Workspace & {
  ahead: number | null
  tip: string | null
  sourceTip: string | null
  currentBranch: string | null
  sourceBranch: string | null
}
export type LandResult = {
  text: string
  landed?: string
  commits?: string[]
  paths?: string[]
  needsRestart?: boolean
}
export type SubmitResult = { text: string; id: string; position: number }
