/**
 * Dream before compaction: when @ultimate's context passes 80%, it writes a handoff while it still remembers everything,
 * then a dream starts by itself once nothing else works; once that dream settles, Ultimate falls asleep into a fresh
 * chapter only when it was worth it. The user's Dream button takes the same path: handoff first, then the dream.
 *
 * The trigger is an ordinary context automation, "Dream before compaction", that dream creates once per chapter, so the
 * user sees it in the Automations panel and can pause, delete, grant or re-threshold it like any other. It subscribes
 * @ultimate: its fire is the input that asks for the handoff. Its fires reach dream as `automations.fired`; only a fire
 * of this automation, checked by its id in dream's own document, records a `waiting` request and starts the wait, and
 * the wait starts a session only through `startDreamIn`'s own refusals. The user-only `start` stays user-only.
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
import { isDeepStrictEqual } from 'node:util'
import { readJson } from '../../lib/json-file.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AutomationsApi } from '../automations/api.ts'
import type { GrantedBy } from '../automations/api.ts'
import type { Automation } from '../automations/refs.ts'
import { LineageApi } from '../lineage/api.ts'
import { Standing } from '../subagents/api.ts'
import { deliver } from './delivery.ts'
import type { BeforeCompaction, Handoff, Session, Waiting } from './refs.ts'
import type { Seed } from './types.ts'
import { busyElsewhere } from './types.ts'

/** The built-in automation's name, shown in the Automations panel. */
export const AUTOMATION_NAME = 'Dream before compaction'
/** Its trigger as dream first makes it; the user may change the threshold. */
export const CONDITION = { metric: 'context' as const, of: '@ultimate', above: 80 }
/** The automation before this feature: dream migrates it in place to the condition above. */
const OLD_NAME = 'Dream after compaction'
const OLD_EVENT = { name: 'conversations.compacted', where: { conversation: '@ultimate' } }
const isOld = (item: Automation) =>
  item.event?.name === OLD_EVENT.name && isDeepStrictEqual(item.event.where, OLD_EVENT.where)

/**
 * The built-in automation dream created in this chapter, by id; `deleted` once the user deleted it, so it is not made
 * again. On conversation 1 of each chapter: a new chapter makes its own, enabled or paused as the seed says. The kind
 * keeps its first name: it holds the id and deletion of the automation it migrates.
 */
export const BuiltInDoc = defineDoc<{ id?: string; deleted?: true }>({
  kind: 'dream.after-compaction',
  checkpointWhen: () => false,
  // Version 1 read a seed from before this feature as "deleted": a deletion it recorded was never the user's.
  version: 2,
  migrate: (value) => {
    const { id } = value as { id?: string }
    return id === undefined ? {} : { id }
  },
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** How long a dream waits for every other conversation to finish, and how often it looks. */
export const DREAM_WAIT_MS = 2 * 3600_000
export const DREAM_LOOK_MS = 15_000
/** How long a dream waits for @ultimate's handoff before it starts without one. */
export const HANDOFF_WAIT_MS = 30 * 60_000

/** What @ultimate is asked to write before a dream, on the built-in automation's fire or the user's Dream button. */
export const HANDOFF_ASK = `Write your handoff now, while your context still holds everything: what you worked on, what is still open (branches, questions, to-dos) and how far each got, the decisions and why they were made, the user's corrections, the lessons, and what you would do next. Plain Markdown, at most 12,000 characters; record it with one codemode call, ultimate.action('dream', 'handoff', {text}). The dream reads it first, and a new chapter wakes up from it. Then end your turn with one line to the user: the dream starts by itself once nothing else works, after ${HANDOFF_WAIT_MS / 60_000} minutes without your handoff.`

/** Default of the `dream.asleepAfter` setting: this many landed or applied changes make a dream worth a fresh chapter. */
export const ASLEEP_AFTER = 5

/**
 * The most a handoff, or the compaction summary a dream without one falls back to, may carry into a new chapter's
 * wake-up (about 3k tokens, beside the memory brief). A longer handoff is refused when recorded, never cut.
 */
export const HANDOFF_CHARS = 12_000

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
 * carried it: paused stays paused, and one deleted before the switch is not made again. The automation from before
 * this feature ("Dream after compaction", on @ultimate's compaction) becomes this one in place: same id, enabled state,
 * grant and subscribers.
 */
export async function ensureAutomation(host: ExtensionHost) {
  // Every caller reads the chapter's own seed, so whichever runs first keeps its paused or deleted automation so.
  const seed = await readJson<Seed | undefined>(join(host.chapter.dir, 'seed.json'), undefined)
  // A gate's preview checks the seed against the real project; it makes nothing that could fire.
  if (seed?.gate) return
  if (!host.extensions().some((item) => item.name === 'automations' && item.enabled)) return
  const harness = host.harness()
  const state = await harness.snapshot(BuiltInDoc, ROOT_CONVERSATION_ID, context)
  if (state?.deleted) return
  const remember = (change: { id?: string; deleted?: true }) =>
    harness.commit(async (tx) => {
      Object.assign(await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID), change)
    }, context)
  // Only a seed that says so carries a deletion; one from before this feature has no say.
  if (!state?.id && seed?.builtIn === null) return remember({ deleted: true })
  const signal = new AbortController().signal
  // Session-scoped ledger: its list action reads it, as the seed does.
  const list = (await host.invoke('automations', 'list', null, signal)) as Automation[]
  const migrate = async (item: Automation) => {
    if (isOld(item))
      await host.invoke(
        'automations',
        'update',
        { id: item.id, name: AUTOMATION_NAME, condition: CONDITION },
        signal,
      )
  }
  if (state?.id) {
    const own = list.find((item) => item.id === state.id)
    // Gone from the list: the user deleted it, and that choice holds.
    if (!own) return remember({ deleted: true })
    return migrate(own)
  }
  // Never made here: on a fresh project the automation follows @ultimate's start.
  const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (ultimate === undefined) return
  // A create (or migration) whose receipt was lost is found by name and trigger target, not made twice. Not by
  // threshold or subscribers: the user may change them, and that must not make a second one.
  const found = list.find(
    (item) =>
      !item.prompt &&
      ((item.name === AUTOMATION_NAME && item.condition?.of === CONDITION.of) ||
        (item.name === OLD_NAME && isOld(item))),
  )
  if (found) await migrate(found)
  const created =
    found ??
    ((await host.invoke(
      'automations',
      'create',
      { name: AUTOMATION_NAME, condition: CONDITION, subscribers: [ultimate] },
      signal,
    )) as Automation)
  if (seed?.builtIn?.enabled === false && created.enabled)
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
      return inner.length > HANDOFF_CHARS ? `${inner.slice(0, HANDOFF_CHARS)}\n…` : inner
    }
    cursor = page.next
  } while (cursor)
  return undefined
}

