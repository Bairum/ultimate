/**
 * Codemode on the server: the document that keeps a one-line summary of each codemode call, for extensions that write
 * or read it (faux previews seed it).
 */
import { defineDoc } from '@earendil-works/pi-durable'
import { SummariesDoc } from './refs.ts'
import type { Summaries } from './refs.ts'

/** The one-line summaries of a conversation's codemode calls, by call id. */
export const SummaryDoc = defineDoc<Summaries>({
  kind: SummariesDoc.kind,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({ calls: {} }),
})
