import type { EntryRecord } from '@earendil-works/pi-durable'

/** Pi inputs and harness-marked typed inputs count; user-role writes are context, not requests. */
export const isInput = (entry: EntryRecord) => entry.kind === 'pi.user' || entry.input === true

/** The images an entry carries in its user or tool-result messages: a pasted input, a screenshot, forwarded images. */
export function imagesOf(entry: EntryRecord | undefined) {
  return (entry?.model ?? []).flatMap((message) =>
    (message.role === 'user' || message.role === 'toolResult') &&
    typeof message.content !== 'string'
      ? message.content.flatMap((block) =>
          block.type === 'image'
            ? [{ type: 'image' as const, data: block.data, mimeType: block.mimeType }]
            : [],
        )
      : [],
  )
}
