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
export type WorkspaceIndex = { items: Record<string, Workspace> }
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
