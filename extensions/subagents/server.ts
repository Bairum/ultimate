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
      const indexed = (await runtime.snapshot(Subagents, runtime.conversationId, context))?.agents[
        String(child.id)
      ]
      assertMessageable(child.id, indexed?.isolate)
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

const operating = new Set<ConversationId>()
function assertMessageable(id: ConversationId, isolate?: Isolate) {
  if (isolate?.state === 'discarded')
    throw new Error("Child's worktree was discarded; start a new child")
  if (operating.has(id)) throw new Error('Child worktree lifecycle operation is in progress')
}

async function operate(
  host: Pick<ExtensionHost, 'harness' | 'projectRoot' | 'ultimateRoot'>,
  conversationId: ConversationId,
  id: ConversationId,
  action: 'land' | 'discard',
  context: Context = BACKGROUND_CONTEXT,
) {
  const harness = host.harness()
  const parent = (await harness.conversation(conversationId, context))!
  const cwd = (await parent.agent(context)).cwd ?? host.projectRoot
  const result = await worktree.locked(cwd, async () => {
    operating.add(id)
    try {
      const child = (await harness.snapshot(Subagents, conversationId, context))?.agents[String(id)]
      if (!child?.isolate) throw new Error('id must identify a worktree child of this conversation')
      if ((await harness.snapshot(LiveDoc, id, context))?.run)
        throw new Error('Child is running; wait or stop it first')
      const outcome = await worktree.operate(cwd, child.isolate, action)
      await harness.commit(async (tx) => {
        const isolate = (await tx.doc(Subagents, conversationId)).agents[String(id)].isolate!
        if (outcome.state) isolate.state = outcome.state
        if (outcome.landed) isolate.landed = outcome.landed
      }, context)
      return outcome
    } finally {
      operating.delete(id)
    }
  })
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
/** Isolate operations and definitions for the Agents tab. */
export const actions = {
  async land(args: JsonValue, { host, conversationId }: ActionContext) {
    return operate(host, conversationId as ConversationId, childId(args, conversationId), 'land')
  },
  async discard(args: JsonValue, { host, conversationId }: ActionContext) {
    return operate(host, conversationId as ConversationId, childId(args, conversationId), 'discard')
  },
  /** `{parent, id}`: the child's isolate and its commits ahead of the parent checkout, or null without one. */
  async isolate(args: JsonValue, { host }: ActionContext) {
    // The Agents tab may show another conversation, so the parent comes with the args.
    const parent = (args as { parent?: JsonValue } | null)?.parent
    const id = childId(args, typeof parent === 'number' ? parent : undefined)
    const harness = host.harness()
    const conversationId = parent as ConversationId
    const isolate = (await harness.snapshot(Subagents, conversationId, BACKGROUND_CONTEXT))?.agents[
      String(id)
    ]?.isolate
    if (!isolate) return null
    const conversation = (await harness.conversation(conversationId, BACKGROUND_CONTEXT))!
    const cwd = (await conversation.agent(BACKGROUND_CONTEXT)).cwd ?? host.projectRoot
    // A kept branch may have been deleted since.
    const ahead = await worktree
      .git(cwd, 'rev-list', '--count', `HEAD..${isolate.branch}`)
      .then(Number, () => null)
    return { ...isolate, ahead }
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
          `You coordinate. Own requirements, the plan, decomposition, acceptance criteria,
verification, landing, and the verdict. Delegate bounded execution and reconnaissance,
never judgment. Never accept a child's claim without evidence.
Do quick fixes and simple questions directly. Orchestrate substantive work:
several dependent changes, several files or systems, or independent reconnaissance worth doing.

1. Inspect the code and recommend one approach.
   Ask only for decisions that change behaviour or scope.
2. Write the epic with the plan tool and binary acceptance criteria.
3. Add one task per unit of work, with a self-contained description for its child.
4. Delegate to worker in a worktree isolate, or scout for reconnaissance.
   Use background children for parallel work; children touching the same files run sequentially.
   Link each child to its task with plan; record dependencies and status.
5. On each answer, read the report and inspect the commit diff in the isolate.
   Rerun the meaningful checks yourself in the isolate before landing.
6. Land verified work, then reload; use restart for server/ and shared/ changes.
   After the last land of a batch, rerun meaningful checks on the parent checkout yourself.
   Discard a child's isolate once its work has landed and it has no further work.
7. Record verification evidence with plan and set the task done; only you do this.
8. When all tasks are done, run every definition whose name starts with reviewer
   in parallel on the same commit range. Name base..head, not a directory.
   Merge and verify the findings yourself; never delegate the verdict.
   Message the responsible worker with confirmed fixes, or create a new task.
   Verify, land, and review fixes before concluding.
9. Post the verdict on the epic with plan and report to the user.

An idle or finished child is not evidence. Check reports are not your own checks.
Never push, merge to remotes, or ship unless the user asks. Children never push.
Heavy commands are serialized by exclusive-commands; do not bypass it.
Available definitions:
` + discovered.definitions.map((agent) => `${agent.name}: ${agent.description}`).join('\n')
        )
      }),
    ],
    tools: [
      defineTool({
        name: 'subagent',
        description:
          'Delegate to a named agent. start returns its answer (foreground) or id (background). message sends a follow-up or steer; wait returns the latest answer; stop stops current work; list shows your children; land verifies and fast-forwards a finished worktree child; discard removes its worktree but keeps its branch. start accepts isolate none or worktree, and fork true to inherit parent history before this call (more context cost; prompt caching usually covers the shared prefix). Background answers join the current run after its tool round.',
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
          fork: Type.Optional(Type.Boolean()),
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
            if (args.action === 'message')
              assertMessageable(args.id as ConversationId, index.agents[String(args.id)].isolate)
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
            let forkAt: EntryId | undefined
            if (definition && args.fork) {
              const task = await api.getTask(api.taskId, context)
              // Pi upstream: @earendil-works/pi-durable@1.0.0 src/harness/tool.ts — internal ToolTaskInput.assistant locates the calling assistant. Drop when ToolExecutionApi exposes the calling assistant entry ID.
              const assistant = (task!.input as { assistant: EntryId }).assistant
              const conversation = (await host.harness().conversation(api.conversationId, context))!
              const view = await conversation.viewState(context)
              try {
                const position = view.value.entries.findIndex((entry) => entry.id === assistant)
                forkAt = view.value.entries[position - 1]?.id
                if (forkAt === undefined) throw new Error('No parent history before this call')
              } finally {
                view.dispose()
              }
            }
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
                const ownership = { kind: 'task' as const, taskId: owner }
                const child =
                  forkAt === undefined
                    ? await tx.createConversation({ ownership })
                    : await tx.forkConversation(api.conversationId, forkAt, { ownership })
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
                  cwd: childCwd ?? parent.cwd ?? null,
                  model: definition.model ?? parent.model ?? null,
                  thinkingLevel: definition.thinking
                    ? thinkingFor(definition, parent, host)
                    : (parent.thinkingLevel ?? null),
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
              if (args.action === 'message')
                assertMessageable(conversationId, state.agents[String(conversationId)].isolate)
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
            const current = await api.snapshot(Subagents, api.conversationId, context)
            assertMessageable(
              action.conversationId,
              current?.agents[String(action.conversationId)]?.isolate,
            )
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
