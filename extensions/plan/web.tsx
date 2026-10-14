import {
  ChevronRightIcon,
  ClipboardListIcon,
  GitBranchIcon,
  GitMergeIcon,
  SquareArrowOutUpRightIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { MessageResponse } from '@/components/ai/message'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  cn,
  defineWebExtension,
  formatTime,
  useAction,
  useConversations,
  useToolDuration,
  useUltimate,
} from '@/sdk'
import type { ConversationSummary, DocumentProps, ToolCallView } from '@/sdk'
import { stateLabel, useWorkspaceAction, useWorkspaces } from '../workspaces/data.tsx'
import type { WorkspaceInfo } from '../workspaces/types.ts'
import { StatusIcon, statusOf } from './chip.tsx'

/** The `ultimate.plan` document, as `server.ts` defines it. */
type Task = {
  key: string
  title: string
  role: string
  description: string
  deps: string[]
  status: string
  child?: number
  verdict?: string
  notes: { at: string; text: string }[]
}
type Epic = {
  key: string
  title: string
  body: string
  status: string
  verdict?: string
  tasks: Record<string, Task>
}
type Plan = { next: number; epics: Record<string, Epic> }

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm border border-border/80 px-1 font-mono text-[10px] leading-4 text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

function StatusChip({ status }: { status: string }) {
  return <Tag className={statusOf(status).tone}>{status.replace('_', ' ')}</Tag>
}

const time = (at: string) => formatTime(at)

function Note({ note, clamp }: { note: Task['notes'][number]; clamp?: boolean }) {
  return (
    <p className="flex min-w-0 gap-1.5 font-sans text-[12px] leading-snug text-muted-foreground">
      <span
        className="shrink-0 pt-px font-mono text-[10.5px] text-muted-foreground/60 tabular-nums"
        title={note.at}
      >
        {time(note.at)}
      </span>
      <span className={cn('min-w-0 break-words whitespace-pre-wrap', clamp && 'line-clamp-2')}>
        {note.text}
      </span>
    </p>
  )
}

/** Calls `refetch` when the window regains focus and when `key` changes after mount. */
function useRefresh(refetch: () => unknown, key: string) {
  const last = useRef(key)
  useEffect(() => {
    if (last.current === key) return
    last.current = key
    void refetch()
  }, [key, refetch])
  useEffect(() => {
    const refresh = () => void refetch()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refetch])
}

/**
 * The linked child's workspace: branch, state, commits ahead, and Land through the `workspaces` actions. Refetched
 * when the child or its parent settles, since either may have committed or landed.
 */
function IsolateRow({ child, parent }: { child: ConversationSummary; parent: number }) {
  const conversations = useConversations()
  const parentBusy = conversations.find((conversation) => conversation.id === parent)?.busy
  const recorded = useWorkspaces()[String(child.id)]
  const { data: isolate, refetch } = useAction<WorkspaceInfo | null>(
    'workspaces',
    'info',
    { id: child.id },
    { enabled: !!recorded },
  )
  useRefresh(() => recorded && refetch(), `${child.busy} ${parentBusy}`)
  const { pending, outcome, land } = useWorkspaceAction(child.id, refetch)
  if (!isolate) return null
  return (
    <div className="font-mono text-[11px] text-muted-foreground">
      <div className="flex h-6 min-w-0 items-center gap-1.5">
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate" title={`${isolate.branch}\n${isolate.path}`}>
          {isolate.branch}
        </span>
        <Tag
          className={cn(
            isolate.state === 'removed'
              ? 'text-muted-foreground/70'
              : isolate.landed
                ? 'border-success/40 text-success'
                : 'border-brand/40 text-brand',
          )}
        >
          {isolate.state === 'ready' && isolate.landed
            ? `Landed ${isolate.landed.slice(0, 7)}`
            : stateLabel(isolate)}
        </Tag>
        {isolate.ahead !== null && (
          <span
            className="shrink-0 text-[10.5px] text-muted-foreground/80"
            title={`${isolate.ahead} commit${isolate.ahead === 1 ? '' : 's'} on the branch that the parent checkout does not have`}
          >
            ↑{isolate.ahead}
          </span>
        )}
        {/* A landed branch with nothing new needs no button; later commits bring it back. */}
        {isolate.state === 'ready' && !(isolate.landed && isolate.ahead === 0) && (
          <Button
            className="ml-auto h-5 shrink-0 gap-1 px-1.5 text-[11px]"
            disabled={child.busy || pending !== undefined}
            onClick={() => void land()}
            size="xs"
            variant="ghost"
          >
            <GitMergeIcon className="size-3" />
            {pending ? 'Landing…' : 'Land'}
          </Button>
        )}
      </div>
      {outcome && (
        <p
          className={cn(
            'leading-snug break-words whitespace-pre-wrap',
            outcome.error && 'text-error',
          )}
        >
          {outcome.text}
        </p>
      )}
    </div>
  )
}

