import { Type } from '@earendil-works/pi-ai'
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  section,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ContextHygiene, Ledger } from '../context-hygiene/api.ts'
import type { Range } from './refs.ts'
import { prune, rewrite, turns, validate } from './rewrite.ts'

export const Ranges = defineDoc<{ ranges: Range[] }>({
  kind: 'context-compress.ranges',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
  initial: () => ({ ranges: [] }),
})
export const docs = [Ranges]
const reply = (value: object) => ({
  output: [{ type: 'text' as const, text: JSON.stringify(value) }],
})
export default function contextCompress(host: Pick<ExtensionHost, 'harness' | 'need' | 'notice'>) {
  const hygiene = host.need(ContextHygiene)
  return defineExtension({
    name: 'context-compress',
    sections: [
      section(
        'context-compress',
        () =>
          'After finishing a sub-task, or when context_ranges shows large old turns, compress finished context with your own summary. Prefer a few large ranges. The newest 16k tokens are protected. Stored history stays complete; decompress restores a range on the next request.',
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, ctx) => {
          try {
            const conversation = await host.harness().conversation(api.conversationId, ctx)
            if (!conversation) throw new Error('Conversation unavailable')
            const view = await conversation.context(ctx)
            const ranges = await host.harness().commit(async (tx) => {
              const ledger = await tx.doc(Ranges, api.conversationId)
              prune(ledger.ranges, view)
              return ledger.ranges.map((range) => ({ ...range }))
            }, ctx)
            const ledger = await api.snapshot(Ledger, api.conversationId, ctx)
            return {
              messages: rewrite(messages, view, ranges, (batch) =>
                hygiene.rewrite(batch, ledger?.decisions ?? {}),
              ),
            }
          } catch (error) {
            // Compression is advisory: never block generation or send a partially folded request.
            host.notice(`Context compression skipped: ${String(error)}`)
            return undefined
          }
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'context_ranges',
        description:
          'List whole compressible turns older than the newest 16k estimated tokens and active compressed ranges. Use turn ids as compress endpoints.',
        // Listing and idempotent pruning do not change history.
        replay: 'safe',
        parameters: Type.Object({}),
        execute: async (_args, api, ctx) => {
          const conversation = await host.harness().conversation(api.conversationId, ctx)
          if (!conversation) throw new Error('Conversation unavailable')
          const view = await conversation.context(ctx)
          return api.commit(async (tx) => {
            const { ranges } = await tx.doc(Ranges, api.conversationId)
            prune(ranges, view)
            return reply({ turns: turns(view, ranges), ranges: ranges.filter((r) => r.active) })
          }, ctx)
        },
      }),
      defineTool({
        name: 'compress',
        description:
          'Fold contiguous whole old turns from context_ranges into your summary on the next request. Summary must be non-empty and at most 25% of original estimated tokens. Active ranges cannot overlap.',
        // The tool task id is a durable receipt: replay returns its existing range.
        replay: 'safe',
        parameters: Type.Object({
          from: Type.Integer(),
          to: Type.Integer(),
          summary: Type.String(),
        }),
        execute: async (args, api, ctx) => {
          const conversation = await host.harness().conversation(api.conversationId, ctx)
          if (!conversation) throw new Error('Conversation unavailable')
          const view = await conversation.context(ctx)
          return api.commit(async (tx) => {
            const { ranges } = await tx.doc(Ranges, api.conversationId)
            const id = `c${api.taskId}`
            const existing = ranges.find((r) => r.id === id)
            if (existing)
              return reply({
                ...existing,
                saved: existing.tokens - estimateTextTokens(existing.summary),
              })
            prune(ranges, view)
            const selected = validate(view, ranges, args.from, args.to, args.summary)
            const range = { id, ...selected, summary: args.summary, active: true, at: Date.now() }
            ranges.push(range)
            return reply({ ...range, saved: range.tokens - estimateTextTokens(range.summary) })
          }, ctx)
        },
      }),
      defineTool({
        name: 'decompress',
        description:
          'Restore a compressed range by id on the next request. Stored history is never changed.',
        // Marking a range inactive twice is idempotent.
        replay: 'safe',
        parameters: Type.Object({ id: Type.String() }),
        execute: async ({ id }, api, ctx) =>
          api.commit(async (tx) => {
            const { ranges } = await tx.doc(Ranges, api.conversationId)
            const range = ranges.find((r) => r.id === id)
            if (!range) throw new Error(`Unknown compressed range ${id}`)
            range.active = false
            return reply({ id, restored: true })
          }, ctx),
      }),
    ],
  })
}
