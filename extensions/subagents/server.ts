import { Type } from '@earendil-works/pi-ai'
import type { AssistantMessage } from '@earendil-works/pi-ai'
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
import type { ExtensionHost } from '../../server/extensions.ts'
import { discoverAgents } from '../../server/agents.ts'

import { Metadata } from '../../server/metadata.ts'
export const Subagents = defineDoc<{
  agents: Record<
    string,
    { conversationId: ConversationId; agent: string; background: boolean; reported: EntryId[] }
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

const reply = (text: string, conversationId?: ConversationId) => ({
  content: [{ type: 'text' as const, text }],
  ...(conversationId === undefined ? {} : { details: { conversationId } }),
})

export default function subagents(host: Pick<ExtensionHost, 'repoRoot' | 'home' | 'harness'>) {
  return defineExtension({
    name: 'subagents',
    tasks: [Anchor, Reporter],
    sections: [
      section('subagents', async (input) => {
        const discovered = await discoverAgents(
          host.repoRoot,
          input.env?.cwd ?? host.repoRoot,
          host.home,
        )
        return (
          'You coordinate. Delegate bounded, self-contained research, reconnaissance, review, and isolated implementation to subagents. Run independent work in parallel in the background. Verify results before relying on them.\nAvailable definitions:\n' +
          discovered.definitions.map((agent) => `${agent.name}: ${agent.description}`).join('\n')
        )
      }),
    ],
    tools: [
      defineTool({
        name: 'subagent',
        description:
          'Delegate to a named agent. start returns its answer (foreground) or id (background). message sends a follow-up or steer; wait returns the latest answer; stop stops current work; list shows your children. Background answers join the current run after its tool round.',
        replay: 'safe',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('start'),
            Type.Literal('message'),
            Type.Literal('wait'),
            Type.Literal('stop'),
            Type.Literal('list'),
          ]),
          agent: Type.Optional(Type.String()),
          task: Type.Optional(Type.String()),
          background: Type.Optional(Type.Boolean()),
          id: Type.Optional(Type.Integer({ minimum: 1 })),
          text: Type.Optional(Type.String()),
          steer: Type.Optional(Type.Boolean()),
        }),
        execute: async (args, api, context) => {
          const cached = await api.memo<ReturnType<typeof reply>>('result', context)
          if (cached) return cached
          const finish = (text: string, id?: ConversationId) =>
            api.memo('result', reply(text, id), context)
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
                    await discoverAgents(host.repoRoot, parent.cwd ?? host.repoRoot, host.home)
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
                  instructions: definition.instructions,
                  ...(definition.model ? { model: definition.model } : {}),
                  ...(definition.thinking ? { thinkingLevel: definition.thinking } : {}),
                })
                Object.assign(await tx.doc(Metadata, child.id), {
                  agent: definition.name,
                  title: text,
                  background: args.background === true,
                })
                state.agents[String(child.id)] = {
                  conversationId,
                  agent: definition.name,
                  background: args.background === true,
                  reported: [],
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
            await api.details({ conversationId: action.conversationId }, context)
            if (action.reporter !== undefined)
              return finish(
                `Started ${args.action === 'message' ? 'message to' : 'subagent'} ${action.conversationId}.`,
                action.conversationId,
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
                `Subagent ${action.conversationId}: ${settled.status}`,
                action.conversationId,
              )
            const answer = await api.commit(
              (tx) => tx.entry(AssistantEntry, settled.answer),
              context,
            )
            return finish(
              textOf(answer?.model?.[0] as AssistantMessage | undefined),
              action.conversationId,
            )
          }
          const id = args.id as ConversationId
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
            return finish(`Stopped ${id}.`, id)
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
          return finish(textOf(answer?.model?.[0] as AssistantMessage | undefined), id)
        },
      }),
    ],
  })
}
