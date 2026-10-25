import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { ContextOffload } from '../context-offload/api.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { ContextHygiene, Ledger } from './api.ts'
import type { Thresholds } from './api.ts'
import {
  candidates,
  defaults,
  estimate,
  gateOpen,
  rewrite,
  safe,
  text,
  suffixPositions,
} from './rewrite.ts'

export const docs = [Ledger]
export default function contextHygiene(
  host: Pick<
    ExtensionHost,
    'harness' | 'implement' | 'want' | 'notice' | 'projectRoot' | 'userHome' | 'projectSettings'
  >,
) {
  host.implement(ContextHygiene, { gateOpen, rewrite })
  return defineExtension({
    name: 'context-hygiene',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, ctx) => {
          try {
            const thresholds = { ...defaults }
            // Masking is opt-in: the replay over stored history priced it as a net cost at cache-read rates, so it
            // only pays for context headroom.
            let mask = false
            for (const settings of [
              await readSettings(userSettingsPath(host.userHome)),
              await host.projectSettings(),
            ]) {
              const configured = settings.contextHygiene
              if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
                for (const key of Object.keys(defaults) as (keyof Thresholds)[]) {
                  const value = configured[key]
                  if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
                    thresholds[key] = value
                }
                if (typeof configured.mask === 'boolean') mask = configured.mask
              }
            }
            const conversation = await host.harness().conversation(api.conversationId, ctx)
            if (!conversation) throw new Error('Conversation unavailable')
            const agent = await conversation.agent(ctx)
            const model = agent.model
              ? api.models.getModel(agent.model.provider, agent.model.modelId)
              : undefined
            const view = await conversation.context(ctx)
            const now = Date.now()
            const previous = await api.snapshot(Ledger, api.conversationId, ctx)
            const found = candidates(
              messages,
              agent.cwd ?? host.projectRoot,
              now,
              previous?.decisions,
            )
            const masked: NonNullable<typeof previous>['decisions'] = {}
            const before = rewrite(messages, previous?.decisions ?? {})
            const maskSuffix = Array.from({ length: before.length + 1 }, () => 0)
            for (let i = before.length - 1; i >= 0; i--)
              maskSuffix[i] = maskSuffix[i + 1] + estimate(before[i])
            if (
              mask &&
              model &&
              model.contextWindow > 0 &&
              maskSuffix[0] > thresholds.pressureRatio * model.contextWindow
            ) {
              // One pass over the request: a result is maskable only when its call is present and its id unique.
              const calls = new Set<string>()
              const results = new Map<string, number>()
              for (const message of messages) {
                if (message.role === 'assistant')
                  for (const part of message.content)
                    if (part.type === 'toolCall') calls.add(part.id)
                if (message.role === 'toolResult')
                  results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1)
              }
              const old = messages.flatMap((message, index) => {
                if (
                  message.role !== 'toolResult' ||
                  !message.toolCallId ||
                  maskSuffix[index + 1] < thresholds.maskProtectTokens ||
                  previous?.decisions[message.toolCallId] ||
                  found[message.toolCallId] ||
                  !safe(message)
                )
                  return []
                const tokens = estimateTextTokens(text(message))
                return tokens >= thresholds.maskMinTokens &&
                  results.get(message.toolCallId) === 1 &&
                  calls.has(message.toolCallId)
                  ? [{ message, tokens }]
                  : []
              })
              if (
                old.length &&
                old.reduce((sum, item) => sum + item.tokens, 0) >= thresholds.pressureSavings
              ) {
                const store = host.want(ContextOffload)
                if (!store)
                  host.notice('Context hygiene masking skipped: context-offload is not enabled')
                else {
                  for (const { message, tokens } of old) {
                    try {
                      const path = await store.save(
                        api.conversationId,
                        message.toolCallId,
                        text(message),
                      )
                      // `tokens` is the output's size, as the placeholder tells the model.
                      masked[message.toolCallId] = {
                        reason: 'masked',
                        path,
                        tokens,
                        state: 'applied',
                        at: now,
                      }
                    } catch (error) {
                      // A failed save must leave this result recoverable in the request itself.
                      host.notice(`Context hygiene masking skipped: ${String(error)}`)
                    }
                  }
                  if (
                    Object.values(masked).reduce((sum, d) => sum + d.tokens, 0) <
                    thresholds.pressureSavings
                  )
                    for (const id of Object.keys(masked)) delete masked[id]
                }
              }
            }
            const decisions = await host.harness().commit(async (tx) => {
              const ledger = await tx.doc(Ledger, api.conversationId)
              if (view.head?.kind === 'pi.compaction') {
                const present = new Set(
                  messages.flatMap((message) =>
                    message.role === 'toolResult' ? [message.toolCallId] : [],
                  ),
                )
                for (const id of Object.keys(ledger.decisions))
                  if (!present.has(id)) delete ledger.decisions[id]
              }
              for (const [id, decision] of Object.entries(found)) ledger.decisions[id] ??= decision
              let applied = false
              for (const [id, decision] of Object.entries(masked)) {
                if (ledger.decisions[id]) continue
                ledger.decisions[id] = decision
                ledger.stats.appliedTokens += decision.tokens
                applied = true
              }
              // Gate costs describe the bytes already shortened by earlier applied decisions.
              const current = rewrite(messages, ledger.decisions)
              const suffix = Array.from({ length: current.length + 1 }, () => 0)
              for (let i = current.length - 1; i >= 0; i--)
                suffix[i] = suffix[i + 1] + estimate(current[i])
              const pending = messages.flatMap((message, index) => {
                if (message.role !== 'toolResult') return []
                const decision = ledger.decisions[message.toolCallId]
                return decision?.state === 'pending'
                  ? [{ decision, index, id: message.toolCallId }]
                  : []
              })
              // The compaction/reset head is an entry, not a provider-specific summary string.
              // Retained pre-compaction assistants have smaller entry ids than the head marker.
              const lastAssistant = messages.findLast(
                (message) => message.role === 'assistant',
              )?.timestamp
              const newContext =
                lastAssistant === undefined ||
                (view.head !== undefined &&
                  !view.entries.some(
                    (entry) =>
                      entry.id > view.head!.id &&
                      entry.model?.some((message) => message.role === 'assistant'),
                  ))
              if (pending.length) {
                const input = {
                  now,
                  lastAssistant,
                  newContext,
                  suffixTokens: suffix[pending[0].index + 1],
                  // Anthropic, directly or through Claude Code; the earliest pending result has the longest suffix.
                  suffixPositions:
                    model?.api === 'anthropic-messages' || model?.api === 'claude-code-stream-json'
                      ? suffixPositions(current, pending[0].id)
                      : undefined,
                  savings: pending.reduce((sum, item) => sum + item.decision.tokens, 0),
                  requestTokens: suffix[0],
                  contextWindow: model?.contextWindow ?? 0,
                }
                // Cold/new/cheap-suffix decisions need no pressure protection. Only
                // pressure-driven elision must leave the newest protectTokens intact.
                const eligible = gateOpen({ ...input, contextWindow: 0 }, thresholds)
                  ? pending
                  : pending.filter(({ index }) => suffix[index + 1] >= thresholds.protectTokens)
                if (
                  gateOpen(
                    {
                      ...input,
                      savings: eligible.reduce((sum, item) => sum + item.decision.tokens, 0),
                    },
                    thresholds,
                  )
                ) {
                  if (eligible.length) applied = true
                  for (const { decision } of eligible) {
                    decision.state = 'applied'
                    ledger.stats.appliedTokens += decision.tokens
                  }
                }
              }
              if (applied) ledger.stats.requests++
              return Object.fromEntries(
                Object.entries(ledger.decisions).map(([id, decision]) => [id, { ...decision }]),
              )
            }, ctx)
            return { messages: rewrite(messages, decisions) }
          } catch (error) {
            // Hygiene is advisory: a failed read/commit must never block a model request.
            host.notice(`Context hygiene skipped: ${String(error)}`)
            return undefined
          }
        },
      }),
    ],
  })
}
