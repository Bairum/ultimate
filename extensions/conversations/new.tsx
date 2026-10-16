import type { UltimateActions } from '@/sdk'
import { openStart } from '../lineage/start.tsx'

export const newKeys = 'mod+alt+n'

/** Show the start page on the Agent surface: a branch from the shown tree's root, or a new root. */
export function createConversation(actions: UltimateActions, isolated?: boolean) {
  actions.showSurface('agent')
  openStart({}, { isolated })
}
