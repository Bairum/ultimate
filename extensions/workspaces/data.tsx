import { useState, useSyncExternalStore } from 'react'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import { api, errorMessage, useConversations } from '@/sdk'
import type { ConversationSummary } from '@/sdk'
import type { LandResult, Workspace, WorkspaceIndex } from './types.ts'

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

export const stateLabel = (workspace: Workspace) =>
  ({ preparing: 'Setting up…', ready: 'Ready', failed: 'Setup failed', removed: 'Removed' })[
    workspace.state
  ]

/** Land or remove the workspace of conversation `id`, then call `done`; the outcome stays until the next attempt. */
export function useWorkspaceAction(id: number, done: () => unknown) {
  const [pending, setPending] = useState<'land' | 'discard'>()
  const [outcome, setOutcome] = useState<{ error?: boolean; text: string }>()
  const run = async (operation: 'land' | 'discard') => {
    setPending(operation)
    setOutcome(undefined)
    try {
      const result = await api.action<LandResult>('workspaces', operation, {
        id,
        ...(operation === 'discard' && { confirm: true }),
      })
      if (operation === 'land') {
        const count = result.commits?.length ?? 0
        setOutcome({
          text: `${count ? `Landed ${count} commit${count === 1 ? '' : 's'}.` : 'Nothing to land.'}${result.needsRestart ? ' Restart to apply server/ or shared/ changes.' : ''}`,
        })
      }
    } catch (error) {
      setOutcome({ error: true, text: errorMessage(error) })
    } finally {
      setPending(undefined)
      await done()
    }
  }
  return { pending, outcome, land: () => run('land'), remove: () => run('discard') }
}
