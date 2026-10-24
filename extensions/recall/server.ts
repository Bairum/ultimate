import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import { isInput } from '../../lib/entries.ts'
import { ClassifyApi } from '../classify/api.ts'
import type { ClassifyQuestion } from '../classify/api.ts'
import { ContextUsageDoc } from '../conversations/api.ts'
import { LineageApi } from '../lineage/api.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import { Standing } from '../subagents/api.ts'
import { RecallDoc } from './refs.ts'
import type { RecallState } from './refs.ts'
import { RECALL_ENTRY } from './types.ts'
import type { Recalled } from './types.ts'

/** Below this context fill a memory is still fresh in the prompt: nothing is recalled. */
export const FROM_PERCENT = 0 // PREVIEW ONLY: revert to 20 before submit
/** A memory recalled within this share of the context window is not recalled again. */
const AGAIN_AFTER = 0.3
/** Tuned on 55 labelled messages from three chapters: precision 0.77, recall 0.62 (`extensions/recall/README.md`). */
export const THRESHOLD = 0.25
const TOP = 3

export const Recall = defineDoc<RecallState>({
  kind: RecallDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ injected: {} }),
})
export const docs = [Recall]

const INSTRUCTIONS =
  '@ultimate, a coding agent, just received `message` from `from`. Judge what the sender intends and what @ultimate must do next, not which words or topics appear; messages are often casual or indirect. Which project memory tells @ultimate how to handle exactly this situation, so that without recalling it @ultimate would likely act differently? When a branch reports to @ultimate, the memories about how @ultimate handles such reports (what to relay, what to do after a landing) are triggered by what the report contains; a memory about the feature the branch built usually is not. Standing habits that hold for every message are not triggered by an ordinary message. Pick none when nothing is specifically triggered.'

/** One choice over every memory's line, plus `none`. */
export function recallQuestion(memories: Record<string, MemoryItem>): ClassifyQuestion {
  const criteria: Record<string, string> = {
    none: 'No memory is specifically triggered by this message.',
  }
  for (const [slug, item] of Object.entries(memories)) criteria[slug] = item.line
  return { type: 'choice', instructions: INSTRUCTIONS, criteria }
}

const textOf = (entry: EntryRecord) =>
  (entry.model ?? [])
    .flatMap((message) =>
      message.role !== 'user'
        ? []
        : typeof message.content === 'string'
          ? [message.content]
          : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
    )
    .join('\n')

/** Who an input is from, in the classifier's words: the user, or the branch that messaged. */
function senderOf(entry: EntryRecord) {
  const from = (entry.data as { from?: unknown } | undefined)?.from
  return typeof from === 'number' ? `a branch (#${from}) reporting to @ultimate` : 'the user'
}

/** The model text of a recall: the memories in full, after the message they apply to. */
export function recallText(picked: { slug: string; item: MemoryItem }[]) {
  return [
    'Recalled from project memory for the message above. Act on each that applies, and say so in one line when it changes what you do:',
    ...picked.map(({ slug, item }) =>
      [`${slug} [${item.kind}] — ${item.line}`, item.body].join('\n'),
    ),
  ].join('\n\n')
}

/**
 * Before each request of @ultimate's run: once per new input from the user or a branch, ask classify which memories
 * the message calls for, and place the picked ones, in full, as an entry after it. The entry lands after the request's
 * cutoff, so this request gets the same message appended; every later request reads it from storage at that
 * position, which keeps the prompt prefix cached.
 */
export default function recall(host: ExtensionHost) {
  host.want(ClassifyApi)
  host.need(LineageApi)
  return defineExtension({
    name: 'recall',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, ctx) => {
          const classify = host.want(ClassifyApi)
          const id = api.conversationId
          if (!classify) return undefined
          if ((await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate !== id)
            return undefined
          const conversation = await host.harness().conversation(id, ctx)
          const page = await conversation!.entries({ order: 'descending' }, 32, undefined, ctx)
          const input = page.items.find(isInput)
          if (!input || (input.kind !== 'pi.user' && input.kind !== 'board.message'))
            return undefined
          const state = await api.snapshot(Recall, id, ctx)
          if (state?.last !== undefined && state.last >= input.id) {
            // A request resent after a restart keeps the cutoff it had before its recall was placed: add it again.
            const placed = page.items.find(
              (entry) => entry.kind === RECALL_ENTRY && (entry.data as Recalled).input === input.id,
            )?.model?.[0]
            if (
              !placed ||
              request.messages.some((message) => message.timestamp === placed.timestamp)
            )
              return undefined
            return { messages: [...request.messages, placed] }
          }
          const usage = await api.snapshot(ContextUsageDoc, id, ctx)
          const lineage = host.need(LineageApi)
          const found = await lineage.memoriesOf(id, ctx)
          const memories = found?.memories ?? {}
          const tokens = usage?.tokens
          const percent = usage?.percent
          if (
            !tokens ||
            percent === undefined ||
            percent < FROM_PERCENT ||
            !Object.keys(memories).length
          ) {
            await host.harness().commit(async (tx) => {
              ;(await tx.doc(Recall, id)).last = input.id
            }, ctx)
            return undefined
          }
          await host.harness().commit(async (tx) => {
            ;(await tx.doc(Recall, id)).pending = input.id
          }, ctx)
          let probabilities: Record<string, number> = {}
          try {
            const result = await classify.ask(
              {
                state: { from: senderOf(input), message: textOf(input).slice(0, 4000) },
                questions: { memory: recallQuestion(memories) },
              },
              AbortSignal.any([
                ...(ctx.abortSignal ? [ctx.abortSignal] : []),
                AbortSignal.timeout(3000),
              ]),
            )
            const answer = result.answers.memory
            if (answer.type === 'choice') probabilities = answer.probabilities
          } catch (error) {
            if (ctx.abortSignal?.aborted) throw error
            // Recall is advisory: a provider failure or timeout leaves the run as it was.
          }
          const window = usage?.window ?? tokens / (percent / 100)
          const recent = (at: number | undefined) =>
            at !== undefined && at <= tokens && tokens - at < AGAIN_AFTER * window
          const picked = Object.entries(probabilities)
            .filter(
              ([slug, p]) =>
                Object.hasOwn(memories, slug) && p >= THRESHOLD && !recent(state?.injected[slug]),
            )
            .toSorted((a, b) => b[1] - a[1])
            .slice(0, TOP)
            .map(([slug, confidence]) => ({ slug, item: memories[slug], confidence }))
          let message: Message | undefined
          await host.harness().commit(async (tx) => {
            const doc = await tx.doc(Recall, id)
            delete doc.pending
            doc.last = input.id
            if (!picked.length) return
            message = { role: 'user', content: recallText(picked), timestamp: Date.now() }
            const data: Recalled = {
              input: input.id,
              root: found!.root,
              memories: picked.map(({ slug, item, confidence }) => ({
                slug,
                line: item.line,
                confidence: Math.round(confidence * 100) / 100,
              })),
            }
            await tx.appendEntry(id, {
              kind: RECALL_ENTRY,
              data,
              model: [message],
            })
            for (const { slug } of picked) doc.injected[slug] = tokens
          }, ctx)
          return message ? { messages: [...request.messages, message] } : undefined
        },
      }),
    ],
  })
}
