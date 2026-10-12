import { defineDoc } from '@earendil-works/pi-durable'

/** What the shell calls a conversation: its title, and a short label its creator gives it. */
export const Metadata = defineDoc<{ title?: string; titleSource?: 'input'; label?: string }>({
  kind: 'ultimate.metadata',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
