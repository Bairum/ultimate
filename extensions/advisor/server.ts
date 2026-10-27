import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import {
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, HookApi } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { updateSettings, userSettingsPath } from '../../lib/settings.ts'
import { Standing, Profile } from '../subagents/api.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { ClassifyApi } from '../classify/api.ts'
import { Gate } from '../messages/api.ts'
import { Roots } from '../lineage/api.ts'
import {
  ConfigAction,
  SetConfigAction,
  SetRubricAction,
  FeedbackAction,
  StatsAction,
  ManageAction,
  ROLES,
  recipient,
} from './refs.ts'
import type { Role, ReviewPoint } from './refs.ts'
import { configuration, NAME, validateConfig } from './config.ts'
import { docs, Runs, State, pruneRuns } from './state.ts'
import { review, runEntries } from './review.ts'
import type { ReviewInput } from './review.ts'
import { signals, initialSignals } from './signals.ts'
import { acknowledge, trackRead, stats, invalidate } from './tracking.ts'
import { closeOut, expireNotes, failCloseOut } from './lifecycle.ts'
import type { CloseInput } from './lifecycle.ts'
import { pruneNotes, selected, setStatus, validateSelection, validReason } from './manage.ts'

export { docs }
export const userActions = ['setConfig', 'setRubric', 'feedback', 'manage']
export const hostActions = ['setConfig', 'setRubric']
/** How long a final answer waits for its review before it leaves and the review moves to the background. */
export const HOLD_MS = 60_000
export const actions = {
  stats: implementAction(StatsAction, async (args, { host }) => {
    if (args !== null && (typeof args !== 'object' || Array.isArray(args)))
      throw new Error('Invalid stats arguments')
    const days = args?.days ?? 7
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0)
      throw new Error('Invalid days')
    const state = await host.harness().snapshot(State, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
    const runs = await host.harness().snapshot(Runs, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
    return stats(state ?? State.definition.initial(), Date.now() - days * 86_400_000, runs?.timings)
  }),
  manage: implementAction(ManageAction, async (args, { host }) => {
    validateSelection(args)
    return host.harness().commit(async (tx) => {
      const state = await tx.doc(State, ROOT_CONVERSATION_ID)
      const now = Date.now()
      let changed = 0
      for (const note of state.notes) {
        if (!selected(note, args, now)) continue
        if (args.do === 'archive') {
          if (note.status === 'open' || note.archivedAt !== undefined) continue
          note.archivedAt = now
        } else if (args.do === 'reopen') {
          if (note.status === 'open') continue
          setStatus(note, 'open', now)
        } else {
          if (note.status !== 'open') continue
          setStatus(note, args.do === 'resolve' ? 'resolved' : 'dismissed', now, args.reason)
        }
        invalidate(host, recipient(note))
        changed++
      }
      return { changed }
    }, BACKGROUND_CONTEXT)
  }),
  config: implementAction(ConfigAction, (_args, { host }) => configuration(host)()),
  setConfig: implementAction(SetConfigAction, async (args, { host }) => {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      (args.scope !== 'user' && args.scope !== 'project') ||
      args.config === undefined
    )
      throw new Error('Invalid config arguments')
    if (args.scope === 'project' && (await host.projectSetup()).decision !== true)
      throw new Error('Project is not trusted')
    const config = args.config === null ? null : validateConfig(args.config)
    const path =
      args.scope === 'user'
        ? userSettingsPath(host.userHome)
        : join(host.projectRoot, '.ultimate/settings.json')
    await updateSettings(path, (settings) => {
      if (config === null) delete settings.advisor
      else settings.advisor = config
    })
    return configuration(host)()
  }),
  setRubric: implementAction(SetRubricAction, async (args, { host }) => {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      (args.scope !== 'user' && args.scope !== 'project') ||
      typeof args.name !== 'string' ||
      !NAME.test(args.name) ||
      (args.text !== null &&
        (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 20_480))
    )
      throw new Error('Invalid rubric arguments')
    if (args.scope === 'project' && (await host.projectSetup()).decision !== true)
      throw new Error('Project is not trusted')
    const directory = join(
      args.scope === 'user' ? host.userHome : host.projectRoot,
      '.ultimate/advisors',
    )
    const path = join(directory, `${args.name}.md`)
    if (args.text === null) {
      try {
        await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    } else {
      await mkdir(directory, { recursive: true })
      await writeFile(path, args.text)
    }
    return configuration(host)()
  }),
  feedback: implementAction(FeedbackAction, async (args, { host }) => {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      !validReason(args.reason) ||
      (args.snoozeUntil !== undefined &&
        args.snoozeUntil !== null &&
        (typeof args.snoozeUntil !== 'number' ||
          !Number.isFinite(args.snoozeUntil) ||
          args.snoozeUntil <= Date.now() ||
          args.snoozeUntil > Date.now() + 30 * 86_400_000)) ||
      typeof args.note !== 'string' ||
      (args.feedback !== undefined &&
        args.feedback !== null &&
        args.feedback !== 'up' &&
        args.feedback !== 'down') ||
      (args.status !== undefined &&
        args.status !== 'open' &&
        args.status !== 'resolved' &&
        args.status !== 'dismissed')
    )
      throw new Error('Invalid feedback')
    const reason = args.reason
    const snoozeUntil = args.snoozeUntil
    return host.harness().commit(async (tx) => {
      const note = (await tx.doc(State, ROOT_CONVERSATION_ID)).notes.find((n) => n.id === args.note)
      if (!note) throw new Error('Note not found')
      if (args.feedback === null) delete note.feedback
      else if (args.feedback === 'up' || args.feedback === 'down') note.feedback = args.feedback
      if (args.status === 'open' || args.status === 'resolved' || args.status === 'dismissed')
        setStatus(note, args.status, Date.now(), reason)
      if (snoozeUntil === null) delete note.snoozedUntil
      else if (snoozeUntil !== undefined) note.snoozedUntil = snoozeUntil
      invalidate(host, recipient(note))
      return { ...note }
    }, BACKGROUND_CONTEXT)
  }),
}

