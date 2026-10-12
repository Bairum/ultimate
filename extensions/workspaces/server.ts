import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

function service(host: Pick<ExtensionHost, 'workspaces'>) {
  const workspaces = host.workspaces
  if (!workspaces?.doc || !workspaces.info || !workspaces.runLifecycle)
    throw new Error(
      'workspaces requires core workspace info and lifecycle; upgrade and restart the Ultimate core before loading this facet',
    )
  return workspaces
}

function workspaceId(args: JsonValue) {
  const id = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new Error('Expected a workspace conversation id')
  return id as ConversationId
}

export const actions = {
  info(args: JsonValue, { host }: ActionContext) {
    return service(host).info(workspaceId(args), context)
  },
  land(args: JsonValue, { host, conversationId }: ActionContext) {
    const id = workspaceId(args)
    return service(host).runLifecycle((conversationId ?? id) as ConversationId, id, 'land', context)
  },
  discard(args: JsonValue, { host, conversationId }: ActionContext) {
    const id = workspaceId(args)
    if (!args || typeof args !== 'object' || Array.isArray(args) || args.confirm !== true)
      throw new Error('Confirm clean-only discard; the branch and history will be kept')
    return service(host).runLifecycle(
      (conversationId ?? id) as ConversationId,
      id,
      'discard',
      context,
    )
  },
}

export default function workspaceExtension(host: Pick<ExtensionHost, 'workspaces'>) {
  service(host)
  return defineExtension({ name: 'workspaces' })
}
