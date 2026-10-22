import { isDeepStrictEqual } from 'node:util'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context, JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { TaskId, ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ActionContext } from '../../server/actions.ts'
import { implementAction } from '../../lib/actions.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { SubagentsApi } from '../subagents/api.ts'
import {
  CreateAction,
  DeleteAction,
  DescribeAction,
  ListAction,
  PauseAction,
  ResumeAction,
  RunAction,
  UpdateAction,
} from './refs.ts'
import { describeSchedule, nextAt, parseSchedule } from './schedule.ts'
import type { Schedule } from './schedule.ts'

export type Run = {
  id: string
  firedAt: number
  conversationId?: ConversationId
  status: 'running' | 'done' | 'failed' | 'aborted' | 'skipped'
  finishedAt?: number
  answer?: string
}
export type Automation = {
  id: string
  name: string
  prompt: string
  schedule: Schedule
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextAt?: number
  scheduler?: TaskId
  runs: Run[]
  agent?: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
}
export const Automations = defineDoc<{ next: number; automations: Record<string, Automation> }>({
  kind: 'ultimate.automations',
  checkpointWhen: () => false,
  version: 1,
  scope: 'session',
  initial: () => ({ next: 1, automations: {} }),
})
const Receipt = defineDoc<{ result?: JsonValue; abort?: TaskId }>({
  kind: 'ultimate.automation-receipt',
  checkpointWhen: () => false,
  version: 1,
  scope: 'task',
  initial: () => ({}),
})
type Args = {
  action: string
  id?: string
  name?: string
  prompt?: string
  schedule?: string | Schedule
  agent?: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  runId?: string
}
type Host = Pick<
  ExtensionHost,
  | 'harness'
  | 'metadata'
  | 'ultimateRoot'
  | 'projectRoot'
  | 'userHome'
  | 'modelRuntime'
  | 'extensions'
  | 'need'
>
const owner = {
  ownership: { kind: 'conversation' as const },
  conversationId: ROOT_CONVERSATION_ID,
  background: true,
}
const terminal = {
  status: 'terminal' as const,
  outcome: { status: 'completed' as const, result: null },
}
function required(value: string | undefined, field: string) {
  if (!value?.trim()) throw new Error(`${field} is required`)
  return value.trim()
}
async function definition(host: Host, name: string) {
  const found = (
    await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
  ).definitions.find((d) => d.name === name)
  if (!found) throw new Error(`Unknown agent: ${name}`)
  return found
}

