import { defineDoc } from '@earendil-works/pi-durable'

export const Metadata = defineDoc<{ title?: string; agent?: string; background?: boolean }>({
  kind: 'ultimate.metadata',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
