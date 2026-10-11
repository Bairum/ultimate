import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  defineDoc,
  GenerationTask,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, EntryId, TaskId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { currentAnswer, Summaries } from './summary.ts'
import type { Assessment } from './summary.ts'

export type OverviewRow = {
  parentId?: number
  role?: string
  runState: 'working' | 'queued' | 'idle' | 'done' | 'error'
  inputId?: number
  answerId?: number
  summary?: string
  summaryStatus?: 'pending' | 'ready' | 'error'
  activity?: string
  assessment?: Assessment
  assessmentStatus?: 'pending' | 'ready' | 'error'
}
export type OverviewState = { conversations: Record<string, OverviewRow> }
export const Overview = defineDoc<OverviewState>({
  kind: 'ultimate.conversation-overview',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ conversations: {} }),
})

/** A single root index; hydrate once, then read only rows affected by meaningful commits. */
export function overviewBehavior(
  host: Pick<ExtensionHost, 'harness' | 'metadata' | 'onOpen' | 'onClose' | 'notice'>,
) {
  let stop: (() => void) | undefined
  let closed = false
  let draining: Promise<void> | undefined
  const pending = new Set<ConversationId>()
  const latestUser = new Map<ConversationId, EntryId>()
  const latestRun = new Map<ConversationId, TaskId>()
  const reconcile = async (ids: ConversationId[]) => {
    const harness = host.harness()
    const states = await Promise.all(ids.map((id) => harness.snapshot(Summaries, id, context)))
    await harness.commit(async (tx) => {
      const index = await tx.doc(Overview, ROOT_CONVERSATION_ID)
      for (const [position, id] of ids.entries()) {
        const own = await tx.conversation(id)
        if (!own) continue
        const metadata = await tx.doc(host.metadata, id)
        const state = states[position]
        const live = await tx.doc(LiveDoc, id)
        const inbox = await tx.doc(InboxDoc, id)
        const head = await tx.latestHeadMarker(id)
        const inputId = latestUser.get(id)
        const active = inputId !== undefined && (!head || head.head <= inputId)
        const taskId = latestRun.get(id)
        const run = taskId === undefined ? undefined : await tx.task(taskId)
        const outcome = run?.state.status === 'terminal' ? run.state.outcome : undefined
        const result = outcome?.status === 'completed' ? outcome.result : undefined
        const answerId =
          result &&
          typeof result === 'object' &&
          'entryId' in result &&
          typeof result.entryId === 'number'
            ? (result.entryId as EntryId)
            : undefined
        const answered = active && answerId !== undefined && answerId > inputId
        const row: OverviewRow = {
          ...(own.owner ? { parentId: own.owner.conversationId } : {}),
          ...(metadata.label ? { role: metadata.label } : {}),
          runState: live.run
            ? 'working'
            : inbox.items.some((item) => item.mode !== 'write')
              ? 'queued'
              : answered
                ? 'done'
                : active && outcome && ['failed', 'faulted', 'orphaned'].includes(outcome.status)
                  ? 'error'
                  : 'idle',
          ...(active ? { inputId } : {}),
          ...(answered ? { answerId } : {}),
          ...(state?.summary ? { summary: state.summary } : {}),
          ...(state?.status ? { summaryStatus: state.status } : {}),
          ...(state?.activity ? { activity: state.activity } : {}),
          ...(state?.assessmentStatus ? { assessmentStatus: state.assessmentStatus } : {}),
        }
        if (
          answered &&
          state?.assessment?.answerId === answerId &&
          state.assessment.inputId === inputId &&
          (await currentAnswer(tx, id, answerId))
        )
          row.assessment = state.assessment
        if (JSON.stringify(index.conversations[id]) !== JSON.stringify(row))
          index.conversations[id] = row
      }
    }, context)
  }
  const schedule = () => {
    if (draining || closed) return
    draining = (async () => {
      while (pending.size) {
        if (closed) break
        const ids = [...pending]
        pending.clear()
        await reconcile(ids)
      }
    })()
      .catch((error: unknown) => {
        if (!closed) host.notice(`Conversation overview: ${String(error)}`)
      })
      .finally(() => {
        draining = undefined
        if (pending.size && !closed) schedule()
      })
  }
  host.onOpen(async () => {
    closed = false
    stop = host.harness().subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type === 'conversation') pending.add(change.value.id)
        if (change.type === 'entry' && change.value.kind === 'pi.user') {
          latestUser.set(
            change.value.conversationId,
            Math.max(change.value.id, latestUser.get(change.value.conversationId) ?? 0) as EntryId,
          )
          pending.add(change.value.conversationId)
        }
        if (change.type === 'task' && change.value.kind === GenerationTask.definition.name) {
          const run = change.value
          if (run.id > (latestRun.get(run.conversationId) ?? 0) || run.state.status === 'terminal')
            pending.add(run.conversationId)
          latestRun.set(
            run.conversationId,
            Math.max(run.id, latestRun.get(run.conversationId) ?? 0) as TaskId,
          )
        }
        if (change.type === 'submission' && change.value.type === 'input')
          pending.add(change.value.conversationId)
        if (change.type === 'entry' && ['pi.reset', 'pi.compaction'].includes(change.value.kind))
          pending.add(change.value.conversationId)
        if (
          change.type === 'document' &&
          change.conversationId !== undefined &&
          (change.record.kind === Summaries.definition.kind ||
            (change.record.kind === host.metadata.definition.kind &&
              change.ops.some((op) => op[0] === 'r' || op[1][0] === 'label')) ||
            (change.record.kind === LiveDoc.definition.kind &&
              change.ops.some((op) => op[0] === 'r' || op[1][0] === 'run')) ||
            change.record.kind === InboxDoc.definition.kind)
        )
          pending.add(change.conversationId)
      }
      if (pending.size) schedule()
    })
    // Task receipts and the newest visible user entry establish actual state without Luna/backfill.
    await host.harness().commit(async (tx) => {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks({ kind: GenerationTask.definition.name }, 256, cursor)
        for (const run of page.items)
          latestRun.set(
            run.conversationId,
            Math.max(run.id, latestRun.get(run.conversationId) ?? 0) as TaskId,
          )
        cursor = page.next
      } while (cursor !== undefined)
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        for (const own of page.items) {
          pending.add(own.id)
          const head = await tx.latestHeadMarker(own.id)
          let before: Cursor | undefined
          do {
            const entries = await tx.scanEntries(
              { conversationId: own.id, ...(head ? { minEntryId: head.head } : {}) },
              64,
              before,
            )
            const user = entries.items.find((entry) => entry.kind === 'pi.user')
            if (user) {
              latestUser.set(own.id, Math.max(user.id, latestUser.get(own.id) ?? 0) as EntryId)
              break
            }
            before = entries.next
          } while (before !== undefined)
        }
        cursor = page.next
      } while (cursor !== undefined)
    }, context)
    schedule()
    await draining
  })
  host.onClose(async () => {
    closed = true
    stop?.()
    await draining
  })
}
