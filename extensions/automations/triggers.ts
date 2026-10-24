import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { defineEvent } from '../../shared/events.ts'
import type { EventRecord } from '../../shared/events.ts'
import { ContextUsageDoc } from '../conversations/api.ts'
import type { ContextUsage } from '../conversations/api.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { describeSchedule } from './schedule.ts'
import type { Automations as Ledger } from './server.ts'
import type { Automation, TriggerEvent } from './types.ts'
import { RUN_TASK } from './types.ts'
export const TRIGGER_EVENTS: TriggerEvent[] = [
  {
    name: 'workspaces.landed',
    description: 'A submission landed',
    fields: {
      sha: 'Landed commit',
      title: 'Submission title',
      target: 'Target branch',
      conversationId: 'Submitting conversation',
    },
  },
  {
    name: 'workspaces.check',
    description: 'A landing check finished',
    fields: { result: 'passed | failed | flaky | timeout' },
  },
  {
    name: 'health.changed',
    description: 'Provider health changed',
    fields: { provider: 'Provider name', state: 'ok | failing | unknown' },
  },
  {
    name: 'models.login-changed',
    description: 'Provider login changed',
    fields: { provider: 'Provider name' },
  },
  { name: 'update.applied', description: 'An update was applied', fields: {} },
  { name: 'update.refused', description: 'An update was refused', fields: {} },
  {
    name: 'cloud.backup',
    description: 'Cloud backup changed phase',
    fields: { phase: 'started | done | failed' },
  },
  { name: 'lineage.branched', description: 'A branch was created', fields: {} },
  {
    name: 'conversations.compacted',
    description: 'A conversation compacted',
    fields: { conversation: 'Conversation id', reason: 'Compaction reason' },
  },
  {
    name: 'automations.escalated',
    description: 'An automation escalated',
    fields: { id: 'Automation id' },
  },
]

export function describeTrigger(a: Automation): string {
  if (a.schedule) return describeSchedule(a.schedule)
  if (a.event)
    return `on ${a.event.name}${
      a.event.where && Object.keys(a.event.where).length
        ? ` where ${Object.entries(a.event.where)
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}`
        : ''
    }`
  if (a.condition) return `when ${a.condition.of} context ≥ ${a.condition.above}%`
  return a.script!.state
}

function summary(event: EventRecord): string {
  const data = event.data as Record<string, unknown>
  if (event.name === 'workspaces.landed')
    return `${event.name} ${String(data.sha).slice(0, 7)} ${JSON.stringify(data.title)}`.slice(
      0,
      200,
    )
  return `${event.name} {${Object.entries(data)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ')}}`
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}

