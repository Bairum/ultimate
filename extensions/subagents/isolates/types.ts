export type Isolate = {
  kind: 'worktree'
  path: string
  branch: string
  base: string
  state: 'active' | 'discarded'
  landed?: string
}
export type CreatedIsolate = { cwd: string; record: Isolate }
