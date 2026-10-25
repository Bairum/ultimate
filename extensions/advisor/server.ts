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
import type { ConversationId, HookApi } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { updateSettings, userSettingsPath } from '../../lib/settings.ts'
import { Standing, Profile } from '../subagents/api.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { ClassifyApi } from '../classify/api.ts'
import { Gate } from '../messages/api.ts'
import { Roots } from '../lineage/api.ts'
import { ConfigAction, SetConfigAction, SetRubricAction, FeedbackAction, ROLES } from './refs.ts'
import type { Role, ReviewPoint } from './refs.ts'
import { configuration, NAME, validateConfig } from './config.ts'
import { docs, Runs, State } from './state.ts'
import { review, runEntries } from './review.ts'
import type { ReviewInput } from './review.ts'
import { signals } from './signals.ts'

export { docs }
export const userActions = ['setConfig', 'setRubric', 'feedback']
export const hostActions = ['setConfig', 'setRubric']
export const actions = {
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
    return host.harness().commit(async (tx) => {
      const note = (await tx.doc(State, ROOT_CONVERSATION_ID)).notes.find((n) => n.id === args.note)
      if (!note) throw new Error('Note not found')
      if (args.feedback === null) delete note.feedback
      else if (args.feedback === 'up' || args.feedback === 'down') note.feedback = args.feedback
      if (args.status === 'open' || args.status === 'resolved' || args.status === 'dismissed')
        note.status = args.status
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
  async function activity(api: HookApi, context: Context) {
    return host.harness().commit(async (tx) => {
      const run = (await tx.doc(LiveDoc, api.conversationId)).run?.inputs[0]
      const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
      let row = runs.conversations[api.conversationId]
      if (!row || row.run !== run) {
        runs.conversations[api.conversationId] = {
          ...(run !== undefined ? { run } : {}),
          rounds: 0,
          signals: [],
          ...(row?.lastInput !== undefined ? { lastInput: row.lastInput } : {}),
          ...(row?.pending !== undefined ? { pending: row.pending } : {}),
        }
        row = runs.conversations[api.conversationId]
      }
      row.lastActivity = Date.now()
      return { run, rounds: ++row.rounds, signals: [...row.signals] }
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
    if (
      !ROLES.some(
        (r) => view.effective.roles?.[r]?.enabled && view.effective.roles[r]?.at?.includes('idle'),
      )
    )
      return
    const context = BACKGROUND_CONTEXT
    const concluded = await host.want(ConversationsApi)?.concluded(context)
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
  return defineExtension({
    name: 'advisor',
    tasks: [ReviewTask],
    hooks: [
      hook(GenerationTask, {
        beforeInput: async (entry, api) => {
          const view = await config(false)
          if (
            !ROLES.some((r) => view.effective.roles?.[r]?.enabled) ||
            entry.kind === 'advisor.note'
          )
            return
          // User and inter-conversation inputs both suppress intervention. Passive parent notes are checked from history too.
          const state = await api.tx.doc(Runs, ROOT_CONVERSATION_ID)
          state.conversations[api.conversationId] ??= { rounds: 0, signals: [] }
          const row = state.conversations[api.conversationId]
          row.lastInput = Date.now()
          row.lastActivity = row.lastInput
        },
        afterTools: async (_assistant, _results, api, context) => {
          const target = await enabled(api.conversationId, context)
          if (!target) return
          const current = await activity(api, context)
          let point: ReviewPoint | undefined
          let signal: string | undefined
          if (target.profile.at?.includes('signals')) {
            const found = signals(
              await runEntries(host, api.conversationId, context),
              host.conversations().find((c) => c.id === api.conversationId)?.cwd ??
                host.projectRoot,
            ).filter((s) => !current.signals.includes(s))
            if (
              current.rounds > 40 &&
              !current.signals.includes('more than 40 tool rounds') &&
              !found.includes('more than 40 tool rounds')
            )
              found.push('more than 40 tool rounds')
            if (found.length) {
              point = 'signals'
              signal = found.join('; ')
              await host.harness().commit(async (tx) => {
                ;(await tx.doc(Runs, ROOT_CONVERSATION_ID)).conversations[
                  api.conversationId
                ].signals.push(...found)
              }, context)
            }
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
          const target = await enabled(api.conversationId, context)
          if (!target) return undefined
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
                row.run = run
                row.continued = false
              }
            }, context)
            const view = await config()
            return await review(
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
            )
          } catch (error) {
            // Advisory: provider and storage failures must never hold the final answer.
            host.notice(`Advisor answer review: ${String(error)}`)
            return undefined
          }
        },
      }),
    ],
  })
}
