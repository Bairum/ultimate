import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  AgentDoc,
  AssistantEntry,
  configure,
  ToolResultEntry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  InboxDoc,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  TaskId,
  ToolExecutionApi,
  SubmissionRecord,
} from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { Source } from '../../server/project.ts'
import {
  agentRoots,
  definitionAgent,
  deleteDefinition,
  discoverAgents,
  saveDefinition,
} from './agents.ts'
import { createChild } from './children.ts'
import type { WorkspaceService } from '../workspaces/server.ts'
import { requestSummary } from '../conversations/summary.ts'
import { summaryModel } from '../conversations/summary-model.ts'

export const Subagents = defineDoc<{
  agents: Record<
    string,
    {
      conversationId: ConversationId
      agent: string
      background: boolean
      reported: EntryId[]
    }
  >
  actions: Record<
    string,
    {
      conversationId: ConversationId
      reporter: TaskId
      answer?: EntryId
      status?: string
      retryRequest?: string
    }
  >
}>({
  kind: 'ultimate.subagents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ agents: {}, actions: {} }),
})
export const Standing = defineDoc<Record<string, ConversationId>>({
  kind: 'ultimate.standing-agents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export type SubagentsService = {
  residents(ctx: Context): Promise<{ name: string; description: string }[]>
  standing(name: string, ctx: Context): Promise<ConversationId>
}
export const docs = [Subagents, Standing]
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
// A report is keyed by its answer, independently of the tool call that may return it.
const answerRequest = (answer: EntryId) => `subagent-answer:${answer}`
/** An aborted or failed turn keeps its partial message, often only an empty thinking block: not an answer. */
const answered = (message: AssistantMessage | undefined) =>
  message !== undefined &&
  message.stopReason !== 'aborted' &&
  message.stopReason !== 'error' &&
  textOf(message).trim() !== ''
const unanswered = (message: AssistantMessage | undefined) =>
  `ended its turn without an answer${message?.stopReason === 'aborted' || message?.stopReason === 'error' ? ` (${message.stopReason})` : ''}`
const answerText = (message: AssistantMessage | undefined) =>
  `Returned model: ${message?.provider && message?.model ? `${message.provider}/${message.model}` : 'unknown'}\n${textOf(message)}`
const reportText = (id: ConversationId, agent: string, message: AssistantMessage | undefined) =>
  answered(message)
    ? `[subagent ${id} (${agent}) answered] ${answerText(message)}`
    : `[subagent ${id} failed: ${unanswered(message)}]`
/** What a foreground start, message or wait returns for a child's answer entry. */
const replyText = (id: ConversationId, message: AssistantMessage | undefined) =>
  answered(message)
    ? answerText(message)
    : `Subagent ${id} ${unanswered(message)}. Message it to continue.`
function createReporter() {
  return defineTask<
    {
      conversationId: ConversationId
      text: string
      steer: boolean
      sourceEntry?: EntryId
      answer?: EntryId
    },
    | { phase: 'deliver'; retryRequest?: string }
    | { phase: 'retry'; retryRequest: string; until: number }
    | { phase: 'report'; report?: string; answer?: EntryId },
    null
  >({
    name: 'ultimate.subagent-reporter',
    version: 1,
    initial: (input) =>
      input.answer === undefined
        ? { phase: 'deliver' }
        : { phase: 'report', report: input.text, answer: input.answer },
    phases: {
      retry: async (task, runtime, context) => {
        await runtime.sleep(task.state.checkpoint.until, context)
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: { phase: 'deliver', retryRequest: task.state.checkpoint.retryRequest },
          }),
          context,
        )
      },
      deliver: async (task, runtime, context) => {
        try {
          const child = (await runtime.conversation(task.input.conversationId, context))!
          const retryRequest = task.state.checkpoint.retryRequest
          const content =
            retryRequest !== undefined
              ? 'Your previous run stopped with a provider error. Continue from where you left off; check what you already did and do not redo it.'
              : task.input.text
          const settled = await (
            await child.submit(
              {
                type: 'input',
                content,
                entry: {
                  kind: 'subagents.instruction',
                  data: {
                    sender: runtime.conversationId,
                    kind: 'instruction',
                    agent: (await runtime.snapshot(Subagents, runtime.conversationId, context))!
                      .agents[String(child.id)].agent,
                    body: content,
                    ...(task.input.sourceEntry ? { entry: task.input.sourceEntry } : {}),
                  },
                },
                whenBusy: task.input.steer ? 'steer' : 'followUp',
                requestId: retryRequest ?? `subagent:${task.id}`,
              },
              context,
            )
          ).wait(context)
          await runtime.commit(async (tx) => {
            const state = await tx.doc(Subagents, runtime.conversationId)
            const action = Object.values(state.actions).find(
              (candidate) => candidate.reporter === task.id,
            )!
            action.status = settled.status
            const agent = state.agents[String(child.id)]
            if (settled.status === 'done' && settled.type === 'input') {
              action.answer = settled.answer
              if (agent.reported.includes(settled.answer))
                return { status: 'running', checkpoint: { phase: 'report' } }
              agent.reported.push(settled.answer)
              const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
                | AssistantMessage
                | undefined
              return {
                status: 'running',
                checkpoint: {
                  phase: 'report',
                  report: reportText(child.id, agent.agent, answer),
                  answer: settled.answer,
                },
              }
            }
            if (
              settled.status === 'unanswered' &&
              (settled.reason === 'model_error' || settled.reason === 'no_model') &&
              retryRequest === undefined
            ) {
              const failedEntry = settled.entry
              if (failedEntry === undefined) throw new Error('Provider failure has no input entry')
              let failureId: EntryId | TaskId | undefined
              if (settled.reason === 'no_model') {
                // IDs share one allocation order. Generation follows its placed inputs; choose
                // their first no-model failure, not a newer run that may already have started.
                let cursor: Cursor | undefined
                do {
                  const page = await tx.scanTasks(
                    {
                      conversationId: child.id,
                      kind: GenerationTask.definition.name,
                      order: 'ascending',
                    },
                    500,
                    cursor,
                  )
                  const generation = page.items.find(
                    (candidate) =>
                      candidate.id > failedEntry &&
                      candidate.state.status === 'terminal' &&
                      candidate.state.outcome.status === 'failed' &&
                      (candidate.state.outcome.error.detail as { reason?: string } | undefined)
                        ?.reason === 'no_model',
                  )
                  if (generation) {
                    failureId = generation.id
                    break
                  }
                  cursor = page.next
                } while (cursor)
              }
              let cursor: Cursor | undefined
              while (settled.reason === 'model_error') {
                const page = await tx.scanEntries(
                  { conversationId: child.id, minEntryId: settled.entry, order: 'ascending' },
                  500,
                  cursor,
                )
                const failure = page.items.find(
                  (entry) =>
                    entry.kind === AssistantEntry.kind &&
                    entry.model?.[0]?.role === 'assistant' &&
                    entry.model[0].stopReason === 'error',
                )
                if (failure) {
                  failureId = failure.id
                  break
                }
                cursor = page.next
                if (cursor === undefined) break
              }
              if (failureId === undefined) throw new Error('Provider failure has no run identity')
              action.retryRequest =
                settled.reason === 'no_model'
                  ? `subagent-retry:${child.id}:no-model:${failureId}`
                  : `subagent-retry:${child.id}:${failureId}`
              return {
                status: 'running',
                checkpoint: {
                  phase: 'retry',
                  retryRequest: action.retryRequest,
                  until: Date.now() + 20_000,
                },
              }
            }
            if (settled.status === 'unanswered' && settled.reason !== 'aborted') {
              const failure = settled.reason
              return { status: 'running', checkpoint: { phase: 'report', report: failure } }
            }
            // A parent stop aborts this task before the input, so this abort came from the child's
            // own conversation: whatever answers its next input there still belongs to the parent.
            if (settled.status === 'unanswered') action.status = 'interrupted'
            return { status: 'running', checkpoint: { phase: 'report' } }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          await runtime.commit(async (tx) => {
            const state = await tx.doc(Subagents, runtime.conversationId)
            const action = Object.values(state.actions).find(
              (candidate) => candidate.reporter === task.id,
            )!
            action.status = 'failed'
            return {
              status: 'running',
              checkpoint: {
                phase: 'report',
                report: message,
              },
            }
          }, context)
        }
      },
      report: async (task, runtime, context) => {
        const { report, answer } = task.state.checkpoint
        if (report !== undefined) {
          const parent = (await runtime.conversation(runtime.conversationId, context))!
          const agent = (await runtime.snapshot(Subagents, runtime.conversationId, context))!
            .agents[String(task.input.conversationId)].agent
          let message: AssistantMessage | undefined
          if (answer !== undefined)
            await runtime.commit(async (tx) => {
              message = (await tx.entry(answer))?.model?.[0] as AssistantMessage | undefined
            }, context)
          const failed = !answered(message)
          const body =
            answer === undefined
              ? `Failed: ${report}`
              : failed
                ? `Failed: ${unanswered(message)}`
                : answerText(message)
          await parent.submit(
            {
              type: 'input',
              content:
                answer === undefined
                  ? `[subagent ${task.input.conversationId} failed: ${report}]`
                  : report,
              entry: {
                kind: 'subagents.report',
                data: {
                  sender: task.input.conversationId,
                  kind: 'report',
                  agent,
                  failed,
                  body,
                  ...(answer ? { entry: answer } : {}),
                },
              },
              whenBusy: 'steer',
              requestId:
                answer === undefined ? `subagent-report:${task.id}` : answerRequest(answer),
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
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const state = await tx.doc(Subagents, runtime.conversationId)
        const action = Object.values(state.actions).find(
          (candidate) => candidate.reporter === task.id,
        )!
        action.status = 'unanswered'
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
}

/** Details name the child and whether it answers in the background, for the call's renderer. */
const details = (
  conversationId: ConversationId,
  background: boolean,
  delivery?: { yielded?: true; answerId?: EntryId },
) => ({
  conversationId,
  ...(background ? { background } : {}),
  ...delivery,
})
const reply = (text: string, info?: ReturnType<typeof details>) => ({
  output: [{ type: 'text' as const, text }],
  ...(info === undefined ? {} : { details: info }),
})

/** Stop only these local waits; child and reporter ownership never changes. */
async function waitInterruptibly(
  api: ToolExecutionApi,
  id: ConversationId,
  reporters: TaskId[],
  idle: boolean,
  context: Context,
) {
  await api.commit(async (tx) => {
    await tx.doc(InboxDoc, api.conversationId)
  }, context)
  const local = withCancel(context)
  const inbox = (await api.watchDoc(InboxDoc, api.conversationId, local.context))!
  let wake!: () => void
  const steering = new Promise<void>((resolve) => {
    wake = resolve
  })
  const inspect = (value: typeof inbox.value) => {
    if (value?.items.some((item) => item.mode === 'steer')) wake()
  }
  inbox.start(async (value) => {
    inspect(value)
  })
  inspect(inbox.value)
  const child = (await api.conversation(id, context))!
  const ready = async () => {
    if (idle && (await api.snapshot(LiveDoc, id, context))?.run !== undefined) return false
    for (const reporter of reporters) {
      const task = await api.getTask(reporter, context)
      if (
        task?.state.status !== 'terminal' &&
        !(
          task?.state.status === 'running' &&
          (task.state.checkpoint as { phase?: string } | null)?.phase === 'report'
        )
      )
        return false
    }
    return true
  }
  const completion = async () => {
    for (const reporter of reporters) await api.waitForTask(reporter, local.context)
    if (idle) await child.waitForIdle(local.context)
  }
  try {
    const result = await Promise.race([
      completion().then(() => true),
      steering.then(async () => {
        // Our reporter may have just queued the steer. Prefer its completed answer.
        if (await ready()) {
          await completion()
          return true
        }
        return false
      }),
    ])
    return result
  } finally {
    local.cancel()
    await inbox.stop()
  }
}

/** Browser actions for the Agents tab. */
export const actions = {
  /** `{name}`: open the current definition's standing conversation. */
  async standing(args: JsonValue, { host }: ActionContext) {
    const { name } = (args ?? {}) as Record<string, JsonValue>
    if (typeof name !== 'string') throw new Error('name is required')
    const service = host.use<SubagentsService>('subagents')
    if (!service) throw new Error('Subagents service is unavailable')
    return service.standing(name, BACKGROUND_CONTEXT)
  },
  /**
   * The definitions without their instructions and the files that failed to parse, and for the config view the main
   * conversation's model and tools (a definition may list a subset), where each scope saves, and whether the
   * project's setup is local, which the project scope needs.
   */
  async definitions(_args: JsonValue, { host }: ActionContext) {
    const { definitions, errors } = await discoverAgents(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      host.modelRuntime,
    )
    const main = await (await host
      .harness()
      .conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))!.agent(BACKGROUND_CONTEXT)
    const local = agentRoots(host.ultimateRoot, host.projectRoot, host.userHome).some(
      (root) => root.source === 'project',
    )
    return {
      definitions: definitions.map(({ instructions: _instructions, ...definition }) => definition),
      errors,
      main: {
        ...(main.model ? { model: main.model } : {}),
        ...(main.thinkingLevel ? { thinking: main.thinkingLevel } : {}),
        tools: [
          ...new Map([...main.tools, ...main.deferred].map((tool) => [tool.name, tool])).values(),
        ].map((tool) => ({ name: tool.name, description: tool.description })),
      },
      scopes: {
        user: join(host.userHome, '.ultimate/agents'),
        project: join(host.projectRoot, '.ultimate/agents'),
      },
      projectLocal: local,
    }
  },
  /** `{name}`: the definition that applies, its source and path, the raw file, and the scopes with a file of that name. */
  async definition(args: JsonValue, { host }: ActionContext) {
    const name = (args as { name?: JsonValue } | null)?.name
    if (typeof name !== 'string' || !name) throw new Error('name is required')
    const { definitions, errors } = await discoverAgents(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      host.modelRuntime,
    )
    const definition = definitions.find((candidate) => candidate.name === name)
    // A later file that fails to parse leaves an earlier one applying.
    const invalid = errors.findLast((candidate) => candidate.name === name)
    const shown = definition ?? invalid
    if (!shown) throw new Error(`Unknown agent: ${name}`)
    const files: Source[] = []
    for (const root of agentRoots(host.ultimateRoot, host.projectRoot, host.userHome))
      if (existsSync(join(root.path, `${name}.md`))) files.push(root.source)
    return {
      ...(definition ? { definition } : {}),
      ...(invalid ? { invalid } : {}),
      source: shown.source,
      path: shown.path,
      raw: await readFile(shown.path, 'utf8'),
      files,
    }
  },
  /** `{name, scope, frontmatter, instructions}`: write `<scope>/agents/<name>.md`; invalid input writes nothing. */
  async saveDefinition(args: JsonValue, { host }: ActionContext) {
    const { name, scope, frontmatter, instructions, create } = (args ?? {}) as Record<
      string,
      JsonValue
    >
    if (typeof name !== 'string') throw new Error('name is required')
    if (scope !== 'user' && scope !== 'project') throw new Error('scope must be user or project')
    if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter))
      throw new Error('frontmatter must be an object')
    if (typeof instructions !== 'string') throw new Error('instructions must be a string')
    const { description, model, thinking, tools, isolate, resident, onFailure } = frontmatter
    if (typeof description !== 'string') throw new Error('description is required')
    if (model !== undefined && typeof model !== 'string') throw new Error('model must be a string')
    if (thinking !== undefined && typeof thinking !== 'string')
      throw new Error('thinking must be a string')
    if (
      tools !== undefined &&
      (!Array.isArray(tools) || !tools.every((tool) => typeof tool === 'string'))
    )
      throw new Error('tools must be a list of tool names')
    if (isolate !== undefined && isolate !== 'none' && isolate !== 'worktree')
      throw new Error('isolate must be none or worktree')
    if (onFailure !== undefined && onFailure !== 'diagnose' && onFailure !== 'fix')
      throw new Error('onFailure must be diagnose or fix')
    if (resident !== undefined && typeof resident !== 'boolean')
      throw new Error('resident must be a boolean')
    if (create === true) {
      const { definitions } = await discoverAgents(
        host.ultimateRoot,
        host.projectRoot,
        host.userHome,
        host.modelRuntime,
      )
      if (definitions.some((definition) => definition.name === name))
        throw new Error(`A definition named ${name} exists already`)
    }
    return saveDefinition(
      host,
      host.modelRuntime,
      scope,
      name,
      {
        description,
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        ...(tools ? { tools } : {}),
        ...(isolate ? { isolate } : {}),
        ...(resident !== undefined ? { resident } : {}),
        ...(onFailure ? { onFailure } : {}),
      },
      instructions,
    )
  },
  /** `{name, scope}`: remove a user or project definition; a built-in or user one of that name applies again. */
  async deleteDefinition(args: JsonValue, { host }: ActionContext) {
    const { name, scope } = (args ?? {}) as Record<string, JsonValue>
    if (typeof name !== 'string') throw new Error('name is required')
    if (scope !== 'user' && scope !== 'project') throw new Error('scope must be user or project')
    return deleteDefinition(host, scope, name)
  },
}

export default function subagents(
  host: Pick<
    ExtensionHost,
    | 'ultimateRoot'
    | 'projectRoot'
    | 'userHome'
    | 'harness'
    | 'metadata'
    | 'modelRuntime'
    | 'home'
    | 'projectSettings'
    | 'use'
    | 'provide'
    | 'resource'
    | 'extensions'
    | 'notice'
    | 'onOpen'
    | 'onClose'
    | 'scanSubmissions'
  >,
) {
  const residentDefinitions = async () =>
    (
      await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
    ).definitions.filter((definition) => definition.resident)
  host.provide('subagents', {
    async residents(_ctx) {
      return (await residentDefinitions()).map(({ name, description }) => ({ name, description }))
    },
    async standing(name, ctx) {
      const definitions = await residentDefinitions()
      const definition = definitions.find((item) => item.name === name)
      if (!definition)
        throw new Error(
          `Unknown standing agent @${name}. Standing agents: ${definitions.map((item) => `@${item.name}`).join(', ') || 'none'}`,
        )
      const root = (await host.harness().conversation(ROOT_CONVERSATION_ID, ctx))!
      const main = await root.agent(ctx)
      return host.harness().commit(async (tx) => {
        const index = await tx.doc(Standing, ROOT_CONVERSATION_ID)
        let id = Object.hasOwn(index, name) ? index[name] : undefined
        // A new conversation starts on the main conversation's model; an existing one keeps the model and thinking
        // level chosen in it, so a refresh changes them only where the definition pins them.
        let base = main
        if (id !== undefined && (await tx.conversation(id))) {
          const own = await tx.doc(AgentDoc, id)
          base = {
            ...main,
            model: own.model ?? main.model,
            thinkingLevel: own.thinkingLevel ?? main.thinkingLevel,
          }
        } else {
          id = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id
          index[name] = id
        }
        const change = definitionAgent(definition, base, host.modelRuntime)
        await configure(tx, id, { ...change, cwd: host.projectRoot })
        Object.assign(await tx.doc(host.metadata, id), { label: 'agent', title: `@${name}` })
        return id
      }, ctx)
    },
  } satisfies SubagentsService)
  const service = () => host.use<WorkspaceService>('workspaces')
  const Reporter = createReporter()
  let unsubscribe: (() => void) | undefined
  let recovery = Promise.resolve()
  const recover = async (submission: SubmissionRecord) => {
    if (
      submission.type !== 'input' ||
      submission.status !== 'done' ||
      submission.requestId?.startsWith('subagent:') ||
      submission.requestId?.startsWith('subagent-retry:')
    )
      return
    await host.harness().commit(async (tx) => {
      const child = await tx.conversation(submission.conversationId)
      const parent = child?.owner?.conversationId
      if (parent === undefined) return
      const state = await tx.doc(Subagents, parent)
      const agent = state.agents[String(submission.conversationId)]
      if (!agent || agent.reported.includes(submission.answer)) return
      const action = Object.values(state.actions).findLast(
        (candidate) => candidate.conversationId === submission.conversationId,
      )
      const interrupted = action?.status === 'interrupted'
      if (action?.status !== 'unanswered' && action?.status !== 'failed' && !interrupted) return
      const failed = await tx.submissionByRequest(
        submission.conversationId,
        action.retryRequest ?? `subagent:${action.reporter}`,
      )
      // IDs share one allocation order; an input withdrawn before placement has no entry.
      if (
        failed?.status !== 'unanswered' ||
        (failed.reason === 'aborted') !== interrupted ||
        (failed.entry === undefined && !interrupted) ||
        submission.entry <= (failed.entry ?? failed.id)
      )
        return
      const answer = (await tx.entry(AssistantEntry, submission.answer))?.model?.[0] as
        | AssistantMessage
        | undefined
      const reporter = await tx.createTask(
        Reporter,
        {
          conversationId: submission.conversationId,
          text: reportText(submission.conversationId, agent.agent, answer),
          steer: false,
          answer: submission.answer,
        },
        { conversationId: parent, ownership: { kind: 'conversation' }, background: true },
      )
      agent.reported.push(submission.answer)
      state.actions[`subagent-answer:${submission.answer}`] = {
        conversationId: submission.conversationId,
        reporter,
        answer: submission.answer,
        status: 'done',
      }
    }, BACKGROUND_CONTEXT)
  }
  host.onClose(async () => {
    unsubscribe?.()
    unsubscribe = undefined
    await recovery
  })
  host.onOpen(async () => {
    unsubscribe?.()
    unsubscribe = host.harness().subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type !== 'submission') continue
        recovery = recovery
          .then(() => recover(change.value))
          .catch((error: unknown) => {
            host.notice(`Subagent answer recovery failed: ${String(error)}`)
          })
      }
    })
    let cursor: Cursor | undefined
    do {
      const page = await host.scanSubmissions({ status: 'done' }, 500, cursor, BACKGROUND_CONTEXT)
      for (const submission of page.items) await recover(submission)
      cursor = page.next
    } while (cursor)
  })
  return defineExtension({
    name: 'subagents',
    tasks: [Anchor, Reporter],
    hooks: [
      hook(GenerationTask, {
        afterTools: async (_assistant, results, api, context) => {
          // Tool settlement is not a receipt. Only committed outer results may acknowledge.
          await host.harness().commit(async (tx) => {
            const answers = new Set<EntryId>()
            for (const id of results) {
              const message = (await tx.entry(ToolResultEntry, id))?.model?.[0]
              if (message?.role !== 'toolResult' || message.isError) continue
              const info = message.details as
                | { answerId?: EntryId; subagentAnswers?: EntryId[] }
                | undefined
              if (message.toolName === 'subagent' && info?.answerId !== undefined)
                answers.add(info.answerId)
              if (message.toolName === 'codemode')
                for (const answer of info?.subagentAnswers ?? []) answers.add(answer)
            }
            if (!answers.size) return
            const submissions = []
            for (const answer of answers)
              submissions.push({
                answer,
                submission: await tx.submissionByRequest(api.conversationId, answerRequest(answer)),
              })
            const queued = submissions.flatMap(({ submission }) =>
              submission?.status === 'queued' ? [submission.id] : [],
            )
            const inbox = await tx.doc(InboxDoc, api.conversationId)
            inbox.items = inbox.items.filter((item) => !queued.includes(item.id))
            for (const { answer, submission } of submissions) {
              // A reporter not yet submitted must also see this receipt through request deduplication.
              if (!submission)
                await tx.createSubmission({
                  conversationId: api.conversationId,
                  requestId: answerRequest(answer),
                  type: 'input',
                  status: 'unanswered',
                  reason: 'subagent-tool-delivered',
                })
              else if (submission.status === 'queued')
                tx.settleSubmission(submission.id, {
                  status: 'unanswered',
                  reason: 'subagent-tool-delivered',
                })
            }
          }, context)
        },
      }),
    ],
    sections: [
      section('subagent_state', async (input, context) => {
        const state = await input.read.snapshot(Subagents, input.conversationId, context)
        const running: string[] = []
        const pending = new Set<ConversationId>()
        for (const action of Object.values(state?.actions ?? {}))
          if (
            action.status === undefined &&
            (await host.harness().getTask(action.reporter, context))?.state.status !== 'terminal'
          )
            pending.add(action.conversationId)
        const queued: string[] = []
        for (const agent of Object.values(state?.agents ?? {})) {
          const label = `${agent.conversationId} (${agent.agent})`
          if (
            (await input.read.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined
          )
            running.push(label)
          else if (pending.has(agent.conversationId)) queued.push(label)
        }
        if (!running.length && !queued.length) return undefined
        return [
          ...(running.length ? [`Still running subagents: ${running.join(', ')}.`] : []),
          ...(queued.length ? [`Pending subagent inputs: ${queued.join(', ')}.`] : []),
          'A yielded wait is not a child answer. Use message, stop, or wait with these IDs; parent stop does not stop them. Queued inputs are delivered only at the normal boundary; do not act on them early.',
        ].join(' ')
      }),
      section('subagents', async (input, context) => {
        const discovered = await discoverAgents(
          host.ultimateRoot,
          host.projectRoot,
          host.userHome,
          host.modelRuntime,
        )
        const conversation = await host
          .harness()
          .commit((tx) => tx.conversation(input.conversationId), context)
        return (
          (conversation?.owner
            ? `Follow your assigned role and instructions. Delegate only the bounded work that role requires.
Do not assume the root coordinator's role, create epics, or spawn implementation workers.
Verify child reports against evidence; never push or ship.
Available definitions:\n`
            : `You coordinate. Own requirements, the plan, decomposition, acceptance criteria,
verification, landing, and the verdict. Delegate bounded execution and reconnaissance,
never judgment. Never accept a child's claim without evidence.
Do quick fixes and simple questions directly, without an epic. Orchestrate substantive work:
several dependent changes, several files or systems, or independent reconnaissance worth doing.
An epic means the full flow: tasks, isolated workers, land, and review before its verdict.

1. Inspect the code and recommend one approach.
   When the user asked a question rather than gave an instruction, stop here for their go.
   Ask only for decisions that change behaviour or scope.
2. Write the epic with the plan tool and binary acceptance criteria.
3. Once you write an epic, every unit of work is a task in it via plan add.
   Give each task a self-contained description for its child.
4. Delegate implementation to workers in worktree isolates.
   Parallel by default: start independent tasks as background children in the same tool round.
   Wait for their answers instead of polling; children touching the same files run sequentially.
   Link each child to its task with plan; record dependencies and status.
5. Workers verify their chunk with checks, tests, and screenshots where needed, and report evidence.
   Read each report and inspect its commit diff. Rerun checks only for missing or thin evidence,
   reported failures, changes crossing workers, server/shared changes, or surprises in the diff.
6. Epic commits come from workers in isolates and reach the checkout only through land.
   Land workers with sufficient evidence into your current checkout, then use workspace submit.
   The lander is the final gate: it runs every configured check on the merged result and reports
   back, landed or not, with findings. It fixes small failures when the project configures it to.
   Use restart only for required server/ and shared/ changes after verification and authorization.
   Discard a child's clean isolate only when explicitly requested; never auto-clean up.
7. Record verification evidence with plan and set the task done; only you do this.
8. When all tasks are done, start one reviewer with the explicit immutable base..head commit
   range, not a directory, and the acceptance criteria. It runs any review team and returns one
   verdict; never start several reviewers yourself.
   Verify the findings yourself; never delegate the verdict.
   Message the responsible worker with confirmed fixes, or create a new task.
   Verify, land, and review fixes before concluding.
9. Post the verdict on the epic with plan and report to the user.

The user's checkout is not a test bed. Never land, commit, or reset in the parent
checkout to test something. Never rewrite, reset, or rebase the user's branch.
Test isolate behaviour in a temporary git repository or a preview instance (instance start, faux).
An idle or finished child is not evidence. Trust concrete worker evidence; investigate gaps and risks.
Never push, merge to remotes, or ship unless the user asks. Children never push.
Available definitions:
`) + discovered.definitions.map((agent) => `${agent.name}: ${agent.description}`).join('\n')
        )
      }),
    ],
    tools: [
      defineTool({
        name: 'subagent',
        description:
          'Delegate to a named agent. start returns its answer (foreground) or id (background). Foreground start/message and wait yield on queued steering with details.yielded:true; work continues independently. Stop children explicitly; stopping the parent does not stop them. message steers a busy child (steer false queues a follow-up instead); wait returns the latest answer; stop stops current work; list shows your children; land verifies and fast-forwards a finished worktree child; discard removes its worktree but keeps its branch. start accepts isolate none or worktree, and fork true to inherit parent history before this call (more context cost; prompt caching usually covers the shared prefix). Background answers join the current run after its tool round.',
        // Call-id receipts deduplicate starts/messages; memoized targets and guards protect stop/workspace replays.
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
                workspace: await service()?.get(agent.conversationId, context),
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
          if (args.action === 'land' || args.action === 'discard') {
            if (await api.memo<boolean>('workspace-operation', context))
              throw new Error('Workspace operation interrupted; call again')
            await api.memo('workspace-operation', true, context)
            const workspaceService = service()
            if (!workspaceService) throw new Error('Workspace operations require workspaces')
            const operation = args.action
            return finish(
              JSON.stringify(await workspaceService[operation](args.id as ConversationId, context)),
            )
          }
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
            if (definition?.tools?.some((name) => !parent.tools.some((tool) => tool.name === name)))
              throw new Error('Definition tools must be a subset of parent tools')
            const isolated =
              definition && (args.isolate ?? definition.isolate ?? 'none') === 'worktree'
            const workspaceService = service()
            if (isolated && !workspaceService)
              throw new Error('Worktree isolates require workspaces')
            const warning =
              isolated &&
              (await workspaceService!.git(parent.cwd ?? host.projectRoot, 'status', '--porcelain'))
                ? '\nWarning: parent has uncommitted changes; they are not in the worktree.'
                : ''
            const task = await api.getTask(api.taskId, context)
            // Pi upstream: @earendil-works/pi-durable@1.3.0 src/harness/tool.ts — internal ToolTaskInput.assistant locates the calling assistant. Drop when ToolExecutionApi exposes the calling assistant entry ID.
            const assistant = (task?.input as { assistant: EntryId } | undefined)?.assistant
            let forkAt: EntryId | undefined
            if (definition && args.fork) {
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
            const summaries =
              definition &&
              host
                .extensions()
                .some(
                  (extension) =>
                    extension.enabled &&
                    extension.server?.docs.includes('ultimate.conversation-summaries'),
                )
            const model = summaries ? await summaryModel(host) : undefined
            const action = await api.commit(async (tx) => {
              const state = await tx.doc(Subagents, api.conversationId)
              if (state.actions[api.callId]) return { ...state.actions[api.callId] }
              let conversationId = args.id as ConversationId
              if (definition) {
                if (summaries)
                  await requestSummary(
                    tx,
                    host,
                    api.conversationId,
                    { reason: 'spawn', answer: assistant!, agent: definition.name, task: text },
                    model,
                  )
                const owner = await tx.createTask(Anchor, null, {
                  ownership: { kind: 'conversation' },
                  background: true,
                })
                const child = await createChild(tx, {
                  owner: { kind: 'task', taskId: owner },
                  definition,
                  parentAgent: parent,
                  modelRuntime: host.modelRuntime,
                  metadata: host.metadata,
                  label: definition.name,
                  title: text,
                  excludeTools: definition.tools?.includes('subagent') ? [] : ['subagent'],
                  excludeExtensions: definition.tools?.includes('subagent') ? [] : ['subagents'],
                  ...(forkAt === undefined
                    ? {}
                    : { fork: { conversationId: api.conversationId, at: forkAt } }),
                  cwd: parent.cwd ?? host.projectRoot,
                })
                conversationId = child.id
                state.agents[String(child.id)] = {
                  conversationId,
                  agent: definition.name,
                  background: args.background === true,
                  reported: [],
                }
                if (isolated) {
                  const workspace = await workspaceService!.create(
                    tx,
                    child.id,
                    parent.cwd ?? host.projectRoot,
                  )
                  await configure(tx, child.id, {
                    instructions: `${definition.instructions}\nWork only in ${workspace.path} on ${workspace.branch}, cut from ${workspace.base}. Commit your work on this branch with clear messages. Never push and never touch other checkouts.`,
                  })
                }
              }
              const reporter = await tx.createTask(
                Reporter,
                {
                  conversationId,
                  text,
                  steer: args.steer !== false,
                  ...(assistant ? { sourceEntry: assistant } : {}),
                },
                { ownership: { kind: 'conversation' }, background: true },
              )
              const createdAction = { conversationId, reporter }
              state.actions[api.callId] = createdAction
              return createdAction
            }, context)
            const isolate = await service()?.get(action.conversationId, context)
            const isolateInfo = isolate
              ? `\nIsolate: ${isolate.path}\nBranch: ${isolate.branch}${warning}`
              : ''
            const background =
              index.agents[String(action.conversationId)]?.background ?? args.background === true
            const info = details(action.conversationId, background)
            await api.details(info, context)
            if (background)
              return finish(
                `Started ${args.action === 'message' ? 'message to' : 'subagent'} ${action.conversationId}.${isolateInfo}`,
                info,
              )
            if (
              !(await waitInterruptibly(
                api,
                action.conversationId,
                [action.reporter],
                false,
                context,
              ))
            )
              return finish(
                `Wait yielded for subagent ${action.conversationId}; work continues.${isolateInfo}`,
                details(action.conversationId, background, { yielded: true }),
              )
            const settled = (await api.snapshot(Subagents, api.conversationId, context))!.actions[
              api.callId
            ]
            const answer =
              settled.answer === undefined
                ? undefined
                : await api.commit((tx) => tx.entry(AssistantEntry, settled.answer!), context)
            return finish(
              (answer
                ? replyText(
                    action.conversationId,
                    answer.model?.[0] as AssistantMessage | undefined,
                  )
                : `Subagent ${action.conversationId}: ${settled.status}`) + isolateInfo,
              details(
                action.conversationId,
                background,
                settled.answer === undefined ? undefined : { answerId: settled.answer },
              ),
            )
          }
          const id = args.id as ConversationId
          const info = details(id, index.agents[String(id)].background)
          await api.details(info, context)
          if (args.action === 'stop') {
            // Capture identities before cancellation; replay must leave later reuse alone.
            const live = await api.snapshot(LiveDoc, id, context)
            const state = await api.snapshot(Subagents, api.conversationId, context)
            const target = await api.memo(
              'stopTarget',
              {
                run: live?.run?.taskId ?? null,
                inputs: live?.run?.inputs ?? [],
                reporters: Object.values(state?.actions ?? {}).flatMap((action) =>
                  action.conversationId === id ? [action.reporter] : [],
                ),
              },
              context,
            )
            // Join delivery invocations before inspecting admissions that may have raced stop.
            for (const reporter of target.reporters) {
              await host.harness().abortTask(reporter, context)
              await api.waitForTask(reporter, context)
            }
            const submissions = await api.commit(async (tx) => {
              const captured = await tx.doc(Subagents, api.conversationId)
              const retries = Object.values(captured.actions).flatMap((action) =>
                target.reporters.includes(action.reporter) && action.retryRequest
                  ? [action.retryRequest]
                  : [],
              )
              return Promise.all(
                [
                  ...new Set([
                    ...target.reporters.map((reporter) => `subagent:${reporter}`),
                    ...retries,
                  ]),
                ].map((request) => tx.submissionByRequest(id, request)),
              )
            }, context)
            for (const submission of submissions)
              if (submission?.status === 'queued')
                await host.harness().abortSubmission(submission.id, context, id)
            const inputs = new Set([
              ...target.inputs,
              ...submissions.flatMap((submission) => (submission ? [submission.id] : [])),
            ])
            // A tool round can hand off between the snapshot and abort; follow only captured inputs.
            while (true) {
              const run = (await api.snapshot(LiveDoc, id, context))?.run
              if (
                !run ||
                (run.taskId !== target.run && !run.inputs.some((input) => inputs.has(input)))
              )
                break
              await host.harness().abortTask(run.taskId, context)
              await api.waitForTask(run.taskId, context)
            }
            return finish(`Stopped ${id}.`, info)
          }
          const reporters = Object.values(index.actions).flatMap((action) =>
            action.conversationId === id ? [action.reporter] : [],
          )
          if (!(await waitInterruptibly(api, id, reporters, true, context)))
            return finish(
              `Wait yielded for subagent ${id}; work continues.`,
              details(id, index.agents[String(id)].background, { yielded: true }),
            )
          const answer = await api.commit(async (tx) => {
            let cursor: Cursor | undefined
            let latest: EntryRecord | undefined
            do {
              const page = await tx.scanEntries({ conversationId: id }, 256, cursor)
              for (const entry of page.items)
                if (AssistantEntry.is(entry) && latest === undefined) latest = entry
              cursor = page.next
            } while (cursor !== undefined)
            if (!latest) return undefined
            const agent = (await tx.doc(Subagents, api.conversationId)).agents[String(id)]
            if (!agent.reported.includes(latest.id)) agent.reported.push(latest.id)
            return latest
          }, context)
          return finish(
            replyText(id, answer?.model?.[0] as AssistantMessage | undefined),
            details(
              id,
              index.agents[String(id)].background,
              answer === undefined ? undefined : { answerId: answer.id },
            ),
          )
        },
      }),
    ],
  })
}
