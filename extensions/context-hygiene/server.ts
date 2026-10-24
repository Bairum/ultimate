import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { ContextHygiene, Ledger } from './api.ts'
import type { Thresholds } from './api.ts'
import { candidates, defaults, estimate, gateOpen, rewrite } from './rewrite.ts'

export const docs = [Ledger]
export default function contextHygiene(
  host: Pick<
    ExtensionHost,
    'harness' | 'implement' | 'notice' | 'projectRoot' | 'userHome' | 'projectSettings'
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
            for (const settings of [
              await readSettings(userSettingsPath(host.userHome)),
              await host.projectSettings(),
            ]) {
              const configured = settings.contextHygiene
              if (configured && typeof configured === 'object' && !Array.isArray(configured))
                for (const key of Object.keys(defaults) as (keyof Thresholds)[]) {
                  const value = configured[key]
                  if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
                    thresholds[key] = value
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
              // Gate costs describe the bytes already shortened by earlier applied decisions.
              const current = rewrite(messages, ledger.decisions)
              const suffix = Array.from({ length: current.length + 1 }, () => 0)
              for (let i = current.length - 1; i >= 0; i--)
                suffix[i] = suffix[i + 1] + estimate(current[i])
              const pending = messages.flatMap((message, index) => {
                const decision =
                  message.role === 'toolResult' ? ledger.decisions[message.toolCallId] : undefined
                return decision?.state === 'pending' ? [{ decision, index }] : []
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
                  if (eligible.length) ledger.stats.requests++
                  for (const { decision } of eligible) {
                    decision.state = 'applied'
                    ledger.stats.appliedTokens += decision.tokens
                  }
                }
              }
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
