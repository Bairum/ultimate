import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension, LiveDoc, UsageDoc } from '@earendil-works/pi-durable'
import type { Cursor, LiveState, UsageState } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { createRateSampler, keys, zero, type Rates, type RateSample } from './rates.ts'

const snapshots = new WeakMap<object, () => RateSample | null>()
export const actions = {
  rates(_args: unknown, { host }: Pick<ActionContext, 'host'>) {
    return snapshots.get(host)?.() ?? null
  },
}

const settled = (usage: UsageState | null | undefined) => {
  const total = zero()
  for (const bucket of Object.values(usage?.models ?? {}))
    for (const key of keys) total[key] += bucket[key]
  return total
}
const partial = (live: LiveState | null | undefined): Rates => {
  const usage = live?.generation?.message?.usage
  return usage
    ? {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
      }
    : zero()
}

type Host = Pick<ExtensionHost, 'harness' | 'onOpen' | 'onClose' | 'notice'>
export default function statusLine(host: Host) {
  let latest: RateSample | null = null
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let epoch = 0
  snapshots.set(host, () => latest)
  const stop = () => {
    epoch++
    clearInterval(timer)
    unsubscribe?.()
    unsubscribe = undefined
    latest = null
  }
  host.onClose(async () => stop())
  host.onOpen(async () => {
    stop()
    const opened = epoch
    const harness = host.harness()
    const documents = new Map<number, { settled: Rates; partial: Rates }>()
    const total = zero()
    const sample = createRateSampler()
    let failed = false
    const replace = (id: number, part: 'settled' | 'partial', next: Rates) => {
      for (const key of keys)
        if (!Number.isFinite(next[key])) throw new Error('Invalid provider token counter')
      const before = documents.get(id) ?? { settled: zero(), partial: zero() }
      for (const key of keys) total[key] += next[key] - before[part][key]
      before[part] = next
      documents.set(id, before)
    }
    try {
      await harness.commit(async (tx) => {
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanConversations({}, 256, cursor)
          for (const conversation of page.items) {
            replace(conversation.id, 'settled', settled(await tx.doc(UsageDoc, conversation.id)))
            replace(conversation.id, 'partial', partial(await tx.doc(LiveDoc, conversation.id)))
          }
          cursor = page.next
        } while (cursor !== undefined)
        if (opened !== epoch) return
        sample(performance.now(), total)
        // Subscribe while this atomic seed still holds the commit boundary. Its own publication
        // is safe to adopt again (absolute counters); no following commit can slip past the seed.
        unsubscribe = harness.subscribeCommits((publication) => {
          if (failed) return
          try {
            for (const change of publication.changes) {
              if (change.type !== 'document' || change.conversationId === undefined) continue
              if (change.record.kind === UsageDoc.definition.kind)
                replace(
                  change.conversationId,
                  'settled',
                  settled(change.value as UsageState | null),
                )
              if (change.record.kind === LiveDoc.definition.kind)
                replace(change.conversationId, 'partial', partial(change.value))
            }
            // Do not sample here: settled + partial must be adopted from the whole publication.
          } catch {
            failed = true
            latest = null
          }
        })
      }, context)
      if (opened !== epoch) return
      timer = setInterval(() => {
        if (!failed) latest = sample(performance.now(), total)
      }, 1000)
    } catch (error) {
      if (opened !== epoch) return
      stop()
      host.notice(`Instance token rates unavailable: ${String(error)}`)
    }
  })
  return defineExtension({ name: 'status-line' })
}
