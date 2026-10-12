import type { ConversationSummary, TaskGraph } from '@/sdk'
import type { AssessmentValue, OverviewRow } from '../conversations/types.ts'
import type { Workspace } from '../workspaces/types.ts'
import type { CanvasAgent } from './types.ts'

/** What a panel's outline says: the sidebar's states, waiting on a subagent, and a pending decision. */
export type Status =
  | 'working'
  | 'waiting'
  | 'queued'
  | 'decision'
  | 'done'
  | 'replied'
  | 'failed'
  | 'idle'
/** How much room an agent takes: a full panel, a folded conclusion card, or a finished subagent's pill. */
export type Shape = 'panel' | 'card' | 'pill'

export type Agent = {
  id: number
  /** The owning conversation; none for a top-level conversation, which hangs off the hub. */
  parent?: number
  summary: ConversationSummary
  status: Status
  row?: OverviewRow
  workspace?: Workspace
  /** Why it waits for a decision: its own reasons, and for a top-level conversation those of its whole tree. */
  reasons: string[]
  shape: Shape
  archived: boolean
  /** Agents folded into a conclusion card. */
  folded: number
  /** A top-level conversation's whole tree, itself first, folded or not: what its totals add up. */
  members: number[]
}

/** Labels, tooltips and colours per state. Blue has no theme token yet: Tailwind's sky stands in, in both themes. */
export const STATUS: Record<
  Status,
  { label: string; tip?: string; border: string; text: string; fill: string; stroke: string }
> = {
  working: {
    label: 'Working',
    border: 'border-brand',
    text: 'text-brand',
    fill: 'bg-brand',
    stroke: 'stroke-brand/70',
  },
  waiting: {
    label: 'Waiting on subagent',
    border: 'border-sky-600 dark:border-sky-400',
    text: 'text-sky-700 dark:text-sky-300',
    fill: 'bg-sky-600 dark:bg-sky-400',
    stroke: 'stroke-sky-600 dark:stroke-sky-400',
  },
  queued: {
    label: 'Queued',
    tip: 'Input waits for the run to pick it up',
    border: 'border-dashed border-brand/70',
    text: 'text-brand/80',
    fill: 'bg-brand/60',
    stroke: 'stroke-brand/50',
  },
  decision: {
    label: 'Needs decision',
    tip: 'Waits for you: Luna thinks it needs input, or an isolated checkout holds work not landed',
    border: 'border-warning',
    text: 'text-warning',
    fill: 'bg-warning',
    stroke: 'stroke-warning/70',
  },
  done: {
    label: 'Done',
    tip: "Done (Luna's opinion, not verified)",
    border: 'border-success',
    text: 'text-success',
    fill: 'bg-success',
    stroke: 'stroke-success/60',
  },
  replied: {
    label: 'Replied',
    tip: 'A run answered; not verified as complete',
    border: 'border-success/55',
    text: 'text-success/90',
    fill: 'bg-success/70',
    stroke: 'stroke-success/45',
  },
  failed: {
    label: 'Run failed',
    border: 'border-error',
    text: 'text-error',
    fill: 'bg-error',
    stroke: 'stroke-error/60',
  },
  idle: {
    label: 'Idle',
    border: 'border-border',
    text: 'text-muted-foreground',
    fill: 'bg-muted-foreground/50',
    stroke: 'stroke-border',
  },
}
/** What a decision reason means, for its tooltip. */
export const REASON_TIPS: Record<string, string> = {
  'needs input':
    "May need input (Luna's opinion, not verified); a subagent's question may be for its coordinator",
}
export const reasonTip = (reason: string) =>
  REASON_TIPS[reason] ?? 'Its isolated checkout is ready and has never been landed'

export const isActive = (status: Status) =>
  status === 'working' || status === 'waiting' || status === 'queued'

/** The sidebar's rule: an assessment counts only for the answer it assessed. */
export function assessmentOf(row: OverviewRow | undefined): AssessmentValue | undefined {
  const assessment = row?.assessment
  return assessment &&
    row.runState === 'done' &&
    assessment.answerId === row.answerId &&
    assessment.inputId === row.inputId
    ? assessment.value
    : undefined
}

/**
 * Why conversations still wait for a decision, so their tree must not fold away: Luna's current assessment says one
 * needs input, or its isolated checkout is ready and was never landed. The workspaces document has no current tip, so
 * a checkout landed once counts as landed even if it moved on since.
 */
export function decisions(
  members: readonly {
    id: number
    top: boolean
    assessment?: AssessmentValue
    workspace?: Pick<Workspace, 'state' | 'landed'>
  }[],
): string[] {
  const reasons = new Set<string>()
  for (const member of members) {
    if (member.assessment === 'needs_input') reasons.add('needs input')
    if (member.workspace?.state === 'ready' && member.workspace.landed === undefined)
      reasons.add(member.top ? 'workspace not landed' : `worktree #${member.id} not landed`)
  }
  return [...reasons]
}

