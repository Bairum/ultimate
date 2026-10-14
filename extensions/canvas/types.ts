/** One tool call; `label` is a short summary such as `read server/api.ts:436-525`, `$ pnpm test` or `edit web.tsx`. */
export type CanvasTool = {
  /** The tool call id. */
  id: string
  name: string
  label: string
  status: 'running' | 'done' | 'error'
  /** When the call was made (ms). */
  at: number
}
/** A file edit or write; a write counts every line it wrote as added. */
export type CanvasEdit = { path: string; added: number; removed: number; at: number }
/** The tail of a text, and when it last changed (ms). */
export type CanvasText = { text: string; at: number }
/** An agent's model and spend; the context window comes from the model list, as the status line's. */
export type CanvasUsage = {
  /** The model of its `pi.agent`, when set. */
  provider?: string
  model?: string
  /** Tokens in context: the latest answer's prompt since the last compaction or reset; absent while unknown. */
  context?: number
  /** Totals of its own `pi.usage`, every model and tool. */
  input: number
  output: number
  cacheRead: number
  cost: number
}
export type CanvasAgent = {
  /** The last 8 tool calls, newest last. */
  tools: CanvasTool[]
  /** The tail (240 characters) of the latest or streaming thinking. */
  thinking?: CanvasText
  /** The tail (400 characters) of the latest or streaming assistant text. */
  writing?: CanvasText
  /** The last 4 file edits and writes, newest last. */
  edits: CanvasEdit[]
  /** Child conversations this agent waits on: a running foreground subagent start or message, or a wait. */
  waitingOn?: number[]
  usage?: CanvasUsage
  /** The latest change (ms). */
  updatedAt: number
}
/** Why an idle tree waits for a decision: the summary model thinks one of its conversations needs input, or a checkout holds commits never landed. */
export type CanvasReason = {
  kind: 'needs_input' | 'unlanded'
  conversationId: number
  /** `needs input`, or `#12: 3 commits not landed`. */
  detail: string
}
/** The small fields of a tree's latest conclusion the map needs; the full one comes from the `conclusion` action. */
export type CanvasConclusion = {
  headline: string
  commits: number
  pushed: boolean
  /** Names of the features or fixes that landed, in the summary model's words. */
  landed: string[]
  subagents: number
  files: number
  screenshot: boolean
  /** The newest entry it covers. */
  through: number
  /** When it concluded (ms). */
  at: number
  /** The tree has worked since; a new conclusion follows once it settles. */
  stale?: true
}
/** A top-level conversation's tree: what it waits for, or how it concluded. */
export type CanvasTree = { decision?: { reasons: CanvasReason[] }; conclusion?: CanvasConclusion }
/** `ultimate.canvas` on the root conversation: the activity of each agent and the state of each tree, keyed by conversation id. */
export type CanvasState = { agents: Record<string, CanvasAgent>; trees: Record<string, CanvasTree> }

/** A commit made in the tree, from `git commit` output or a land result. */
export type ConclusionCommit = {
  sha: string
  subject: string
  /** The branch `git commit` reported. */
  branch?: string
  /** It appeared in a land result. */
  landed?: true
}
/** What a concluded tree asked for, did and produced; stored on its top-level conversation. */
export type Conclusion = {
  headline: string
  /** Two to four sentences: what was asked, what was done, the outcome. */
  summary: string
  landed: string[]
  commits: ConclusionCommit[]
  /** A `git push` succeeded. */
  pushed: boolean
  /** Edited and written paths, and landed paths. */
  files: string[]
  subagents: { id: number; label?: string }[]
  /** From the first message to the last (ms). */
  duration: number
  /** The tree's last screenshot, about 480 pixels wide. */
  thumbnail?: { mimeType: string; data: string; width: number; height: number }
  through: number
  at: number
}
