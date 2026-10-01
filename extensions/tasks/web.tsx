import { ListTreeIcon, MessageSquareIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ToolStatusIcon } from '@/components/ai/tool'
import {
  cn,
  defineWebExtension,
  formatDuration,
  useConversation,
  useConversations,
  useNow,
  useTasks,
  useUltimate,
} from '@/sdk'
import type { ConversationSummary, TaskGraph, TaskGraphNode } from '@/sdk'

/** When this page first saw each task, for its age. */
const seen = new Map<number, number>()

interface Tree {
  /** Live tasks by owner task id. */
  children: Map<number, TaskGraphNode[]>
  /** Conversation-owned tasks by conversation id. */
  roots: Map<number, TaskGraphNode[]>
  summaries: Map<number, ConversationSummary>
  /** Tool names of the shown conversation's tool tasks. */
  tools: Map<number, string>
}

function build(graph: TaskGraph | undefined, conversations: readonly ConversationSummary[]) {
  const tasks = Object.values(graph?.tasks ?? {}).toSorted((a, b) => a.id - b.id)
  const now = Date.now()
  for (const task of tasks) if (!seen.has(task.id)) seen.set(task.id, now)
  const children = new Map<number, TaskGraphNode[]>()
  const roots = new Map<number, TaskGraphNode[]>()
  for (const task of tasks) {
    const [map, key] = task.owner == null ? [roots, task.conversationId] : [children, task.owner]
    map.set(key, [...(map.get(key) ?? []), task])
  }
  // Conversations a live task owns appear under that task; the rest are top-level.
  const owned = new Set<number>(tasks.flatMap((task) => task.conversations))
  const top = [...roots.keys()].filter((id) => !owned.has(id)).toSorted((a, b) => a - b)
  return {
    tasks,
    top,
    children,
    roots,
    summaries: new Map(conversations.map((summary) => [summary.id, summary])),
  }
}

function status(task: TaskGraphNode): {
  text: ReactNode
  tone?: string
  icon: 'running' | 'pending' | 'done' | 'interrupted'
} {
  const { state } = task
  switch (state.status) {
    case 'pending':
      return { text: 'pending', icon: 'pending' }
    case 'running':
      return { text: state.phase, icon: 'running', tone: 'text-foreground/80' }
    case 'waiting':
      return {
        text: (
          <>
            {state.phase} · waiting on{' '}
            <span className="text-foreground/70">{state.on.map((id) => `#${id}`).join(' ')}</span>
            {state.on.length > 1 && (
              <span className="text-muted-foreground/60"> ({state.policy})</span>
            )}
          </>
        ),
        icon: 'pending',
      }
    default:
      return {
        text: `completing → ${state.outcome}`,
        icon: state.outcome === 'completed' ? 'done' : 'interrupted',
      }
  }
}

function TaskRow({ task, tree, depth }: { task: TaskGraphNode; tree: Tree; depth: number }) {
  const now = useNow(1000)
  const { text, tone, icon } = status(task)
  const kind = task.kind.replace(/^pi\./, '')
  const tool = tree.tools.get(task.id)
  const age = now - (seen.get(task.id) ?? now)
  return (
    <>
      <div
        className="flex h-6 min-w-0 items-center gap-1.5 pr-3 font-mono text-[11.5px]"
        style={{ paddingLeft: `${0.75 + depth * 0.9}rem` }}
      >
        <ToolStatusIcon className="size-3" state={icon} />
        <span className="shrink-0 text-foreground/90">{kind}</span>
        {tool && <span className="shrink-0 text-brand">{tool}</span>}
        <span className="shrink-0 text-muted-foreground/60">#{task.id}</span>
        <span className={cn('min-w-0 truncate text-muted-foreground', tone)}>{text}</span>
        {task.background && (
          <span className="shrink-0 rounded-sm border border-border/80 px-1 text-[10px] text-muted-foreground">
            bg
          </span>
        )}
        {task.abortRequested && (
          <span className="shrink-0 text-[10.5px] text-warning">aborting</span>
        )}
        <span className="ml-auto shrink-0 pl-2 text-[10.5px] text-muted-foreground/50 tabular-nums">
          {age >= 1000 ? formatDuration(age).replace(/\.\ds$/, 's') : ''}
        </span>
      </div>
      {(tree.children.get(task.id) ?? []).map((child) => (
        <TaskRow depth={depth + 1} key={child.id} task={child} tree={tree} />
      ))}
      {task.conversations.map((id) => (
        <ConversationRow depth={depth + 1} id={id} key={`c${id}`} tree={tree} />
      ))}
    </>
  )
}

function ConversationRow({ id, tree, depth }: { id: number; tree: Tree; depth: number }) {
  const { conversationId, switchConversation } = useUltimate()
  const summary = tree.summaries.get(id)
  const shown = conversationId === id
  return (
    <>
      <button
        className={cn(
          'flex h-6 w-full min-w-0 items-center gap-1.5 pr-3 text-left font-mono text-[11.5px] transition-colors hover:bg-accent/50',
          shown && 'bg-accent/60',
        )}
        onClick={() => switchConversation(id)}
        style={{ paddingLeft: `${0.75 + depth * 0.9}rem` }}
        title={shown ? 'Shown' : 'Show this conversation'}
        type="button"
      >
        <MessageSquareIcon
          className={cn('size-3 shrink-0', shown ? 'text-brand' : 'text-muted-foreground')}
        />
        <span className="shrink-0 text-foreground">
          {id === 1 ? 'main' : (summary?.agent ?? 'conversation')}
        </span>
        <span className="shrink-0 text-muted-foreground/60">#{id}</span>
        {summary?.title && id !== 1 && (
          <span className="min-w-0 truncate font-sans text-[12px] text-muted-foreground">
            {summary.title}
          </span>
        )}
        {summary?.background && (
          <span className="shrink-0 rounded-sm border border-border/80 px-1 text-[10px] text-muted-foreground">
            bg
          </span>
        )}
      </button>
      {(tree.roots.get(id) ?? []).map((task) => (
        <TaskRow depth={depth + 1} key={task.id} task={task} tree={tree} />
      ))}
    </>
  )
}

function TasksPanel() {
  const graph = useTasks()
  const conversations = useConversations()
  const { live } = useConversation()
  const { tasks, top, ...rest } = build(graph, conversations)
  const tree: Tree = {
    ...rest,
    tools: new Map(
      (live.tools ?? []).flatMap((slot) =>
        slot.taskId === undefined ? [] : [[slot.taskId, slot.name]],
      ),
    ),
  }
  const running = tasks.filter((task) => task.state.status === 'running').length
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 px-3 pb-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Task graph
        <span className="ml-auto tracking-normal normal-case text-muted-foreground/70">
          {tasks.length} live{running > 0 && ` · ${running} running`}
        </span>
      </div>
      {top.map((id) => (
        <ConversationRow depth={0} id={id} key={id} tree={tree} />
      ))}
      {tasks.length === 0 && (
        <div className="px-3 py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
          idle · no live tasks
        </div>
      )}
    </div>
  )
}

export default defineWebExtension({
  panels: [{ id: 'tasks', title: 'Tasks', icon: ListTreeIcon, component: TasksPanel, order: -5 }],
  commands: [
    {
      id: 'tasks.open',
      title: 'Show the task graph',
      keys: 'mod+k g',
      run: (context) => context.openPanel('tasks'),
    },
  ],
})