function backend(host: Host) {
  const RunTask = defineTask<
    { automation: Automation; firedAt: number },
    { phase: 'create' } | { phase: 'deliver'; conversationId: ConversationId },
    null
  >({
    name: 'ultimate.automation-run',
    version: 1,
    initial: () => ({ phase: 'create' }),
    phases: {
      create: async (task, runtime, context) => {
        try {
          const a = task.input.automation
          await validate({ action: 'run' })
          const parent = await runtime.agent(context)
          const profile = a.agent ? await definition(host, a.agent) : undefined
          await runtime.commit(async (tx) => {
            const child = await host.need(SubagentsApi).createChild(tx, {
              owner: { kind: 'task', taskId: task.id },
              definition: profile,
              parentAgent: parent,
              modelRuntime: host.modelRuntime,
              metadata: host.metadata,
              label: 'automation',
              title: `${a.name} · ${new Date(task.input.firedAt).toLocaleString()}`,
              excludeTools: a.agent ? ['automation', 'subagent'] : ['automation'],
              excludeExtensions: ['automations'],
              cwd: (await tx.doc(AgentDoc, runtime.conversationId)).cwd ?? host.projectRoot,
              model: a.model,
              thinking: a.thinking,
            })
            const run = (await tx.doc(Automations)).automations[a.id]?.runs.find(
              (r) => r.id === String(task.id),
            )
            if (run) run.conversationId = child.id
            return { status: 'running', checkpoint: { phase: 'deliver', conversationId: child.id } }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          await runtime.commit(async (tx) => {
            finish(
              await tx.doc(Automations),
              task.input.automation.id,
              String(task.id),
              'failed',
              String(error),
            )
            return terminal
          }, context)
        }
      },
      deliver: async (task, runtime, context) => {
        try {
          const child = (await runtime.conversation(task.state.checkpoint.conversationId, context))!
          const result = await (
            await child.submit(
              {
                type: 'input',
                content: task.input.automation.prompt,
                requestId: `automation-run:${task.id}`,
              },
              context,
            )
          ).wait(context)
          await runtime.commit(async (tx) => {
            const entry =
              result.status === 'done' && result.type === 'input'
                ? await tx.entry(AssistantEntry, result.answer)
                : undefined
            const answer = entry?.model?.[0]
            const text =
              answer?.role === 'assistant'
                ? answer.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
                : undefined
            finish(
              await tx.doc(Automations),
              task.input.automation.id,
              String(task.id),
              result.status === 'done'
                ? 'done'
                : result.status === 'unanswered' && result.reason === 'aborted'
                  ? 'aborted'
                  : 'failed',
              text,
            )
            return terminal
          }, context)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          await runtime.commit(async (tx) => {
            finish(
              await tx.doc(Automations),
              task.input.automation.id,
              String(task.id),
              'failed',
              String(error),
            )
            return terminal
          }, context)
        }
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        finish(await tx.doc(Automations), task.input.automation.id, String(task.id), 'aborted')
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  async function fire(tx: Tx, a: Automation, firedAt: number) {
    let running = a.runs.some((r) => r.status === 'running')
    // A long run can outlive the bounded run history.
    if (!running) {
      for (const status of ['pending', 'running', 'waiting', 'completing'] as const) {
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanTasks(
            { conversationId: ROOT_CONVERSATION_ID, kind: 'ultimate.automation-run', status },
            100,
            cursor,
          )
          if (
            page.items.some(
              (task) => (task.input as { automation: Automation }).automation.id === a.id,
            )
          )
            running = true
          cursor = page.next
        } while (cursor && !running)
        if (running) break
      }
    }
    if (running) {
      a.runs.push({ id: `skipped:${firedAt}`, firedAt, finishedAt: firedAt, status: 'skipped' })
    } else {
      const id = await tx.createTask(
        RunTask,
        { automation: { ...(JSON.parse(JSON.stringify(a)) as Automation), runs: [] }, firedAt },
        owner,
      )
      a.runs.push({ id: String(id), firedAt, status: 'running' })
    }
    a.runs = a.runs.slice(-50)
    return a.runs.at(-1)!
  }
  const Scheduler = defineTask<
    { id: string },
    { phase: 'plan' } | { phase: 'sleep'; until: number } | { phase: 'fire'; until: number },
    null
  >({
    name: 'ultimate.automation-scheduler',
    version: 1,
    initial: () => ({ phase: 'plan' }),
    phases: {
      plan: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const a = (await tx.doc(Automations)).automations[task.input.id]
          if (!a?.enabled || a.scheduler !== task.id) return terminal
          const until =
            a.nextAt ??
            nextAt(
              a.schedule,
              Math.max(runtime.now(), a.runs.at(-1)?.firedAt ?? a.createdAt),
              a.runs.at(-1)?.firedAt ?? a.createdAt,
            )
          a.nextAt = until
          return { status: 'running', checkpoint: { phase: 'sleep', until } }
        }, context),
      sleep: (task, runtime, context) =>
        runtime.sleepUntil(
          task.state.checkpoint.until,
          { phase: 'fire', until: task.state.checkpoint.until },
          context,
        ),
      fire: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const a = (await tx.doc(Automations)).automations[task.input.id]
          if (!a?.enabled || a.scheduler !== task.id) return terminal
          await fire(tx, a, runtime.now())
          delete a.nextAt
          if (a.schedule.kind === 'at') {
            a.enabled = false
            delete a.scheduler
            return terminal
          }
          return { status: 'running', checkpoint: { phase: 'plan' } }
        }, context),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
  async function change(tx: Tx, args: Args): Promise<{ result: JsonValue; abort?: TaskId }> {
    const state = await tx.doc(Automations)
    if (args.action === 'list') return { result: Object.values(state.automations) }
    const id = args.action === 'create' ? `A${state.next++}` : required(args.id, 'id')
    if (args.action === 'create') {
      const now = Date.now()
      state.automations[id] = {
        id,
        name: required(args.name, 'name'),
        prompt: required(args.prompt, 'prompt'),
        schedule: parseSchedule(args.schedule ?? ''),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        runs: [],
      }
    }
    const a = state.automations[id]
    if (!a) throw new Error(`Unknown automation: ${id}`)
    if (args.action === 'runs') return { result: a.runs }
    if (args.action === 'run') return { result: await fire(tx, a, Date.now()) }
    if (args.action === 'abort') {
      const run = a.runs.find((r) => r.id === args.runId)
      if (!run || run.status !== 'running') throw new Error('runId must identify a running run')
      return { result: { id: run.id }, abort: Number(run.id) as TaskId }
    }
    if (
      args.action === 'resume' &&
      a.schedule.kind === 'at' &&
      Date.parse(a.schedule.time) <= Date.now()
    )
      throw new Error('This one-shot time has passed; update the time first')
    const abort = a.scheduler
    const oldSchedule = { ...a.schedule }
    delete a.scheduler
    if (args.action !== 'update') delete a.nextAt
    if (args.action === 'delete') {
      delete state.automations[a.id]
      return { result: { id: a.id }, ...(abort ? { abort } : {}) }
    }
    if (args.action === 'create' || args.action === 'update') {
      if (args.name !== undefined) a.name = required(args.name, 'name')
      if (args.prompt !== undefined) a.prompt = required(args.prompt, 'prompt')
      if (args.schedule !== undefined) a.schedule = parseSchedule(args.schedule)
      if (args.agent !== undefined) {
        if (args.agent) a.agent = args.agent
        else delete a.agent
      }
      if (args.model !== undefined) a.model = args.model
      if (args.thinking !== undefined) a.thinking = args.thinking
    } else if (args.action === 'pause') a.enabled = false
    else if (args.action === 'resume') a.enabled = true
    else throw new Error(`Unknown action: ${args.action}`)
    a.updatedAt = Date.now()
    if (!isDeepStrictEqual(a.schedule, oldSchedule)) delete a.nextAt
    if (a.enabled) {
      a.nextAt ??= nextAt(a.schedule, Date.now(), a.runs.at(-1)?.firedAt ?? Date.now())
      a.scheduler = await tx.createTask(Scheduler, { id: a.id }, owner)
    }
    return { result: JSON.parse(JSON.stringify(a)) as JsonValue, ...(abort ? { abort } : {}) }
  }
  async function validate(args: Args) {
    if (!host.extensions().some((e) => e.name === 'subagents' && e.enabled))
      throw new Error('automations needs the subagents extension enabled')
    if (args.agent) await definition(host, args.agent)
    if (args.model && !host.modelRuntime.getModel(args.model.provider, args.model.modelId))
      throw new Error('Unknown model')
  }
  return { RunTask, Scheduler, change, validate }
}
function finish(
  state: { automations: Record<string, Automation> },
  id: string,
  runId: string,
  status: Run['status'],
  answer?: string,
) {
  const run = state.automations[id]?.runs.find((r) => r.id === runId)
  if (run) {
    run.status = status
    run.finishedAt = Date.now()
    if (answer !== undefined) run.answer = answer.trim().split('\n')[0].slice(0, 200)
  }
}

const operations = [
  'list',
  'create',
  'update',
  'pause',
  'resume',
  'run',
  'runs',
  'delete',
  'abort',
] as const
/** Run ledger operation `action` with the tool's validation, in one transaction; resolves with its JSON result. */
async function operate(
  host: ExtensionHost,
  action: (typeof operations)[number],
  input: unknown,
): Promise<JsonValue> {
  const args = { ...(input as Omit<Args, 'action'>), action }
  const api = backend(host)
  await api.validate(args)
  const receipt = await host.harness().commit(
    async (tx) =>
      JSON.parse(JSON.stringify(await api.change(tx, args))) as {
        result: JsonValue
        abort?: TaskId
      },
    BACKGROUND_CONTEXT,
  )
  if (receipt.abort) await host.harness().abortTask(receipt.abort, BACKGROUND_CONTEXT)
  return receipt.result
}

// `change` returns each operation's value as JSON: the ledger's automations, a run, or an id.
export const actions = {
  list: implementAction(
    ListAction,
    async (args, { host }) => (await operate(host, 'list', args)) as Automation[],
  ),
  create: implementAction(
    CreateAction,
    async (args, { host }) => (await operate(host, 'create', args)) as Automation,
  ),
  update: implementAction(
    UpdateAction,
    async (args, { host }) => (await operate(host, 'update', args)) as Automation,
  ),
  pause: implementAction(
    PauseAction,
    async (args, { host }) => (await operate(host, 'pause', args)) as Automation,
  ),
  resume: implementAction(
    ResumeAction,
    async (args, { host }) => (await operate(host, 'resume', args)) as Automation,
  ),
  run: implementAction(
    RunAction,
    async (args, { host }) => (await operate(host, 'run', args)) as Run,
  ),
  runs: (input: JsonValue, { host }: ActionContext) => operate(host, 'runs', input),
  delete: implementAction(
    DeleteAction,
    async (args, { host }) => (await operate(host, 'delete', args)) as { id: string },
  ),
  abort: (input: JsonValue, { host }: ActionContext) => operate(host, 'abort', input),
  describe: implementAction(DescribeAction, (args) => {
    const input =
      args && typeof args === 'object' && !Array.isArray(args) ? args.schedule : undefined
    const schedule = parseSchedule((input ?? '') as string | Schedule)
    let time = Date.now()
    const next: number[] = []
    for (let i = 0; i < (schedule.kind === 'at' ? 1 : 3); i++) {
      time = nextAt(schedule, time)
      next.push(time)
    }
    return { schedule, description: describeSchedule(schedule), next }
  }),
}

export default function automations(host: Host & Pick<ExtensionHost, 'need'>) {
  // Core, always on; resolved where it is called, declared here so the catalogue lists it.
  host.need(SubagentsApi)
  const api = backend(host)
  return defineExtension({
    name: 'automations',
    tasks: [api.Scheduler, api.RunTask],
    sections: [
      section('automations', async ({ read }, context) => {
        const state = await read.snapshot(Automations, context)
        const lines = Object.values(state?.automations ?? {})
          .filter((a) => a.enabled)
          .map((a) => `${a.name}: ${describeSchedule(a.schedule)}`)
        return lines.length ? lines.join('\n') : undefined
      }),
    ],
    tools: [
      defineTool({
        name: 'automation',
        // Transactional receipts deduplicate changes; abort reuses the recorded task id and is idempotent.
        replay: 'safe',
        description:
          'Schedule agent prompts durably. Actions: list, create, update, pause, resume, run (now), runs, delete (keeps conversations), abort {id,runId}. create needs name, prompt, schedule; other actions use id A<n>. Schedules: cron "0 9 * * 1-5" Europe/Vienna (timezone optional), at 2026-12-01T09:00:00Z, in 30m, every 15m. Runs cost model tokens. Optional agent selects an existing agent definition that fits the job (see Available definitions in the subagents prompt), or first write <project>/.ultimate/agents/<name>.md with frontmatter name, description, model, thinking, tools and instructions in the body, then reference it so the project team shares it. Agent isolates are ignored. Optional model {provider,modelId} and thinking override the profile. Without an agent, runs copy the root agent.',
        parameters: Type.Object({
          action: Type.Union(operations.map((v) => Type.Literal(v))),
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          prompt: Type.Optional(Type.String()),
          schedule: Type.Optional(Type.String()),
          agent: Type.Optional(Type.String()),
          model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
          thinking: Type.Optional(
            Type.Union(
              ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) =>
                Type.Literal(v),
              ),
            ),
          ),
          runId: Type.Optional(Type.String()),
        }),
        execute: async (args, tool, context: Context) => {
          const cached = await tool.memo<{ output: { type: 'text'; text: string }[] }>(
            'result',
            context,
          )
          if (cached) return cached
          await api.validate(args)
          const receipt = await tool.commit(async (tx) => {
            const saved = await tx.doc(Receipt, tool.taskId)
            if (saved.result === undefined) Object.assign(saved, await api.change(tx, args))
            return {
              result: JSON.parse(JSON.stringify(saved.result)) as JsonValue,
              ...(saved.abort ? { abort: saved.abort } : {}),
            }
          }, context)
          if (receipt.abort) await host.harness().abortTask(receipt.abort, context)
          return tool.memo(
            'result',
            { output: [{ type: 'text' as const, text: concise(receipt.result) }] },
            context,
          )
        },
      }),
    ],
  })
}
function concise(value: JsonValue): string {
  if (Array.isArray(value)) return value.length ? value.map(concise).join('\n') : 'None.'
  if (value && typeof value === 'object' && 'schedule' in value) {
    const a = value as Automation
    return `${a.id} ${a.name} — ${describeSchedule(a.schedule)} — ${a.enabled ? 'enabled' : 'paused'}`
  }
  if (value && typeof value === 'object' && 'status' in value) {
    const run = value as Run
    return `${run.id} ${run.status}${run.conversationId ? ` #${run.conversationId}` : ''}${run.answer ? `: ${run.answer}` : ''}`
  }
  return JSON.stringify(value)
}
