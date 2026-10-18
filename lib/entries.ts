import type { EntryRecord } from '@earendil-works/pi-durable'

/** Pi inputs and harness-marked typed inputs count; user-role writes are context, not requests. */
export const isInput = (entry: EntryRecord) => entry.kind === 'pi.user' || entry.input === true
