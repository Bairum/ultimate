import { defineDoc } from '@earendil-works/pi-durable'

/** Published shell metadata: explicit naming plus input naming and activity maintained by conversations. */
export const Metadata = defineDoc<{
  title?: string
  label?: string
  inputTitle?: string
  inputAt?: number
  answerAt?: number
}>({
  kind: 'ultimate.metadata',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