export function triggers(
  host: ExtensionHost,
  Automations: typeof Ledger,
  fire: (tx: Tx, a: Automation, at: number, text?: string) => Promise<unknown>,
  prepareFires: (tx: Tx) => Promise<unknown>,
) {
  async function resolve(of: string): Promise<ConversationId | undefined> {
    if (/^@[a-zA-Z0-9_-]+$/.test(of))
      return host.need(SubagentsApi).standing(of.slice(1), BACKGROUND_CONTEXT)
    if (/^#[1-9]\d*$/.test(of)) return Number(of.slice(1)) as ConversationId
    return undefined
  }
  /** Evaluate `a`'s condition on `usage`, the measurement a commit published, else the conversation's current one. */
  async function evaluate(tx: Tx, a: Automation, id?: number, measured?: ContextUsage) {
    if (!a.enabled || !a.condition || !id) return
    const usage = measured ?? (await tx.doc(ContextUsageDoc, id as ConversationId))
    if (usage.percent === undefined) return
    const condition = a.condition
    condition.value = usage.percent
    if (usage.percent < condition.above - 10) condition.armed = true
    const now = Date.now()
    if (
      usage.percent >= condition.above &&
      condition.armed &&
      (a.lastFireAt === undefined || now - a.lastFireAt >= condition.cooldownMs)
    ) {
      const count = (n: number) =>
        Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
      await fire(
        tx,
        a,
        now,
        `${condition.of} context ${Math.round(usage.percent)}%${usage.tokens !== undefined && usage.window !== undefined ? ` (${count(usage.tokens)}/${count(usage.window)})` : ''}`,
      )
      condition.armed = false
    }
  }
  let stop: (() => void) | undefined
  let queue = Promise.resolve()
  let closed = false
  /**
   * Evaluate every enabled context condition: on the measurements one commit published (`changed`, by conversation),
   * or on each conversation's current one. Each commit's measurements are evaluated in commit order, so a drop below
   * the re-arm line followed by a crossing is seen as both, however far evaluation lags.
   */
  async function check(changed?: Map<number, ContextUsage>) {
    const state = await host.harness().snapshot(Automations, BACKGROUND_CONTEXT)
    for (const a of Object.values(state?.automations ?? {})) {
      if (closed || !a.enabled || !a.condition) continue
      const target = await resolve(a.condition.of)
      if (!target || (changed && !changed.has(target))) continue
      await host.harness().commit(async (tx) => {
        const current = (await tx.doc(Automations)).automations[a.id]
        if (current?.condition?.of === a.condition!.of)
          await evaluate(tx, current, target, changed?.get(target))
      }, BACKGROUND_CONTEXT)
    }
  }
  /**
   * Whether `event` came from one of `a`'s own prompt runs: its trace's conversation, or the conversation it is about
   * (`conversation`, `conversationId` in its data), is a run conversation owned by one of `a`'s run tasks. Read from
   * the conversation's owner, not the bounded run history, so an old or long run still counts.
   */
  async function fromOwnRun(tx: Tx, a: Automation, event: EventRecord) {
    // No shortcut on `a.prompt`: a run started before the prompt was removed can still emit.
    const data = event.data as Record<string, unknown>
    const ids = new Set(
      [event.context?.conversationId, data.conversation, data.conversationId].filter(
        (id): id is number => typeof id === 'number',
      ),
    )
    for (const id of ids) {
      const creator = (await tx.conversation(id as ConversationId))?.owner
      if (!creator) continue
      const owner = await tx.task(creator.taskId)
      if (
        owner?.kind === RUN_TASK &&
        (owner.input as { automation?: { id?: string } }).automation?.id === a.id
      )
        return true
    }
    return false
  }
  function install() {
    // Tokens name public events without loading other extensions' runtime refs.
    host.react(
      'events',
      TRIGGER_EVENTS.map(({ name }) => defineEvent(name)),
      async (tx, event) => {
        const state = await tx.doc(Automations)
        const matching: Automation[] = []
        // Every read before the first fire: a transaction may not scan tasks after it wrote.
        for (const a of Object.values(state.automations)) {
          if (!a.enabled || a.event?.name !== event.name || event.id <= a.event.sinceEvent) continue
          if (
            !Object.entries(a.event.where ?? {}).every(
              ([key, value]) => (event.data as Record<string, unknown>)[key] === value,
            )
          )
            continue
          if (!(await fromOwnRun(tx, a, event))) matching.push(a)
        }
        if (matching.some((a) => a.prompt)) await prepareFires(tx)
        for (const a of matching) await fire(tx, a, Date.now(), summary(event))
      },
      { from: 'now' },
    )
  }
  async function open() {
    closed = false
    stop?.()
    // Not a reactor: context usage is a document, not a domain event.
    stop = host.harness().subscribeCommits((publication) => {
      const changed = new Map<number, ContextUsage>()
      for (const change of publication.changes)
        if (
          change.type === 'document' &&
          change.record.kind === ContextUsageDoc.definition.kind &&
          change.conversationId !== undefined &&
          change.value
        )
          changed.set(change.conversationId, structuredClone(change.value as ContextUsage))
      if (changed.size)
        queue = queue
          .then(() => check(changed))
          .catch((error: unknown) => {
            host.notice(`Automation context trigger: ${String(error)}`)
          })
    })
    await check()
  }
  async function close() {
    closed = true
    stop?.()
    stop = undefined
    await queue
  }
  return { resolve, evaluate, install, open, close }
}
