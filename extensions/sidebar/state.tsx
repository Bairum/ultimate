import { useUiState } from '@/sdk'
import type { JsonValue } from '@/sdk'

/** The sidebar's durable UI state, under the keys it had as part of conversations (`ext.conversations.<key>`). */
export const useSidebarState = <T extends JsonValue>(key: string, initial: T) =>
  useUiState<T>(`ext.conversations.${key}`, initial)
