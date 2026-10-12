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
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
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
  discard(args: JsonValue, { host }: ActionContext) {
    return workspaces(host).discard(workspaceId(args), context)
  },
}
export default function workspaceExtension(host: ExtensionHost) {
  const service = workspaces(host)
  return defineExtension({
    name: 'workspaces',
    tasks: [service.Preparation],
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
          'Inspect your workspace and source tips, or land your clean, verified tip into its saved destination branch. Never rebases or pushes.',
        parameters: Type.Object({
          action: Type.Union([Type.Literal('status'), Type.Literal('land')]),
        }),
        async execute({ action }, api, caller) {
          if (action === 'status')
            return finish({
              conversationId: api.conversationId,
              workspace: await service.info(api.conversationId, caller),
            })
          await api.commit(async (tx) => {
            const row = await tx.conversation(api.conversationId)
            if (!row || row.owner || row.parent)
              throw new Error('Only a top-level main conversation can land its own workspace')
          }, caller)
          return finish(await service.land(api.conversationId, caller, true))
        },
      }),
    ],
    sections: [
      section('workspace_workflow', async (input, caller) => {
        await service.ready(input.conversationId, caller)
        const own = await service.get(input.conversationId, caller)
        if (!own) return undefined
        return `Workspace: ${own.path} (branch ${own.branch}).\nSource: ${own.source}, target: ${own.target}.\n\`workspace status\` shows both tips; \`workspace land\` fast-forwards ${own.target} to your clean, verified tip; it never rebases or pushes.`
      }),
    ],
  })
}
