import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  configure,
  defineExtension,
  defineTool,
  hook,
  ROOT_CONVERSATION_ID,
  section,
  ToolTask,
} from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Workspaces, workspaces } from './workspaces.ts'
export const order = -200
export const docs = [Workspaces]
const finish = (value: unknown) => ({
  output: [{ type: 'text' as const, text: JSON.stringify(value) }],
})
function workspaceId(args: JsonValue) {
  const id = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new Error('Expected a workspace conversation id')
  return id as ConversationId
}
export const actions = {
  async create(args: JsonValue, { host }: ActionContext) {
    const input = (args ?? {}) as { cwd?: string; title?: string }
    if (input.cwd !== undefined && typeof input.cwd !== 'string')
      throw new Error('cwd must be a string')
    if (input.title !== undefined && typeof input.title !== 'string')
      throw new Error('title must be a string')
    const root = (await host.harness().conversation(ROOT_CONVERSATION_ID, context))!
    const agent = await root.agent(context)
    const id = await host.harness().commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await configure(tx, conversation.id, {
        model: agent.model,
        thinkingLevel: agent.thinkingLevel,
      })
      if (input.title) (await tx.doc(host.metadata, conversation.id)).title = input.title
      await workspaces(host).create(tx, conversation.id, input.cwd ?? host.projectRoot)
      return conversation.id
    }, context)
    host.harness().resume()
    return { id }
  },
  info(args: JsonValue, { host }: ActionContext) {
    return workspaces(host).info(workspaceId(args), context)
  },
  land(args: JsonValue, { host }: ActionContext) {
    return workspaces(host).land(workspaceId(args), context)
  },
  submit(args: JsonValue, { host }: ActionContext) {
    return workspaces(host).submit(workspaceId(args), context)
  },
  discard(args: JsonValue, { host }: ActionContext) {
    return workspaces(host).discard(workspaceId(args), context)
  },
  stats(_args: JsonValue, { host }: ActionContext) {
    return workspaces(host).stats(context)
  },
}
export default function workspaceExtension(host: ExtensionHost) {
  const service = workspaces(host)
  const resume = () =>
    service.resume(context).catch((error: unknown) => {
      host.notice(`Lander resume failed: ${String(error)}`)
    })
  let unsubscribe: (() => void) | undefined
  // A lander task that faults leaves its queue behind. One run by older code, as on a reload of this code that changed
  // the Workspaces document, is replaced at once; a fault of this code's own task would only repeat, so it waits for
  // the next submit or open. Opening (and each reload while open) picks up any such queue. An aborted task stays
  // stopped until then too.
  host.onOpen(async () => {
    unsubscribe?.()
    unsubscribe = host.harness().subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (
          change.type !== 'task' ||
          change.value.kind !== service.Lander.definition.name ||
          change.value.state.status !== 'terminal' ||
          change.value.state.outcome.status !== 'faulted'
        )
          continue
        if (service.started.has(change.value.id))
          host.notice(
            `Lander task ${change.value.id} faulted: ${change.value.state.outcome.error.message}; its queue resumes on the next submit or restart`,
          )
        else void resume()
      }
    })
    await resume()
  })
  host.onClose(async () => {
    unsubscribe?.()
    unsubscribe = undefined
  })
  return defineExtension({
    name: 'workspaces',
    tasks: [service.Preparation, service.Lander],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (_call, api, caller) => {
          const workspace = await service.get(api.conversationId, caller)
          if (workspace?.state === 'failed')
            return { block: `Workspace setup failed: ${workspace.error}; start a new conversation` }
          if (workspace?.state === 'removed')
            return { block: 'This workspace was removed; start a new conversation' }
          return undefined
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'workspace',
        description:
          'Inspect your workspace and source tips; submit your clean, verified tip to the lander, which merges it into the target branch, runs the configured checks, fast-forwards the target, pushes when configured, and reports back; or land it synchronously by fast-forward (never rebases or pushes).',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('status'),
            Type.Literal('submit'),
            Type.Literal('land'),
          ]),
        }),
        async execute({ action }, api, caller) {
          if (action === 'status')
            return finish({
              conversationId: api.conversationId,
              workspace: await service.info(api.conversationId, caller),
            })
          await api.commit(async (tx) => {
            const row = await tx.conversation(api.conversationId)
            if (
              !row ||
              row.owner ||
              Object.values(
                (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).landerConversations,
              ).includes(api.conversationId)
            )
              throw new Error(`Only a top-level main conversation can ${action} its own workspace`)
          }, caller)
          if (action === 'submit') return finish(await service.submit(api.conversationId, caller))
          return finish(await service.land(api.conversationId, caller, true))
        },
      }),
    ],
    sections: [
      section('workspace_workflow', async (input, caller) => {
        await service.ready(input.conversationId, caller)
        const own = await service.get(input.conversationId, caller)
        if (!own) return undefined
        return `Workspace: ${own.path} (branch ${own.branch}).\nSource: ${own.source}, target: ${own.target}.\n\`workspace status\` shows both tips. Finish with \`workspace submit\` once your tip is committed and verified: the lander merges it into ${own.target} with whatever landed meanwhile, runs the project's checks, fast-forwards ${own.target}, pushes when configured, and reports the outcome back to you as a message; keep working meanwhile and do not merge ${own.target} yourself first. \`workspace land\` is the synchronous alternative: it only fast-forwards ${own.target} to your tip and never rebases or pushes.`
      }),
    ],
  })
}
