import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type { EntryRecord, LiveState, ToolDiagnostic, ToolSlot } from '@earendil-works/pi-durable'
import type { ToolCallView } from '../sdk/types.ts'

export interface ToolResult {
  message: ToolResultMessage
  diagnostics: readonly ToolDiagnostic[]
}

/** Tool results by call id, and the ids of calls some assistant entry made. */
export function indexTools(entries: readonly EntryRecord[]) {
  const results = new Map<string, ToolResult>()
  const calls = new Set<string>()
  for (const entry of entries) {
    const message = entry.model?.[0]
    if (entry.kind === 'pi.tool-result' && message?.role === 'toolResult') {
      const data = entry.data as { diagnostics?: ToolDiagnostic[] } | undefined
      results.set(message.toolCallId, {
        message,
        diagnostics: data?.diagnostics ?? [],
      })
    }
    if (entry.kind === 'pi.assistant' && message?.role === 'assistant')
      for (const block of message.content) if (block.type === 'toolCall') calls.add(block.id)
  }
  return { results, calls }
}

export function slotsOf(tools: LiveState['tools']): Map<string, ToolSlot> {
  return new Map((tools ?? []).map((slot) => [slot.callId, slot]))
}

// Pi upstream: @earendil-works/pi-durable@1.3.0 src/harness/tool.ts — internal trailing <harness> text block duplicates diagnostics and is stripped for display. Drop when Pi exports a diagnostic-free tool-result content accessor.
/** The result's text, without the `<harness>` block that repeats its diagnostics for the model. */
export function resultText(result: ToolResult): string {
  const texts = result.message.content.flatMap((block) =>
    block.type === 'text' ? [block.text] : [],
  )
  if (result.diagnostics.length > 0 && texts.at(-1)?.startsWith('<harness>')) texts.pop()
  return texts.join('')
}

/** When this page saw each call start and end; calls that finished before the page loaded have none. */
const observed = new Map<string, { start?: number; end?: number }>()

export function toolCallView(
  call: ToolCall,
  context: { result?: ToolResult; slot?: ToolSlot; streaming: boolean; busy: boolean },
): ToolCallView {
  const { result, slot, streaming, busy } = context
  let status: ToolCallView['status']
  if (result) status = result.message.isError ? 'error' : 'done'
  else if (slot) status = slot.status === 'done' ? 'interrupted' : slot.status
  else if (streaming) status = 'streaming'
  else status = busy ? 'pending' : 'interrupted'

  let timing = observed.get(call.id)
  if (!timing) {
    timing = {}
    observed.set(call.id, timing)
    // A call first seen finished has no observed start; one seen live gets its start now.
    if (status === 'pending' || status === 'running') timing.start = Date.now()
  } else if (timing.start === undefined && status === 'running') timing.start = Date.now()
  if (
    timing.start !== undefined &&
    timing.end === undefined &&
    (result || status === 'interrupted')
  )
    timing.end = Date.now()

  return {
    id: call.id,
    name: call.name,
    args: call.arguments ?? {},
    status,
    output: result ? resultText(result) : (slot?.output ?? ''),
    images: result?.message.content.filter((block) => block.type === 'image') ?? [],
    details: result ? result.message.details : slot?.details,
    diagnostics: result?.diagnostics ?? slot?.diagnostics ?? [],
    ...(slot?.droppedBytes
      ? { dropped: { bytes: slot.droppedBytes, lines: slot.droppedLines ?? 0 } }
      : {}),
    startedAt: timing.start,
    endedAt: timing.end,
    result: result?.message,
  }
}

/** The streaming partial of the current generation, if any. */
export function partialOf(live: LiveState): AssistantMessage | undefined {
  return live.generation?.message
}
