/**
 * Dream after compaction: when @ultimate's own context compacts, a dream starts by itself once nothing else works; once
 * that dream settles, Ultimate falls asleep into a fresh chapter only when it was worth it.
 *
 * The trigger is an ordinary event automation, "Dream after compaction", that dream creates once per chapter, so the
 * user sees it in the Automations panel and can pause, delete or grant it like any other. It subscribes @ultimate, the
 * conversation its grants speak to. Its fires reach dream as `automations.fired`; only a fire of this automation,
 * checked by its id in dream's own document, starts the wait, and the wait starts a session only through
 * `startDreamIn`'s own refusals. The user-only `start` stays user-only.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  CompactionEntry,
  defineDoc,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, JsonObject, Tx } from '@earendil-works/pi-durable'
import { join } from 'node:path'
import { readJson } from '../../lib/json-file.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AutomationsApi } from '../automations/api.ts'
import type { GrantedBy } from '../automations/api.ts'
import type { Automation } from '../automations/refs.ts'
import { LineageApi } from '../lineage/api.ts'
import { Standing } from '../subagents/api.ts'
import { deliver } from './delivery.ts'
import type { AfterCompaction, Session } from './refs.ts'
import type { Seed } from './types.ts'
import { busyElsewhere } from './types.ts'

/** The built-in automation's name, shown in the Automations panel. */
export const AUTOMATION_NAME = 'Dream after compaction'
const TRIGGER = { name: 'conversations.compacted', where: { conversation: '@ultimate' } }

/**
 * The built-in automation dream created in this chapter, by id; `deleted` once the user deleted it, so it is not made
 * again. On conversation 1 of each chapter: a new chapter makes its own, enabled or paused as the seed says.
 */
