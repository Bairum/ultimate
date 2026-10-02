import { Type } from '@earendil-works/pi-ai'
import { defineDoc, defineExtension, defineTool, section } from '@earendil-works/pi-durable'

export type Task = {
  key: string
  title: string
  role: 'worker' | 'scout' | 'reviewer'
  description: string
  deps: string[]
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'canceled'
  child?: number
  notes: { at: string; text: string }[]
}
export type Epic = {
  key: string
  title: string
  body: string
  status: 'planning' | 'in_progress' | 'done' | 'blocked'
  verdict?: string
  tasks: Record<string, Task>
}
export const Plan = defineDoc<{ next: number; epics: Record<string, Epic> }>({
  kind: 'ultimate.plan',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ next: 1, epics: {} }),
})
export const docs = [Plan]
// Commit the receipt with the edit, closing the crash window before api.memo stores the result.
const Receipt = defineDoc<{ text?: string }>({
  kind: 'ultimate.plan.receipt',
  version: 1,
  scope: 'task',
  initial: () => ({}),
})
const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const required = (value: string | undefined, field: string) => {
  if (value === undefined) throw new Error(`${field} is required`)
  return value
}

export default defineExtension({
  name: 'plan',
  sections: [
    section('plan', async ({ read, conversationId }, context) => {
      const plan = await read.snapshot(Plan, conversationId, context)
      const lines = Object.values(plan?.epics ?? {})
        .filter((epic) => epic.status !== 'done')
        .flatMap((epic) => [
          `${epic.key} ${epic.status} ${epic.title}`,
          ...Object.values(epic.tasks).map(
            (task) =>
              `${task.key} ${task.status} ${task.title}` +
              (task.deps.length ? ` deps:${task.deps.join(',')}` : '') +
              (task.child !== undefined ? ` child:${task.child}` : ''),
          ),
        ])
      return lines.length ? lines.join('\n') : undefined
    }),
  ],
  tools: [
    defineTool({
      name: 'plan',
      description:
        'Maintain the durable epic/task ledger. create {title,body}; add {epic,title,role,description,deps?}; update {key,status?,title?,description?,body?,child?,verdict?}; note {key,text} adds a task note; show {key?} reads an epic, task, or the whole ledger. Epic bodies use Request, Selected approach, Intent, Scope (in/out), binary Acceptance criteria, Implementation, Verification, Risks. Task descriptions use Outcome, Scope, Non-goals, Files, Acceptance criteria with a verification command, Constraints. Epic statuses: planning, in_progress, done, blocked. Task statuses: backlog, todo, in_progress, in_review, done, blocked, canceled. child links a conversation number; deps are task keys. Read full plans with show; the prompt contains only a compact ledger.',
      replay: 'safe',
      parameters: Type.Object({
        action: Type.Union(['create', 'add', 'update', 'note', 'show'].map((v) => Type.Literal(v))),
        title: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        epic: Type.Optional(Type.String()),
        role: Type.Optional(
          Type.Union(['worker', 'scout', 'reviewer'].map((v) => Type.Literal(v))),
        ),
        description: Type.Optional(Type.String()),
        deps: Type.Optional(Type.Array(Type.String())),
        key: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        child: Type.Optional(Type.Integer({ minimum: 1 })),
        verdict: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
      }),
      execute: async (args, api, context) => {
        const cached = await api.memo<ReturnType<typeof reply>>('result', context)
        if (cached) return cached
        const text = await api.commit(async (tx) => {
          const receipt = await tx.doc(Receipt, api.taskId)
          if (receipt.text !== undefined) return receipt.text
          const plan = await tx.doc(Plan, api.conversationId)
          const lookup = (key: string) => {
            const epicKey = key.split('.')[0]
            const epic = Object.hasOwn(plan.epics, epicKey) ? plan.epics[epicKey] : undefined
            const item = key.includes('.')
              ? epic && Object.hasOwn(epic.tasks, key)
                ? epic.tasks[key]
                : undefined
              : epic
            if (!item) throw new Error(`Unknown key: ${key}`)
            return item
          }
          let result: unknown
          if (args.action === 'create') {
            const title = required(args.title, 'title')
            const body = required(args.body, 'body')
            const key = `E${plan.next++}`
            plan.epics[key] = { key, title, body, status: 'planning', tasks: {} }
            result = plan.epics[key]
          } else if (args.action === 'add') {
            const epic = lookup(required(args.epic, 'epic'))
            if (!('tasks' in epic)) throw new Error('epic must identify an epic')
            const title = required(args.title, 'title')
            const description = required(args.description, 'description')
            if (!args.role) throw new Error('role is required')
            for (const dep of args.deps ?? []) {
              if (!('notes' in lookup(dep))) throw new Error('deps must identify tasks')
            }
            const key = `${epic.key}.${Object.keys(epic.tasks).length + 1}`
            epic.tasks[key] = {
              key,
              title,
              description,
              role: args.role,
              deps: args.deps ?? [],
              status: 'backlog',
              notes: [],
            }
            result = epic.tasks[key]
          } else if (args.action === 'show') {
            result = args.key === undefined ? plan : lookup(args.key)
          } else {
            const item = lookup(required(args.key, 'key'))
            const task = 'notes' in item
            if (args.action === 'note') {
              if (!task) throw new Error('note requires a task key')
              item.notes.push({ at: new Date().toISOString(), text: required(args.text, 'text') })
            } else {
              const statuses = task
                ? ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'canceled']
                : ['planning', 'in_progress', 'done', 'blocked']
              if (args.status !== undefined && !statuses.includes(args.status))
                throw new Error(`Invalid status for ${item.key}: ${args.status}`)
              if (task && (args.body !== undefined || args.verdict !== undefined))
                throw new Error('body and verdict require an epic key')
              if (!task && (args.description !== undefined || args.child !== undefined))
                throw new Error('description and child require a task key')
              if (args.status !== undefined) item.status = args.status as typeof item.status
              if (args.title !== undefined) item.title = args.title
              if (task) {
                if (args.description !== undefined) item.description = args.description
                if (args.child !== undefined) item.child = args.child
              } else {
                if (args.body !== undefined) item.body = args.body
                if (args.verdict !== undefined) item.verdict = args.verdict
              }
            }
            result = item
          }
          receipt.text = JSON.stringify(result)
          return receipt.text
        }, context)
        return api.memo('result', reply(text), context)
      },
    }),
  ],
})