/** Why no dream may start now: a session open, a sleep under way, or a chapter change running. */
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

type SettleInput = { session: number }

/** What started a session besides the user or a grant: the built-in automation, and the handoff request. */
export type Origin = { beforeCompaction?: BeforeCompaction; handoff?: Handoff }

export function compactionDream(
  host: ExtensionHost,
  deps: {
    Sessions: typeof import('./server.ts').Sessions
    /** Whether a chapter change holds the lock now. */
    switching: () => boolean
    /** Start a session for a handoff request, as `origin` says. */
    start: (tx: Tx, origin: Origin) => Promise<{ session: number }>
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
   * One look of wait `task`: `look` again while the handoff is still due, or another top-level conversation works and
   * time is left; `started` once the session started; `done` when no dream may start (another request replaced this
   * one, its automation paused or deleted, a session open, a sleep or a chapter change) or the wait ran out, which
   * leaves @ultimate a quiet note. Every check and the start commit together.
   */
  async function look(task: number, now: number) {
    const next = await host.harness().commit(async (tx) => {
      const doc = await tx.doc(deps.Sessions, ROOT_CONVERSATION_ID)
      const waiting = doc.waiting
      if (waiting?.task !== task) return 'done'
      const stop = (result: 'done') => {
        delete doc.waiting
        return result
      }
      // Expired first: a host that wakes long after the deadline gives up instead of starting a stale dream. The
      // request stays, marked, until its note is left: a crash in between leaves the note on the next look.
      if (waiting.gaveUp || now >= waiting.at + DREAM_WAIT_MS) {
        waiting.gaveUp = true
        return 'gave up'
      }
      const automation = waiting.automation && (await enabled(tx, waiting.automation.id))
      const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
      if ((waiting.automation && !automation) || ultimate === undefined) return stop('done')
      if (!waiting.handoff && now < waiting.at + HANDOFF_WAIT_MS) return 'look'
      if (blocked(doc.sessions, deps.switching())) return stop('done')
      if (busyElsewhere(host.conversations(), ultimate).length) return 'look'
      const handsOff = !!automation && !!automation.grant?.actions.includes('dream')
      const handoff: Handoff = waiting.handoff
        ? { task, text: waiting.handoff.text, at: waiting.handoff.at }
        : {
            task,
            missing: `no handoff within ${HANDOFF_WAIT_MS / 60_000} minutes of the request`,
          }
      delete doc.waiting
      await deps.start(tx, {
        handoff,
        ...(automation
          ? {
              beforeCompaction: {
                automation: automation.id,
                name: automation.name,
                at: now,
                ...(handsOff ? { handsOff } : {}),
              },
            }
          : {}),
      })
      return 'started'
    }, context)
    if (next === 'started') host.harness().resume()
    if (next !== 'gave up') return next
    const ultimate = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))
      ?.ultimate
    if (ultimate !== undefined)
      try {
        await host
          .need(LineageApi)
          .leaveNote(
            ultimate,
            `The dream after your handoff did not start: other conversations kept working for ${DREAM_WAIT_MS / 3600_000} hours. Nothing to do; the next time your context passes the threshold it tries again, and the user can press Dream.`,
            { requestId: `dream.handoff-wait:${task}` },
          )
      } catch (error) {
        // The request stays marked: the wait looks again and retries the note under the same request id, so a
        // failed note never ends the task with the request still blocking every later dream.
        host.notice(`Dream: the give-up note failed, retrying: ${String(error)}`)
        return 'look'
      }
    // The note is left (its request id makes a repeat harmless): only now does the request go.
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(deps.Sessions, ROOT_CONVERSATION_ID)
      if (doc.waiting?.task === task) delete doc.waiting
    }, context)
    return 'done'
  }

  /**
   * The wait of the event trigger before this feature, retired: one saved before the upgrade ends at once instead of
   * being blocked forever for a missing definition. A later fire asks for a handoff.
   */
  const Retired = defineTask<unknown, { phase: 'look' }, null>({
    name: 'dream.after-compaction',
    version: 1,
    initial: () => ({ phase: 'look' }),
    phases: { look: (_task, runtime, ctx) => runtime.commit(() => done, ctx) },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

  /** One request's wait: a look every 15 seconds, for the handoff and then for idle, up to two hours in all. */
  const Wait = defineTask<{ at: number }, { phase: 'look' }, null>({
    name: 'dream.handoff-wait',
    version: 1,
    initial: () => ({ phase: 'look' }),
    phases: {
      look: async (task, runtime, ctx) => {
        const now = runtime.now()
        if ((await look(Number(task.id), now)) === 'look')
          return runtime.sleepUntil(now + DREAM_LOOK_MS, { phase: 'look' }, ctx)
        await runtime.commit(() => done, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

  /**
   * Inside `tx`: record a request for @ultimate's handoff, start its wait and ask conversation `ultimate` for it.
   * `automation` names the built-in automation whose fire asked: that fire's own input already wakes @ultimate, whose
   * prompt says to hand off on it, so the ask here is a passive write that costs no turn (it joins the fire's run when
   * it comes first). A second input would start a second run. Absent when the user pressed Dream: then the ask is the
   * input that wakes it. Refuses while a request waits or no dream may start.
   */
  async function request(
    tx: Tx,
    now: number,
    ultimate: number,
    automation?: Waiting['automation'],
  ) {
    const doc = await tx.doc(deps.Sessions, ROOT_CONVERSATION_ID)
    if (doc.waiting) throw new Error("A dream already waits for @ultimate's handoff")
    const why = blocked(doc.sessions, deps.switching())
    if (why) throw new Error(why)
    const task = Number(
      await tx.createTask(
        Wait,
        { at: now },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      ),
    )
    const waiting: Waiting = { at: now, task, ...(automation ? { automation } : {}) }
    doc.waiting = waiting
    await deliver(host, tx, ultimate, {
      type: automation ? 'write' : 'input',
      session: task,
      kind: 'dream.handoff',
      data: { task, ...(automation ? { automation } : {}) },
      content: `${automation ? `Your context passed the threshold of automation ${automation.id} "${automation.name}": a dream follows.` : 'The user pressed Dream.'} ${HANDOFF_ASK}`,
    })
    return waiting
  }

  /**
   * Once a built-in automation's session settles: below `dream.asleepAfter` changes it stays in this chapter; at or
   * above, a grant of `asleep` on its automation falls asleep through the granted Fall asleep (every gate), else the
   * user is asked on the card. Records the outcome on the session and leaves a `dream.settled` entry in @ultimate's
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
      const before = found?.beforeCompaction
      const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
      if (!found || !before || before.outcome || ultimate === undefined) return
      // The grant is read here, with the sleep it allows: a revoke, pause or delete committed before counts.
      const automation = await enabled(tx, before.automation)
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
      before.outcome = {
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

  /** A fire of the built-in automation asks for a handoff, unless a request already waits or no dream may start now. */
  async function fired(tx: Tx, id: string, now: number) {
    if ((await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)).id !== id) return
    const doc = await tx.doc(deps.Sessions, ROOT_CONVERSATION_ID)
    const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
    if (ultimate === undefined || doc.waiting || blocked(doc.sessions, deps.switching())) return
    const automation = await host.want(AutomationsApi)?.read(tx, id)
    await request(tx, now, ultimate, { id, name: automation?.name ?? AUTOMATION_NAME })
  }

  /** Inside `tx`: once the built-in automation's session `found` has settled, start its check, once. */
  async function settled(tx: Tx, found: Session) {
    const before = found.beforeCompaction
    if (!before || found.endedAt === undefined || !found.journal || before.settling !== undefined)
      return
    before.settling = Number(
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

  return { Wait, Retired, Settle, fired, request, settled, look, settle }
}