export const AfterCompactionDoc = defineDoc<{ id?: string; deleted?: true }>({
  kind: 'dream.after-compaction',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** How long a compaction's dream waits for every other conversation to finish, and how often it looks. */
export const DREAM_WAIT_MS = 2 * 3600_000
export const DREAM_LOOK_MS = 15_000

/** Default of the `dream.asleepAfter` setting: this many landed or applied changes make a dream worth a fresh chapter. */
export const ASLEEP_AFTER = 5

/** The most of @ultimate's compaction summary a new chapter's wake-up carries (about 3k tokens). */
export const SUMMARY_CHARS = 12_000

/** `dream.asleepAfter`, project over user settings: a positive integer, else the default. */
export async function asleepAfter(host: Pick<ExtensionHost, 'userHome' | 'projectSettings'>) {
  // Invalid settings JSON is reported where settings load; here it counts as unset.
  const user: JsonObject = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
  for (const settings of [await host.projectSettings(), user]) {
    const dream = settings.dream
    if (!dream || typeof dream !== 'object' || Array.isArray(dream)) continue
    if (!Object.hasOwn(dream, 'asleepAfter')) continue
    const value = dream.asleepAfter
    if (!Number.isSafeInteger(value) || (value as number) < 1)
      throw new Error(
        `Invalid dream.asleepAfter ${JSON.stringify(value)}: expected a positive integer`,
      )
    return value as number
  }
  return ASLEEP_AFTER
}

/** What a settled session changed: the proposals that landed or were applied. */
export const changes = (found: Session) =>
  found.proposals.filter((item) => item.status === 'landed' || item.status === 'applied').length

/**
 * Make sure this chapter has the built-in automation, unless the user deleted it. A new chapter makes it as its `seed`
 * carried it: paused stays paused, and one deleted before the switch is not made again.
 */
export async function ensureAutomation(host: ExtensionHost) {
  // Every caller reads the chapter's own seed, so whichever runs first keeps its paused or deleted automation so.
  const seed = await readJson<Seed | undefined>(join(host.chapter.dir, 'seed.json'), undefined)
  // A gate's preview checks the seed against the real project; it makes nothing that could fire.
  if (seed?.gate) return
  if (!host.extensions().some((item) => item.name === 'automations' && item.enabled)) return
  const harness = host.harness()
  const state = await harness.snapshot(AfterCompactionDoc, ROOT_CONVERSATION_ID, context)
  if (state?.deleted) return
  const remember = (change: { id?: string; deleted?: true }) =>
    harness.commit(async (tx) => {
      Object.assign(await tx.doc(AfterCompactionDoc, ROOT_CONVERSATION_ID), change)
    }, context)
  if (!state?.id && seed && !seed.afterCompaction) return remember({ deleted: true })
  const signal = new AbortController().signal
  // Session-scoped ledger: its list action reads it, as the seed does.
  const list = (await host.invoke('automations', 'list', null, signal)) as Automation[]
  // Gone from the list: the user deleted it, and that choice holds.
  if (state?.id)
    return list.some((item) => item.id === state.id) ? undefined : remember({ deleted: true })
  const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (ultimate === undefined) return
  // A create whose receipt was lost is found by name and trigger, not made twice.
  const created =
    list.find((item) => item.name === AUTOMATION_NAME && item.event?.name === TRIGGER.name) ??
    ((await host.invoke(
      'automations',
      'create',
      { name: AUTOMATION_NAME, event: TRIGGER, subscribers: [ultimate] },
      signal,
    )) as Automation)
  if (seed?.afterCompaction?.enabled === false && created.enabled)
    await host.need(AutomationsApi).pause(created.id)
  await remember({ id: created.id })
}

/**
 * The newest compaction summary of conversation `id`, without Pi's wrapper and the project memory lineage appends to
 * @ultimate's (a new chapter carries its memories itself), capped; undefined when it never compacted.
 */
export async function compactionSummary(tx: Tx, id: ConversationId) {
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries({ conversationId: id }, 200, cursor)
    const entry = page.items.find((item) => item.kind === CompactionEntry.kind)
    if (entry) {
      const message = entry.model?.[0]
      if (message?.role !== 'user') return undefined
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      const inner = (/<summary>\n?([\s\S]*?)\n?<\/summary>/.exec(text)?.[1] ?? text)
        .split('<project_memory')[0]
        .trim()
      return inner.length > SUMMARY_CHARS ? `${inner.slice(0, SUMMARY_CHARS)}\n…` : inner
    }
    cursor = page.next
  } while (cursor)
  return undefined
}

/** Why no dream may start for a compaction now: a session open, a sleep under way, or a chapter change running. */
function blocked(sessions: Session[], switching: boolean) {
  if (switching) return 'A chapter change is running'
  const open = sessions.find((item) => item.endedAt === undefined)
  if (open) return `Dream session ${open.id} is still open`
  const sleeping = sessions.find(
    (item) => item.sleep && item.sleep.phase !== 'failed' && item.sleep.phase !== 'asleep',
  )
  if (sleeping) return `Dream session ${sleeping.id} is falling asleep`
  return undefined
}

type WaitInput = { automation: string; name: string; deadline: number }
type SettleInput = { session: number }

export function compactionDream(
  host: ExtensionHost,
  deps: {
    Sessions: typeof import('./server.ts').Sessions
    /** Whether a chapter change holds the lock now. */
    switching: () => boolean
    start: (tx: Tx, after: AfterCompaction) => Promise<{ session: number }>
    grantedSleep: (tx: Tx, by: GrantedBy, input: { session?: number }) => Promise<unknown>
  },
) {
  const done = {
    status: 'terminal' as const,
    outcome: { status: 'completed' as const, result: null },
  }
  /**
   * The automation `id` as `tx` sees it, only while it is enabled: a paused or deleted one does nothing and grants
   * nothing. Read in the transaction of the effect it allows, as automations' own `act` does.
   */
  const enabled = async (tx: Tx, id: string) => {
    const automation = await host.want(AutomationsApi)?.read(tx, id)
    return automation?.enabled ? automation : undefined
  }

  /**
   * One look of wait `task`: `look` again while another top-level conversation works and time is left; `started` once
   * the session started; `done` when no dream may start (its automation paused or deleted, a session open, a sleep or
   * a chapter change) or the wait ran out, which leaves @ultimate a quiet note. Every check and the start commit
   * together.
   */
  async function look(input: WaitInput, task: number, now: number) {
    const next = await host.harness().commit(async (tx) => {
      // Expired first: a host that wakes long after the deadline gives up instead of starting a stale dream.
      if (now >= input.deadline) return 'gave up'
      const automation = await enabled(tx, input.automation)
      const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
      const { sessions } = await tx.doc(deps.Sessions, ROOT_CONVERSATION_ID)
      if (!automation || ultimate === undefined || blocked(sessions, deps.switching()))
        return 'done'
      if (busyElsewhere(host.conversations(), ultimate).length) return 'look'
      const handsOff = !!automation.grant?.actions.includes('dream')
      await deps.start(tx, {
        automation: input.automation,
        name: input.name,
        at: now,
        ...(handsOff ? { handsOff } : {}),
      })
      return 'started'
    }, context)
    if (next === 'started') host.harness().resume()
    if (next !== 'gave up') return next
    const ultimate = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))
      ?.ultimate
    if (ultimate !== undefined)
      await host
        .need(LineageApi)
        .leaveNote(
          ultimate,
          `The dream after your compaction did not start: other conversations kept working for ${DREAM_WAIT_MS / 3600_000} hours. Nothing to do; the next compaction tries again, and the user can press Dream.`,
          { requestId: `dream.after-compaction:${task}` },
        )
    return 'done'
  }

  /** One fire's wait: a look every 15 seconds, for up to two hours. */
  const Wait = defineTask<WaitInput, { phase: 'look' }, null>({
    name: 'dream.after-compaction',
    version: 1,
    initial: () => ({ phase: 'look' }),
    phases: {
      look: async (task, runtime, ctx) => {
        const now = runtime.now()
        if ((await look(task.input, Number(task.id), now)) === 'look')
          return runtime.sleepUntil(now + DREAM_LOOK_MS, { phase: 'look' }, ctx)
        await runtime.commit(() => done, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

  /**
   * Once a compaction's session settles: below `dream.asleepAfter` changes it stays in this chapter; at or above, a
   * grant of `asleep` on its automation falls asleep through the granted Fall asleep (every gate), else the user is
   * asked on the card. Records the outcome on the session and leaves a `dream.settled` entry in @ultimate's
   * conversation, an input only when the user must be asked.
   */
  async function settle(session: number) {
    const threshold = await asleepAfter(host).catch((error: unknown) => {
      host.notice(`Dream: ${String(error)}; using ${ASLEEP_AFTER}`)
      return ASLEEP_AFTER
    })
    await host.harness().commit(async (tx) => {
      const found = (await tx.doc(deps.Sessions, ROOT_CONVERSATION_ID)).sessions.find(
        (item) => item.id === session,
      )
      const after = found?.afterCompaction
      const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
      if (!found || !after || after.outcome || ultimate === undefined) return
      // The grant is read here, with the sleep it allows: a revoke, pause or delete committed before counts.
      const automation = await enabled(tx, after.automation)
      const granted = !!automation?.grant?.actions.includes('asleep')
      const count = changes(found)
      let result: 'stay' | 'ask' | 'asleep' =
        count < threshold ? 'stay' : granted ? 'asleep' : 'ask'
      let error: string | undefined
      if (result === 'asleep')
        try {
          await deps.grantedSleep(
            tx,
            { automation: automation!.id, name: automation!.name, at: Date.now() },
            { session: found.id },
          )
        } catch (refused) {
          result = 'ask'
          error = String(refused)
        }
      after.outcome = {
        changes: count,
        threshold,
        result,
        ...(error ? { error } : {}),
        at: Date.now(),
      }
      const words = `${count} change${count === 1 ? '' : 's'} landed or applied; a fresh chapter takes ${threshold}`
      await deliver(host, tx, ultimate, {
        type: result === 'ask' ? 'input' : 'write',
        session: found.id,
        kind: 'dream.settled',
        content:
          result === 'stay'
            ? `Dream session ${found.id} settled: ${words}. We stay in this chapter; carry on.`
            : result === 'asleep'
              ? `Dream session ${found.id} settled: ${words}. Automation ${automation!.id} "${automation!.name}" holds the user's Fall asleep grant, so Fall asleep runs by itself once nothing works, through every gate. Nothing to do.`
              : `Dream session ${found.id} settled: ${words}. Ask the user whether to Fall asleep now or later: the card above has the Fall asleep button, which only they press. Never call asleep yourself.${error ? ` (The automation's Fall asleep grant was refused: ${error})` : ''}`,
      })
    }, context)
    host.harness().resume()
  }

  const Settle = defineTask<SettleInput, { phase: 'decide' }, null>({
    name: 'dream.settled',
    version: 1,
    initial: () => ({ phase: 'decide' }),
    phases: {
      decide: async (task, runtime, ctx) => {
        await settle(task.input.session)
        await runtime.commit(() => done, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

  /** A fire of the built-in automation starts one wait, unless one already waits or no dream may start now. */
  async function fired(tx: Tx, id: string) {
    if ((await tx.doc(AfterCompactionDoc, ROOT_CONVERSATION_ID)).id !== id) return
    // Every task scan before the first write.
    for (const status of ['pending', 'running', 'waiting', 'sleeping'] as const)
      if (
        (
          await tx.scanTasks(
            { conversationId: ROOT_CONVERSATION_ID, kind: Wait.definition.name, status },
            1,
          )
        ).items.length
      )
        return
    const { sessions } = await tx.doc(deps.Sessions, ROOT_CONVERSATION_ID)
    if (blocked(sessions, deps.switching())) return
    await tx.createTask(
      Wait,
      { automation: id, name: AUTOMATION_NAME, deadline: Date.now() + DREAM_WAIT_MS },
      {
        conversationId: ROOT_CONVERSATION_ID,
        ownership: { kind: 'conversation' },
        background: true,
      },
    )
  }

  /** Inside `tx`: once compaction session `found` has settled, start its check, once. */
  async function settled(tx: Tx, found: Session) {
    const after = found.afterCompaction
    if (!after || found.endedAt === undefined || !found.journal || after.settling !== undefined)
      return
    after.settling = Number(
      await tx.createTask(
        Settle,
        { session: found.id },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      ),
    )
  }

  return { Wait, Settle, fired, settled, look, settle }
}
