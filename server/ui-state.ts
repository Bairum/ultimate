import { defineDoc } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'

export const UiState = defineDoc<Record<string, JsonValue>>({
  kind: 'ultimate.ui',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({}),
})
