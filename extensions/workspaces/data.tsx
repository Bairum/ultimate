import { useSyncExternalStore } from 'react'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import { useConversations } from '@/sdk'
import type { ConversationSummary } from '@/sdk'
import type { Workspace, WorkspaceIndex } from './types.ts'

export type WorkspaceConversation = ConversationSummary & { workspace?: Workspace }
let items: WorkspaceIndex['items'] = {}
const listeners = new Set<() => void>()
let stream: EventSource | undefined
export const getWorkspaces = () => items
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!stream) {
    stream = new EventSource('/api/events?conversation=1&docs=ultimate.workspaces')
    const publish = () => {
      for (const notify of listeners) notify()
    }
    stream.addEventListener('doc', (event) => {
      const data = JSON.parse(event.data) as { kind: string; value: WorkspaceIndex | null }
      if (data.kind !== 'ultimate.workspaces') return
      items = data.value?.items ?? {}
      publish()
    })
    stream.addEventListener('docOps', (event) => {
      const data = JSON.parse(event.data) as { kind: string; ops: Op[] }
      if (data.kind !== 'ultimate.workspaces') return
      items = applyImmutable({ items }, data.ops).items
      publish()
    })
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      stream?.close()
      stream = undefined
    }
  }
}
export function useWorkspaces() {
  return useSyncExternalStore(subscribe, getWorkspaces)
}
export function useWorkspaceConversations(): WorkspaceConversation[] {
  const records = useWorkspaces()
  return useConversations().map((conversation) => ({
    ...conversation,
    workspace: records[String(conversation.id)],
  }))
}
