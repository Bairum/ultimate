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
/** `ultimate.canvas` on the root conversation: the activity of each agent, keyed by conversation id. */
export type CanvasState = { agents: Record<string, CanvasAgent> }
