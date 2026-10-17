import { api } from '@/sdk'
import type { UltimateActions } from '@/sdk'

/** Show @ultimate's standing conversation on the Agent surface; it starts branches and keeps the tallies. */
export async function talkToUltimate(
  actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>,
) {
  const id = await api.action<number>('subagents', 'standing', { name: 'ultimate' })
  actions.switchConversation(id)
  actions.showSurface('agent')
}