function statusOf(busy: boolean, row: OverviewRow | undefined, feed: CanvasAgent | undefined) {
  if (busy) return feed?.waitingOn?.length ? 'waiting' : 'working'
  if (row?.runState === 'queued') return 'queued'
  if (row?.runState === 'error') return 'failed'
  if (row?.runState !== 'done') return 'idle'
  return assessmentOf(row) === 'done' ? 'done' : 'replied'
}

export type Inputs = {
  conversations: readonly ConversationSummary[]
  tasks: TaskGraph | undefined
  agents: Readonly<Record<string, CanvasAgent>>
  rows: Readonly<Record<string, OverviewRow>>
  workspaces: Readonly<Record<string, Workspace>>
  archived: readonly number[]
  showArchived: boolean
  /** The shown conversation: its tree stays open and it keeps a full panel. */
  shown: number | undefined
}

/**
 * The agents on the map: top-level conversations that have a message or work, without archived ones unless asked for
 * (or shown), and below them the conversations they own (a subagent has an owner task; a history fork does not, and
 * stays off the map). Ordered by id, so a newcomer always comes last among its siblings. Active agents and those
 * waiting for a decision keep full panels; finished subagents shrink to pills, and a tree with nothing active and
 * nothing to decide folds into its conclusion card, unless it holds the shown conversation.
 */
export function agentsOf(inputs: Inputs): Agent[] {
  const { conversations, tasks, agents, rows, workspaces, archived, showArchived, shown } = inputs
  const foreground = new Set<number>(
    Object.values(tasks?.tasks ?? {})
      .filter((task) => !task.background)
      .map((task) => task.conversationId),
  )
  // As the sidebar: the task graph reflects the run, the summary list can lag.
  const busy = (summary: ConversationSummary) =>
    tasks ? foreground.has(summary.id) || rows[summary.id]?.runState === 'working' : summary.busy
  const children = new Map<number, ConversationSummary[]>()
  for (const summary of conversations.toSorted((a, b) => a.id - b.id)) {
    const parent = summary.parentConversationId
    if (parent === undefined || summary.ownerTaskId === undefined) continue
    children.set(parent, [...(children.get(parent) ?? []), summary])
  }
  const result: Agent[] = []
  for (const top of conversations.toSorted((a, b) => a.id - b.id)) {
    if (top.parentConversationId !== undefined || (top.inputAt === undefined && !busy(top)))
      continue
    const tree: Agent[] = []
    const visit = (summary: ConversationSummary, parent?: number) => {
      const row = rows[summary.id]
      const workspace = workspaces[String(summary.id)]
      const own = decisions([
        { id: summary.id, top: parent === undefined, assessment: assessmentOf(row), workspace },
      ])
      const base = statusOf(busy(summary), row, agents[summary.id])
      tree.push({
        id: summary.id,
        parent,
        summary,
        status:
          base === 'done' || base === 'replied' || base === 'idle'
            ? own.length
              ? 'decision'
              : base
            : base,
        row,
        workspace,
        reasons: own,
        shape: 'panel',
        archived: false,
        folded: 0,
        members: [],
      })
      for (const child of children.get(summary.id) ?? []) visit(child, summary.id)
    }
    visit(top)
    const [head, ...rest] = tree
    const holdsShown = tree.some((agent) => agent.id === shown)
    head.archived = archived.includes(top.id)
    if (head.archived && !showArchived && !holdsShown) continue
    head.members = tree.map((agent) => agent.id)
    head.reasons = [...new Set(tree.flatMap((agent) => agent.reasons))]
    if (!isActive(head.status) && head.status !== 'failed' && head.reasons.length)
      head.status = 'decision'
    const settled = !tree.some((agent) => isActive(agent.status)) && !head.reasons.length
    if (settled && !holdsShown) {
      result.push({ ...head, shape: 'card', folded: rest.length })
      continue
    }
    result.push(head)
    for (const agent of rest)
      result.push({
        ...agent,
        shape:
          isActive(agent.status) || agent.reasons.length || agent.id === shown ? 'panel' : 'pill',
      })
  }
  return result
}

/** How a panel names its agent: the root is `main`; others by title, else `#id`. */
export const nameOf = (summary: ConversationSummary) =>
  summary.title ?? (summary.id === 1 ? 'main' : `#${summary.id}`)

/** One line of what the agent does now, or did last. */
export function activityOf(agent: Agent, feed: CanvasAgent | undefined) {
  if (agent.status === 'working' || agent.status === 'waiting') {
    const running = feed?.tools.findLast((tool) => tool.status === 'running')
    if (running) return running.label
    if (feed?.thinking && feed.thinking.at > (feed.writing?.at ?? 0)) return 'Thinking…'
    return feed?.writing ? 'Writing…' : 'Starting…'
  }
  const { row } = agent
  return (
    (agent.parent === undefined ? (row?.summary ?? row?.activity) : row?.activity) ??
    feed?.writing?.text.replace(/\s+/g, ' ') ??
    'No reply yet'
  )
}
