import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import type { JsonValue } from '@earendil-works/chord'
import { clampThinkingLevel, Type } from '@earendil-works/pi-ai'
import type { AssistantMessage, ModelThinkingLevel } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  section,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  TaskId,
} from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { discoverAgents } from './agents.ts'
import * as worktree from './isolates/worktree.ts'
import type { Isolate, CreatedIsolate } from './isolates/types.ts'

export const Subagents = defineDoc<{
  agents: Record<
    string,
    {
      conversationId: ConversationId
      agent: string
      background: boolean
      reported: EntryId[]
      isolate?: Isolate
    }
  >
  actions: Record<string, { conversationId: ConversationId; reporter?: TaskId }>
}>({
  kind: 'ultimate.subagents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ agents: {}, actions: {} }),
})
export const docs = [Subagents]
const Anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'ultimate.subagent-anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
})
const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
// A report is keyed by the answer it carries, so `wait` can withdraw it once it returns that answer itself.
const answerRequest = (answer: EntryId) => `subagent-answer:${answer}`
const Reporter = defineTask<
  { conversationId: ConversationId; text: string; steer: boolean },
  { phase: 'deliver' } | { phase: 'report'; report?: string; answer?: EntryId },
  null
>({
  name: 'ultimate.subagent-reporter',
  version: 1,
  initial: () => ({ phase: 'deliver' }),
  phases: {
    deliver: async (task, runtime, context) => {
      const child = (await runtime.conversation(task.input.conversationId, context))!
      const settled = await (
        await child.submit(
          {
            type: 'input',
            content: task.input.text,
            whenBusy: task.input.steer ? 'steer' : 'followUp',
            requestId: `subagent:${task.id}`,
          },
          context,
        )
      ).wait(context)
      await runtime.commit(async (tx) => {
        const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[String(child.id)]
        if (settled.status === 'done' && settled.type === 'input') {
          if (agent.reported.includes(settled.answer))
            return { status: 'running', checkpoint: { phase: 'report' } }
          agent.reported.push(settled.answer)
          const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
            | AssistantMessage
            | undefined
          const report = `[subagent ${child.id} (${agent.agent}) answered] ${textOf(answer)}`
          return {
            status: 'running',
            checkpoint: { phase: 'report', report, answer: settled.answer },
          }
        }
        if (settled.status === 'unanswered' && settled.reason !== 'aborted') {
          const report = `[subagent ${child.id} failed: ${settled.reason}]`
          return { status: 'running', checkpoint: { phase: 'report', report } }
        }
        return { status: 'running', checkpoint: { phase: 'report' } }
      }, context)
    },
    report: async (task, runtime, context) => {
      const { report, answer } = task.state.checkpoint
      if (report !== undefined) {
        const parent = (await runtime.conversation(runtime.conversationId, context))!
        await parent.submit(
          {
            type: 'input',
            content: report,
            whenBusy: 'steer',
            requestId: answer === undefined ? `subagent-report:${task.id}` : answerRequest(answer),
          },
          context,
        )
      }
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        context,
      )
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
})

/** Details name the child and whether it answers in the background, for the call's renderer. */
const details = (conversationId: ConversationId, background: boolean) => ({
  conversationId,
  ...(background ? { background } : {}),
})
const reply = (text: string, info?: ReturnType<typeof details>) => ({
  content: [{ type: 'text' as const, text }],
  ...(info === undefined ? {} : { details: info }),
})

async function operate(
  host: Pick<ExtensionHost, 'harness' | 'projectRoot' | 'ultimateRoot'>,
  conversationId: ConversationId,
  id: ConversationId,
  action: 'land' | 'discard',
  context: Context = BACKGROUND_CONTEXT,
) {
  const harness = host.harness()
  const child = (await harness.snapshot(Subagents, conversationId, context))?.agents[String(id)]
  if (!child?.isolate) throw new Error('id must identify a worktree child of this conversation')
  if ((await harness.snapshot(LiveDoc, id, context))?.run)
    throw new Error('Child is running; wait or stop it first')
  const parent = (await harness.conversation(conversationId, context))!
  const cwd = (await parent.agent(context)).cwd ?? host.projectRoot
  const result = await (child.isolate.kind === 'worktree'
    ? (action === 'land' ? worktree.land : worktree.discard)(cwd, child.isolate)
    : Promise.reject(new Error('Unsupported isolate kind')))
  await harness.commit(async (tx) => {
    const isolate = (await tx.doc(Subagents, conversationId)).agents[String(id)].isolate!
    if (result.state) isolate.state = result.state
    if (result.landed) isolate.landed = result.landed
  }, context)
  return {
    ...result,
    ...(host.projectRoot === host.ultimateRoot &&
    result.paths?.some((path) => /^(server|shared)\//.test(path))
      ? { needsRestart: true, text: `${result.text}\nNeeds restart.` }
      : {}),
  }
}
function childId(args: JsonValue, conversationId?: number) {
  if (
    !conversationId ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    typeof args.id !== 'number'
  )
    throw new Error('conversationId and child id are required')
  return args.id as ConversationId
}
/** Workspace operations and definitions for the Agents tab. */
export const actions = {
  async land(args: JsonValue, { host, conversationId }: ActionContext) {
    return operate(host, conversationId as ConversationId, childId(args, conversationId), 'land')
  },
  async discard(args: JsonValue, { host, conversationId }: ActionContext) {
    return operate(host, conversationId as ConversationId, childId(args, conversationId), 'discard')
  },
  async definitions(_args: JsonValue, { host }: ActionContext) {
    const { definitions, errors } = await discoverAgents(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      host.modelRuntime,
    )
    return {
      definitions: definitions.map(({ instructions: _instructions, ...definition }) => definition),
      errors,
    }
  },
}

/** A definition's thinking level, clamped to the child's model by Pi's rule (the HTTP configure path does the same). */
function thinkingFor(
  definition: { model?: { provider: string; modelId: string }; thinking?: ModelThinkingLevel },
  parent: { model?: { provider: string; modelId: string } },
  host: Pick<ExtensionHost, 'modelRuntime'>,
) {
  const ref = definition.model ?? parent.model
  const model = ref && host.modelRuntime.getModel(ref.provider, ref.modelId)
  return model && definition.thinking
    ? clampThinkingLevel(model, definition.thinking)
    : definition.thinking
}

export default function subagents(
  host: Pick<
    ExtensionHost,
    'ultimateRoot' | 'projectRoot' | 'userHome' | 'harness' | 'metadata' | 'modelRuntime' | 'home'
  >,
) {
  return defineExtension({
    name: 'subagents',
    tasks: [Anchor, Reporter],
    sections: [
      section('subagents', async () => {
        const discovered = await discoverAgents(
          host.ultimateRoot,
          host.projectRoot,
          host.userHome,
          host.modelRuntime,
        )
        return (
          'You coordinate. Delegate bounded, self-contained research, reconnaissance, review, and isolated implementation to subagents. Run independent work in parallel in the background. Workers run in worktrees: verify their commits, then land them. Verify results before relying on them.\nAvailable definitions:\n' +
          discovered.definitions.map((agent) => `${agent.name}: ${agent.description}`).join('\n')
        )
      }),
    ],
    tools: [
      defineTool({
        name: 'subagent',
        description:
          'Delegate to a named agent. start returns its answer (foreground) or id (background). message sends a follow-up or steer; wait returns the latest answer; stop stops current work; list shows your children; land verifies and fast-forwards a finished worktree child; discard removes its worktree but keeps its branch. start accepts isolate none or worktree. Background answers join the current run after its tool round.',
        replay: 'safe',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('start'),
            Type.Literal('message'),
            Type.Literal('wait'),
            Type.Literal('stop'),
            Type.Literal('list'),
            Type.Literal('land'),
            Type.Literal('discard'),
          ]),
          agent: Type.Optional(Type.String()),
          task: Type.Optional(Type.String()),
          background: Type.Optional(Type.Boolean()),
          id: Type.Optional(Type.Integer({ minimum: 1 })),
          text: Type.Optional(Type.String()),
          steer: Type.Optional(Type.Boolean()),
          isolate: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('worktree')])),
        }),
        execute: async (args, api, context) => {
          const cached = await api.memo<ReturnType<typeof reply>>('result', context)
          if (cached) return cached
          const finish = (text: string, info?: ReturnType<typeof details>) =>
            api.memo('result', reply(text, info), context)
          const index = (await api.snapshot(Subagents, api.conversationId, context)) ?? {
            agents: {},
            actions: {},
          }
          if (args.action === 'list') {
            const rows = await Promise.all(
              Object.values(index.agents).map(async (agent) => ({
                ...agent,
                busy:
                  (await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined,
              })),
            )
            return finish(JSON.stringify(rows.map(({ reported: _reported, ...row }) => row)))
          }
          if (
            args.action !== 'start' &&
            (!args.id || !Object.hasOwn(index.agents, String(args.id)))
          )
            throw new Error('id must identify a child of this conversation')
          if (args.action === 'land' || args.action === 'discard')
            return finish(
              JSON.stringify(
                await operate(
                  host,
                  api.conversationId,
                  args.id as ConversationId,
                  args.action,
                  context,
                ),
              ),
            )
          if (args.action === 'start' || args.action === 'message') {
            const text = args.action === 'start' ? args.task : args.text
            if (!text?.trim())
              throw new Error(
                `${args.action} requires ${args.action === 'start' ? 'task' : 'text'}`,
              )
            const parent = await api.agent(context)
            const existingAction = index.actions[api.callId]
            const definition =
              args.action === 'start' && !existingAction
                ? (
                    await discoverAgents(
                      host.ultimateRoot,
                      host.projectRoot,
                      host.userHome,
                      host.modelRuntime,
                    )
                  ).definitions.find((agent) => agent.name === args.agent)
                : undefined
            if (args.action === 'start' && !existingAction && !definition)
              throw new Error(`Unknown agent: ${args.agent}`)
            if (
              definition?.tools?.some(
                (name) => name === 'subagent' || !parent.tools.some((tool) => tool.name === name),
              )
            )
              throw new Error(
                'Definition tools must be a subset of parent tools, excluding subagent',
              )
            let isolate = existingAction
              ? index.agents[String(existingAction.conversationId)].isolate
              : undefined
            let childCwd = isolate?.path
            if (definition && (args.isolate ?? definition.isolate ?? 'none') === 'worktree') {
              let created = await api.memo<CreatedIsolate>('isolate', context)
              if (!created)
                created = await api.memo(
                  'isolate',
                  await worktree.create(
                    parent.cwd ?? host.projectRoot,
                    host.home,
                    definition.name,
                    api.callId,
                    host.projectRoot,
                    context.abortSignal,
                  ),
                  context,
                )
              isolate = created.record
              childCwd = created.cwd
            }
            const warning =
              isolate &&
              (await worktree.git(parent.cwd ?? host.projectRoot, 'status', '--porcelain'))
                ? '\nWarning: parent has uncommitted changes; they are not in the worktree.'
                : ''
            const isolateInfo = isolate
              ? `\nIsolate: ${isolate.path}\nBranch: ${isolate.branch}${warning}`
              : ''
            const action = await api.commit(async (tx) => {
              const state = await tx.doc(Subagents, api.conversationId)
              if (state.actions[api.callId]) return { ...state.actions[api.callId] }
              let conversationId = args.id as ConversationId
              if (definition) {
                const owner = args.background
                  ? await tx.createTask(Anchor, null, {
                      ownership: { kind: 'conversation' },
                      background: true,
                    })
                  : api.taskId
                const child = await tx.createConversation({
                  ownership: { kind: 'task', taskId: owner },
                })
                conversationId = child.id
                await configure(tx, child.id, {
                  tools: parent.tools.filter(
                    (tool) =>
                      tool.name !== 'subagent' &&
                      (!definition.tools || definition.tools.includes(tool.name)),
                  ),
                  extensions: parent.extensions.filter(
                    (extension) => extension.name !== 'subagents',
                  ),
                  instructions:
                    definition.instructions +
                    (isolate
                      ? `\nWork only in ${isolate.path} on ${isolate.branch}, cut from ${isolate.base}. Commit your work on this branch with clear messages. Never push and never touch other checkouts.`
                      : ''),
                  ...(childCwd ? { cwd: childCwd } : {}),
                  ...(definition.model ? { model: definition.model } : {}),
                  ...(definition.thinking
                    ? { thinkingLevel: thinkingFor(definition, parent, host) }
                    : {}),
                })
                Object.assign(await tx.doc(host.metadata, child.id), {
                  label: definition.name,
                  title: text,
                })
                state.agents[String(child.id)] = {
                  conversationId,
                  agent: definition.name,
                  background: args.background === true,
                  reported: [],
                  ...(isolate ? { isolate } : {}),
                }
              }
              const background = state.agents[String(conversationId)].background
              const reporter = background
                ? await tx.createTask(
                    Reporter,
                    { conversationId, text, steer: args.steer === true },
                    { ownership: { kind: 'conversation' }, background: true },
                  )
                : undefined
              const createdAction = {
                conversationId,
                ...(reporter === undefined ? {} : { reporter }),
              }
              state.actions[api.callId] = createdAction
              return createdAction
            }, context)
            const info = details(action.conversationId, action.reporter !== undefined)
            await api.details(info, context)
            if (action.reporter !== undefined)
              return finish(
                `Started ${args.action === 'message' ? 'message to' : 'subagent'} ${action.conversationId}.${isolateInfo}`,
                info,
              )
            const child = (await api.conversation(action.conversationId, context))!
            const settled = await (
              await child.submit(
                {
                  type: 'input',
                  content: text,
                  whenBusy: args.steer ? 'steer' : 'followUp',
                  requestId: `subagent:${api.callId}`,
                },
                context,
              )
            ).wait(context)
            if (settled.status !== 'done' || settled.type !== 'input')
              return finish(
                `Subagent ${action.conversationId}: ${settled.status}${isolateInfo}`,
                info,
              )
            const answer = await api.commit(
              (tx) => tx.entry(AssistantEntry, settled.answer),
              context,
            )
            return finish(
              textOf(answer?.model?.[0] as AssistantMessage | undefined) + isolateInfo,
              info,
            )
          }
          const id = args.id as ConversationId
          const info = details(id, index.agents[String(id)].background)
          await api.details(info, context)
          const child = (await api.conversation(id, context))!
          if (args.action === 'stop') {
            // Remember the run, not just the child: replay must never stop a newer run.
            const target = await api.memo(
              'stopRun',
              (await api.snapshot(LiveDoc, id, context))?.run?.taskId ?? null,
              context,
            )
            if (
              target !== null &&
              (await api.snapshot(LiveDoc, id, context))?.run?.taskId === target
            )
              await child.abort(context)
            return finish(`Stopped ${id}.`, info)
          }
          // Reporters claim answers before they submit them; once they finish, a queued report can be found.
          for (const action of Object.values(index.actions))
            if (action.conversationId === id && action.reporter !== undefined)
              await api.waitForTask(action.reporter, context)
          await child.waitForIdle(context)
          const { answer, report } = await api.commit(async (tx) => {
            let cursor: Cursor | undefined
            let latest: EntryRecord | undefined
            do {
              const page = await tx.scanEntries({ conversationId: id }, 256, cursor)
              for (const entry of page.items)
                if (entry.kind === 'pi.assistant' && latest === undefined) latest = entry
              cursor = page.next
            } while (cursor !== undefined)
            if (!latest) return { answer: undefined, report: undefined }
            const submission = await tx.submissionByRequest(
              api.conversationId,
              answerRequest(latest.id),
            )
            const agent = (await tx.doc(Subagents, api.conversationId)).agents[String(id)]
            if (!agent.reported.includes(latest.id)) agent.reported.push(latest.id)
            return { answer: latest, report: submission?.id }
          }, context)
          // This result delivers the answer; a report still waiting in the inbox would repeat it.
          if (report !== undefined)
            await host.harness().abortSubmission(report, context, api.conversationId)
          return finish(textOf(answer?.model?.[0] as AssistantMessage | undefined), info)
        },
      }),
    ],
  })
}