export default function advisor(host: ExtensionHost) {
  const config = configuration(host)
  host.want(ClassifyApi)
  host.want(Gate)
  host.want(ConversationsApi)
  async function enabled(id: ConversationId, context: Context) {
    const view = await config(false)
    if (!ROLES.some((r) => view.effective.roles?.[r]?.enabled)) return undefined
    if (
      id === ROOT_CONVERSATION_ID ||
      (await host.harness().snapshot(Roots, ROOT_CONVERSATION_ID, context))?.roots.includes(id)
    )
      return undefined
    const side = host.doc('sidechat')
    if (side && (await host.harness().snapshot(side, id, context))?.of) return undefined
    const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context)
    const definition =
      id === standing?.ultimate
        ? 'ultimate'
        : ((await host.harness().snapshot(Profile, id, context))?.definition ??
          host.conversations().find((c) => c.id === id)?.label)
    if (!ROLES.includes(definition as Role)) return undefined
    const role = definition as Role
    if (!view.effective.roles?.[role]?.enabled) return undefined
    return { role, profile: view.effective.roles[role], effective: view.effective }
  }
  const ReviewTask = defineTask<ReviewInput, { phase: 'review' }, null>({
    name: 'advisor.review',
    version: 1,
    initial: () => ({ phase: 'review' }),
    abort: async (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const row = (await tx.doc(Runs, ROOT_CONVERSATION_ID)).conversations[runtime.conversationId]
        if (row?.pending === task.id) delete row.pending
        return {
          status: 'terminal' as const,
          outcome: { status: 'completed' as const, result: null },
        }
      }, context),
    phases: {
      review: async (task, runtime, context) => {
        try {
          const target = await enabled(runtime.conversationId, context)
          if (target) {
            const view = await config()
            await review(
              host,
              runtime,
              task.input,
              view.effective,
              view.rubrics,
              context,
              runtime.signal,
            )
          }
        } catch (error) {
          // Advisory tasks never fail the reviewed conversation; expose delivery/storage failures as notices.
          host.notice(`Advisor background review: ${String(error)}`)
        }
        return runtime.commit(async (tx) => {
          const row = (await tx.doc(Runs, ROOT_CONVERSATION_ID)).conversations[
            runtime.conversationId
          ]
          if (row?.pending === task.id) delete row.pending
          return {
            status: 'terminal' as const,
            outcome: { status: 'completed' as const, result: null },
          }
        }, context)
      },
    },
  })
  const CloseTask = defineTask<CloseInput, { phase: 'close' }, null>({
    name: 'advisor.close',
    version: 1,
    initial: () => ({ phase: 'close' }),
    abort: async (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: 'terminal' as const,
          outcome: { status: 'completed' as const, result: null },
        }),
        context,
      ),
    phases: {
      close: async (task, runtime, context) => {
        try {
          await closeOut(host, runtime, task.input, (await config(false)).effective, context)
        } catch (error) {
          // Lifecycle judgments are advisory and must never fail the conversation.
          await failCloseOut(host, runtime.conversationId, task.input.run, String(error), context)
          host.notice(`Advisor close-out: ${String(error)}`)
        }
        return runtime.commit(
          () => ({
            status: 'terminal' as const,
            outcome: { status: 'completed' as const, result: null },
          }),
          context,
        )
      },
    },
  })
  async function finish(api: HookApi, latest: string, context: Context) {
    await host.harness().commit(async (tx) => {
      const run = (await tx.doc(LiveDoc, api.conversationId)).run?.inputs[0]
      if (run === undefined) return
      const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
      const key = `${api.conversationId}:${run}`
      if (runs.closeouts?.[key] !== undefined || !Object.values(runs.readRuns ?? {}).includes(run))
        return
      runs.closeouts ??= {}
      runs.closeouts[key] = await tx.createTask(
        CloseTask,
        { run, latest },
        {
          ownership: { kind: 'conversation' },
          conversationId: api.conversationId,
          background: true,
        },
      )
    }, context)
  }
  async function background(id: ConversationId, input: ReviewInput, context: Context) {
    await host.harness().commit(async (tx) => {
      const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
      runs.conversations[id] ??= { rounds: 0, signals: [] }
      const row = runs.conversations[id]
      if (row.pending !== undefined && input.point !== 'answer') return
      row.pending = await tx.createTask(ReviewTask, input, {
        ownership: { kind: 'conversation' },
        conversationId: id,
        background: true,
      })
      if (input.point === 'idle') row.idleReviewed = row.lastActivity
    }, context)
  }
  /** One background rerun per overrun generation, even when the hook replays after a crash. */
  async function overrun(api: HookApi, input: ReviewInput, context: Context) {
    await host.harness().commit(async (tx) => {
      const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
      runs.overruns ??= {}
      if (runs.overruns[api.taskId] !== undefined) return
      const task = await tx.createTask(ReviewTask, input, {
        ownership: { kind: 'conversation' },
        conversationId: api.conversationId,
        background: true,
      })
      runs.overruns[api.taskId] = { task, at: Date.now() }
    }, context)
  }
  async function activity(
    api: HookApi,
    context: Context,
    assistant: EntryId,
    results: readonly EntryId[],
    scan: boolean,
  ) {
    return host.harness().commit(async (tx) => {
      const run = (await tx.doc(LiveDoc, api.conversationId)).run?.inputs[0]
      const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
      let row = runs.conversations[api.conversationId]
      if (!row || row.run !== run) {
        runs.conversations[api.conversationId] = {
          ...(run !== undefined ? { run } : {}),
          rounds: 0,
          signals: [],
          ...(row?.deliveries !== undefined ? { deliveries: [...row.deliveries] } : {}),
          ...(row?.pending !== undefined ? { pending: row.pending } : {}),
        }
        row = runs.conversations[api.conversationId]
      }
      row.lastActivity = Date.now()
      let found: string[] = []
      if (scan) {
        const entries = (
          await Promise.all([assistant, ...results].map((id) => tx.entry(id)))
        ).filter((entry) => entry !== undefined)
        const state = JSON.parse(JSON.stringify(row.scan ?? initialSignals())) as ReturnType<
          typeof initialSignals
        >
        found = signals(
          entries,
          host.conversations().find((c) => c.id === api.conversationId)?.cwd ?? host.projectRoot,
          '',
          state,
        ).filter((s) => !row.signals.includes(s))
        row.scan = state
        row.signals.push(...found)
      }
      if (row.lastRound !== assistant) {
        row.rounds++
        row.lastRound = assistant
      }
      return { run, rounds: row.rounds, found }
    }, context)
  }
  const timer = setInterval(() => {
    void tick().catch((error: unknown) => host.notice(`Advisor idle scan: ${String(error)}`))
  }, 300_000)
  timer.unref()
  host.onClose(async () => {
    clearInterval(timer)
  })
  async function tick() {
    const view = await config(false)
    const context = BACKGROUND_CONTEXT
    const concluded = await host.want(ConversationsApi)?.concluded(context)
    await expireNotes(host, view.effective, concluded ?? new Set(), context)
    await host.harness().commit(async (tx) => {
      pruneRuns(await tx.doc(Runs, ROOT_CONVERSATION_ID), concluded ?? new Set(), Date.now())
      const state = await tx.doc(State, ROOT_CONVERSATION_ID)
      pruneNotes(state, Date.now())
      const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
      for (const id of Object.keys(runs.readRuns ?? {})) {
        if (!state.notes.some((n) => n.id === id)) delete runs.readRuns![id]
      }
      const active = new Set(Object.values(runs.readRuns ?? {}))
      for (const key of Object.keys(runs.closeouts ?? {})) {
        if (!active.has(Number(key.split(':')[1]))) delete runs.closeouts![key]
      }
    }, context)
    const runs = await host.harness().snapshot(Runs, ROOT_CONVERSATION_ID, context)
    for (const summary of host.conversations()) {
      const id = summary.id as ConversationId
      if (summary.busy || concluded?.has(id)) continue
      const target = await enabled(id, context)
      if (!target?.profile.at?.includes('idle')) continue
      const row = runs?.conversations[id]
      const last = Math.max(row?.lastActivity ?? 0, summary.answerAt ?? 0, summary.inputAt ?? 0)
      if (
        !last ||
        Date.now() - last < (target.profile.idleMs ?? 1_800_000) ||
        (row?.idleReviewed ?? 0) >= last
      )
        continue
      await host.harness().commit(async (tx) => {
        const state = await tx.doc(Runs, ROOT_CONVERSATION_ID)
        state.conversations[id] ??= { rounds: 0, signals: [] }
        state.conversations[id].lastActivity = last
      }, context)
      await background(id, { role: target.role, point: 'idle' }, context)
    }
  }
  async function settleYield(api: HookApi, result: { continue: string } | null, context: Context) {
    const kept = await api.memo('advisor:yield', result, context)
    await host.harness().commit(async (tx) => {
      const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
      const row = runs.conversations[api.conversationId]
      for (const id of row?.deliveries ?? [])
        if (runs.deliveries[id]?.delivered === 'continue') delete runs.deliveries[id]
      if (row?.deliveries)
        row.deliveries = row.deliveries.filter((id) => runs.deliveries[id] !== undefined)
    }, context)
    return kept ?? undefined
  }
  return defineExtension({
    name: 'advisor',
    tasks: [ReviewTask, CloseTask],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          try {
            await trackRead(host, request.messages, api, context)
          } catch (error) {
            // Tracking must not alter or fail cache-critical agent requests.
            host.notice(`Advisor read tracking: ${String(error)}`)
          }
          return undefined
        },
        afterResponse: async (message, api, context) => {
          try {
            await acknowledge(
              host,
              message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
              api.conversationId,
              context,
            )
          } catch (error) {
            // Acknowledgments are best-effort and never fail the agent.
            host.notice(`Advisor acknowledgement: ${String(error)}`)
          }
        },
        afterTools: async (_assistant, _results, api, context) => {
          const target = await enabled(api.conversationId, context)
          if (!target) return
          const current = await activity(
            api,
            context,
            _assistant,
            _results,
            !!target.profile.at?.includes('signals'),
          )
          let point: ReviewPoint | undefined
          let signal: string | undefined
          if (current.found.length) {
            point = 'signals'
            signal = current.found.join('; ')
          }
          if (
            !point &&
            target.profile.at?.includes('rounds') &&
            current.rounds % (target.profile.every ?? 5) === 0
          )
            point = 'rounds'
          if (point)
            await background(
              api.conversationId,
              { role: target.role, point, run: current.run, ...(signal ? { signal } : {}) },
              context,
            )
        },
        onYield: async (answer, api, context) => {
          const evaluate = async () => {
            const target = await enabled(api.conversationId, context)
            if (!target) return undefined
            const kept = await api.memo<{ continue: string } | null>('advisor:yield', context)
            if (kept !== undefined) return settleYield(api, kept, context)
            // A replay of a generation whose hold already ran out: the background rerun owns its review.
            const latches = await api.snapshot(Runs, ROOT_CONVERSATION_ID, context)
            if (latches?.overruns?.[api.taskId] !== undefined) return undefined
            const run = (await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs[0]
            const latest = answer.content
              .flatMap((b) => (b.type === 'text' ? [b.text] : []))
              .join('')
              .slice(0, 8000)
            const detected = target.profile.at?.includes('signals')
              ? signals(
                  await runEntries(host, api.conversationId, context),
                  host.conversations().find((c) => c.id === api.conversationId)?.cwd ??
                    host.projectRoot,
                  latest,
                )
              : []
            if (!target.profile.at?.includes('answer')) {
              if (detected.length) {
                await background(
                  api.conversationId,
                  { role: target.role, point: 'signals', run, signal: detected.join('; '), latest },
                  context,
                )
              }
              return undefined
            }
            if (target.role === 'ultimate') {
              await background(
                api.conversationId,
                { role: target.role, point: 'answer', run, latest },
                context,
              )
              return undefined
            }
            try {
              await host.harness().commit(async (tx) => {
                const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
                runs.conversations[api.conversationId] ??= { rounds: 0, signals: [] }
                const row = runs.conversations[api.conversationId]
                if (row.run !== run) {
                  runs.conversations[api.conversationId] = {
                    ...(run !== undefined ? { run } : {}),
                    rounds: 0,
                    signals: [],
                    lastActivity: Date.now(),
                    ...(row.pending !== undefined ? { pending: row.pending } : {}),
                    ...(row.deliveries !== undefined ? { deliveries: [...row.deliveries] } : {}),
                  }
                }
              }, context)
              // Measured answer reviews: p50 3–14 s, max 41 s across roles (#81606); a slower one goes to the background.
              const deadline = AbortSignal.timeout(HOLD_MS)
              let expired!: () => void
              const timeout = new Promise<undefined>((resolve) => {
                expired = () => resolve(undefined)
                deadline.addEventListener('abort', expired, { once: true })
              })
              const work = (async () => {
                const view = await config()
                deadline.throwIfAborted()
                return review(
                  host,
                  api,
                  {
                    role: target.role,
                    point: 'answer',
                    run,
                    latest,
                    ...(detected.length ? { signal: detected.join('; ') } : {}),
                  },
                  view.effective,
                  view.rubrics,
                  context,
                  deadline,
                )
              })()
              try {
                const result = await Promise.race([work, timeout])
                if (deadline.aborted) {
                  // The answer leaves now; the review reruns in the background and routes what it finds upward.
                  await overrun(
                    api,
                    {
                      role: target.role,
                      point: 'answer',
                      run,
                      latest,
                      deadline: true,
                      of: api.taskId,
                    },
                    context,
                  )
                  return undefined
                }
                return settleYield(api, result ?? null, context)
              } finally {
                deadline.removeEventListener('abort', expired)
              }
            } catch (error) {
              // Advisory: provider and storage failures must never hold the final answer.
              host.notice(`Advisor answer review: ${String(error)}`)
              return undefined
            }
          }
          const result = await evaluate()
          if (!result) {
            try {
              await finish(
                api,
                answer.content
                  .flatMap((b) => (b.type === 'text' ? [b.text] : []))
                  .join('\n')
                  .slice(0, 8000),
                context,
              )
            } catch (error) {
              // Closing a note must never prevent the final answer.
              host.notice(`Advisor close-out scheduling: ${String(error)}`)
            }
          }
          return result
        },
      }),
    ],
  })
}