/** The linked child: "open #id" like the Agents tab, with a dot while it works. */
function ChildLink({ id, child }: { id: number; child?: ConversationSummary }) {
  const { switchConversation } = useUltimate()
  return (
    <Button
      className="ml-auto h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      onClick={() => switchConversation(id)}
      size="xs"
      title={child?.title ?? `Show conversation #${id}`}
      variant="ghost"
    >
      {child?.busy && (
        <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
      )}
      <SquareArrowOutUpRightIcon className="size-3" />
      open #{id}
    </Button>
  )
}

/** One task: key, title, status, role, deps, the linked child and its isolate, and the last note; click for the rest. */
function TaskRow({ task, tasks }: { task: Task; tasks: Map<string, Task> }) {
  const [open, setOpen] = useState(false)
  const { conversationId } = useUltimate()
  const conversations = useConversations()
  const child =
    task.child === undefined
      ? undefined
      : conversations.find((conversation) => conversation.id === task.child)
  const parent = child?.parentConversationId ?? conversationId
  const last = task.notes.at(-1)
  return (
    <Collapsible
      className="border-t border-border/50 first:border-t-0"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="group/task flex h-7 w-full min-w-0 items-center gap-1.5 px-3 text-left hover:bg-accent/40">
        <StatusIcon status={task.status} />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{task.key}</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px] text-foreground/90',
            task.status === 'canceled' && 'text-muted-foreground line-through',
          )}
          title={task.title}
        >
          {task.title}
        </span>
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]/task:rotate-90" />
      </CollapsibleTrigger>
      <div className="space-y-0.5 pr-3 pb-1.5 pl-8">
        <div className="flex h-5 min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <StatusChip status={task.status} />
          <Tag>{task.role}</Tag>
          {task.deps.length > 0 && (
            <span className="min-w-0 truncate">
              after{' '}
              {task.deps.map((dep, index) => (
                <span key={dep}>
                  {index > 0 && ', '}
                  <span
                    className={cn(tasks.get(dep)?.status === 'done' && 'text-success')}
                    title={tasks.get(dep)?.title}
                  >
                    {dep}
                  </span>
                </span>
              ))}
            </span>
          )}
          {task.child !== undefined && <ChildLink child={child} id={task.child} />}
        </div>
        {child && parent !== undefined && <IsolateRow child={child} parent={parent} />}
        {task.verdict && (
          <div className="rounded-md border border-border/70 bg-card/50 px-3 py-2 text-[12.5px]">
            <div className="pb-1 font-mono text-[10px] tracking-wider text-muted-foreground/80 uppercase">
              Verdict
            </div>
            <MessageResponse>{task.verdict}</MessageResponse>
          </div>
        )}
        {open ? (
          <div className="space-y-2 pt-1">
            <div className="text-[12.5px] text-foreground/90">
              <MessageResponse>{task.description}</MessageResponse>
            </div>
            {task.notes.length > 0 && (
              <div className="space-y-1">
                <div className="font-mono text-[10px] tracking-wider text-muted-foreground/80 uppercase">
                  Notes
                </div>
                {task.notes.map((note, index) => (
                  <Note key={index} note={note} />
                ))}
              </div>
            )}
          </div>
        ) : (
          last && (
            <div className="flex min-w-0 items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <Note clamp note={last} />
              </div>
              {task.notes.length > 1 && (
                <button
                  className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70 hover:text-foreground"
                  onClick={() => setOpen(true)}
                  type="button"
                >
                  {task.notes.length} notes
                </button>
              )}
            </div>
          )
        )}
      </div>
    </Collapsible>
  )
}

/** One epic: status and title, its plan folded below, the verdict when there is one, then its tasks. */
function EpicCard({ epic, tasks }: { epic: Epic; tasks: Map<string, Task> }) {
  const list = Object.values(epic.tasks)
  const done = list.filter((task) => task.status === 'done').length
  const approved = epic.verdict?.trimStart().startsWith('APPROVED')
  return (
    <section className="border-t border-border/70 first:border-t-0">
      <Collapsible className="group/epic">
        <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left hover:bg-accent/40">
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]/epic:rotate-90" />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{epic.key}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={epic.title}>
            {epic.title}
          </span>
          <StatusChip status={epic.status} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mx-3 mb-2 rounded-md border border-border/70 bg-card/50 px-3 py-2 text-[12.5px]">
            <MessageResponse>{epic.body}</MessageResponse>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {epic.verdict && (
        <div
          className={cn(
            'mx-3 mb-2 rounded-md border px-3 py-2 text-[12.5px]',
            approved ? 'border-success/40 bg-success/5' : 'border-border/70 bg-card/50',
          )}
        >
          <div
            className={cn(
              'pb-1 font-mono text-[10px] tracking-wider uppercase',
              approved ? 'text-success' : 'text-muted-foreground/80',
            )}
          >
            Verdict
          </div>
          <MessageResponse>{epic.verdict}</MessageResponse>
        </div>
      )}
      <div className="flex items-center px-3 pb-1 font-mono text-[10px] tracking-wider text-muted-foreground/80 uppercase">
        Tasks
        <span className="ml-auto tracking-normal normal-case">
          {done}/{list.length} done
        </span>
      </div>
      {list.map((task) => (
        <TaskRow key={task.key} task={task} tasks={tasks} />
      ))}
      {list.length === 0 && (
        <p className="px-3 pb-2 font-sans text-[12px] text-muted-foreground/70">No tasks yet.</p>
      )}
    </section>
  )
}

