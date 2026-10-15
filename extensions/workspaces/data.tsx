import { useState } from 'react'
import { api, errorMessage, useConversations, useDocOf } from '@/sdk'
import type { ConversationSummary } from '@/sdk'
import type { LandResult, Workspace, WorkspaceIndex } from './types.ts'

export type WorkspaceConversation = ConversationSummary & { workspace?: Workspace }
const none: WorkspaceIndex = {
  items: {},
  queue: [],
  landers: {},
  landerConversations: {},
  results: {},
}
export function useWorkspaces() {
  return useWorkspaceIndex().items
}
/** The whole root index: queue, lander conversations and recent outcomes. */
export function useWorkspaceIndex() {
  return useDocOf<WorkspaceIndex>(1, 'ultimate.workspaces') ?? none
}
/** Submissions waiting for or being processed by a lander, oldest first. */
export function useLanderQueue() {
  return useWorkspaceIndex().queue
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

/** Land, submit or remove the workspace of conversation `id`, then call `done`; the outcome stays until the next attempt. */
export function useWorkspaceAction(id: number, done: () => unknown) {
  const [pending, setPending] = useState<'land' | 'submit' | 'discard'>()
  const [outcome, setOutcome] = useState<{ error?: boolean; text: string }>()
  const run = async (operation: 'land' | 'submit' | 'discard') => {
    setPending(operation)
    setOutcome(undefined)
    try {
      const result = await api.action<LandResult>('workspaces', operation, {
        id,
      })
      if (operation === 'land') {
        const count = result.commits?.length ?? 0
        setOutcome({
          text: `${count ? `Landed ${count} commit${count === 1 ? '' : 's'}.` : 'Nothing to land.'}${result.needsRestart ? ' Restart to apply server/ or shared/ changes.' : ''}`,
        })
      }
      if (operation === 'submit') setOutcome({ text: result.text })
    } catch (error) {
      setOutcome({ error: true, text: errorMessage(error) })
    } finally {
      setPending(undefined)
      await done()
    }
  }
  return {
    pending,
    outcome,
    land: () => run('land'),
    submit: () => run('submit'),
    remove: () => run('discard'),
  }
}