/**
 * The `ultimate.plan` document in the Documents tab: open epics first, each with its plan, verdict, and tasks, live.
 */
function PlanDocument({ value, conversationId }: DocumentProps) {
  const plan = value as unknown as Plan
  const { switchConversation } = useUltimate()
  const conversations = useConversations()
  const epics = Object.values(plan.epics ?? {})
  const ordered = [
    ...epics.filter((epic) => epic.status !== 'done'),
    ...epics.filter((epic) => epic.status === 'done'),
  ]
  const tasks = new Map(epics.flatMap((epic) => Object.values(epic.tasks)).map((t) => [t.key, t]))
  const parent = conversations.find(
    (conversation) => conversation.id === conversationId,
  )?.parentConversationId
  if (epics.length === 0)
    return (
      <p className="px-3 font-sans text-[12px] leading-relaxed text-muted-foreground/70">
        No epics yet: the agent plans work here with the <code className="font-mono">plan</code>{' '}
        tool.
        {parent !== undefined && (
          <>
            {' '}
            This is a subagent; plans live with its{' '}
            <button
              className="font-mono text-brand hover:underline"
              onClick={() => switchConversation(parent)}
              type="button"
            >
              parent #{parent}
            </button>
            .
          </>
        )}
      </p>
    )
  return ordered.map((epic) => <EpicCard epic={epic} key={epic.key} tasks={tasks} />)
}

/** One `plan` call: the action and the key it touched, with what it wrote below. */
function PlanCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const action = text(call.args.action)
  let result: { key?: string; title?: string; epics?: unknown } | undefined
  if (call.status === 'done') {
    try {
      result = JSON.parse(call.output)
    } catch {}
  }
  const key =
    text(call.args.key) ||
    (result?.epics ? 'ledger' : result?.key) ||
    (action === 'add' ? text(call.args.epic) : '')
  const changes = [
    call.args.status !== undefined && `→ ${text(call.args.status).replace('_', ' ')}`,
    typeof call.args.child === 'number' && `child #${call.args.child}`,
    ...(['title', 'description', 'body', 'verdict'] as const).filter(
      (field) => call.args[field] !== undefined,
    ),
  ].filter(Boolean)
  const detail =
    action === 'create' || action === 'add'
      ? text(call.args.title)
      : action === 'note'
        ? text(call.args.text)
        : action === 'update'
          ? changes.join(' · ')
          : ''
  const sections: [string, string][] = [
    ['Plan', text(call.args.body)],
    ['Task', text(call.args.description)],
    ['Verdict', text(call.args.verdict)],
    ['Note', text(call.args.text)],
  ]
  return (
    <Tool defaultOpen={call.status === 'error'}>
      <ToolHeader
        meta={
          <>
            {action === 'add' && text(call.args.role) && <Tag>{text(call.args.role)}</Tag>}
            {duration && <span>{duration}</span>}
          </>
        }
        name="plan"
        state={call.status}
        title={
          <>
            {action || '…'} {key && <span className="text-foreground/80">{key}</span>} {detail}
          </>
        }
      />
      <ToolContent>
        {sections.map(
          ([label, value]) =>
            value && (
              <ToolSection key={label} label={label}>
                <div className="font-sans text-[13px] text-foreground/90">
                  <MessageResponse>{value}</MessageResponse>
                </div>
              </ToolSection>
            ),
        )}
        {action === 'add' && (call.args.deps as unknown[] | undefined)?.length ? (
          <ToolSection label="Deps">{(call.args.deps as string[]).join(', ')}</ToolSection>
        ) : null}
        {(action === 'show' || call.status === 'error') && (
          <ToolOutput isError={call.status === 'error'} output={call.output} />
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({
  tools: { plan: PlanCall },
  documents: [
    { kind: 'ultimate.plan', title: 'Plan', icon: ClipboardListIcon, component: PlanDocument },
  ],
})
