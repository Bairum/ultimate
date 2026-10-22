import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, SubmissionId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { Gate } from '../messages/api.ts'
import { PauseApi } from './api.ts'
import { lasted } from './lasted.ts'
import { PauseAction, PauseDoc, PlayAction, StateAction } from './refs.ts'
import type { PauseDocState, PauseNote, PauseState, RunningTask } from './refs.ts'

const State = defineDoc<PauseDocState>({
  kind: PauseDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ paused: false }),
})
export const docs = [State]

type Host = Pick<ExtensionHost, 'harness' | 'resource' | 'onOpen' | 'implement' | 'conversations'>

/** The flag timers read synchronously; shared across reloads, set from the doc each time the harness opens. */
const flag = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource('pause.flag', () => ({ paused: false }))

const read = async (host: Host) =>
  (await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)) ?? { paused: false }

/** Run pause, play and the reopen hold one at a time, across reloads: an interleaving could release a paused host. */
function serial<T>(host: Pick<ExtensionHost, 'resource'>, work: () => Promise<T>): Promise<T> {
  const queue = host.resource('pause.queue', () => ({
    chain: Promise.resolve() as Promise<unknown>,
  }))
  const next = queue.chain.then(work)
  // The caller gets the failure; the chain only waits for the work to settle.
  queue.chain = next.catch(() => undefined)
  return next
}

/**
 * Background phases that only wait on other work (a run, a submission, a timer), which a pause holds: they never end
 * while paused and execute nothing meanwhile, so they never keep the pause from being safe. A `board.delivery` and a
 * `board.reply` triage through the gate (`gated`), which counts that model call on its own.
 */
const PASSIVE: Record<string, string[]> = {
  'ultimate.subagent-reporter': ['deliver', 'retry'],
  'ultimate.automation-scheduler': ['sleep'],
  'ultimate.automation-run': ['deliver'],
  'board.delivery': ['deliver', 'reply'],
  'board.route': ['observe'],
  'conversations.summary': ['observe'],
  'lineage.notify': ['wait'],
}
export const passive = (record: { kind: string; state: unknown }) => {
  const phase = (record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase
  return !!phase && (PASSIVE[record.kind] ?? []).includes(phase)
}

type Call = { task: number; conversationId: number; what: string; startedAt: number }
/** In-task work through the gate: the calls in flight, and the ones waiting for Play. Shared across reloads. */
const gate = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource('pause.gate', () => ({
    next: 1,
    calls: new Map<number, Call>(),
    waiters: new Set<() => void>(),
  }))

/** Bump the pause doc while paused, so the footer refreshes when in-flight work ends; none starts while paused. */
async function bump(host: Host) {
  if (!flag(host).paused) return
  await host
    .harness()
    .commit(async (tx) => {
      const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
      doc.work = (doc.work ?? 0) + 1
    }, context)
    .catch((error: unknown) => {
      // Only the footer's refresh is lost; the work itself and the pause stand.
      console.error('pause: refreshing the state failed:', error)
    })
}

/** Until Play, or until `signal` aborts. */
function played(host: Host, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const { waiters } = gate(host)
    const stop = () => {
      waiters.delete(done)
      reject(signal.reason)
    }
    const done = () => {
      waiters.delete(done)
      signal.removeEventListener('abort', stop)
      resolve()
    }
    if (signal.aborted) return stop()
    waiters.add(done)
    signal.addEventListener('abort', stop, { once: true })
  })
}

/** The gate: work starts only while playing, and counts as running while it runs. */
export async function gated<T>(
  host: Host,
  call: Omit<Call, 'startedAt'>,
  fn: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  while (flag(host).paused) await played(host, signal)
  const inFlight = gate(host)
  const id = inFlight.next++
  inFlight.calls.set(id, { ...call, startedAt: Date.now() })
  try {
    return await fn()
  } finally {
    inFlight.calls.delete(id)
    await bump(host)
  }
}

/**
 * Tasks with a running invocation that execute something (a model response, a tool, a summary streaming): each
 * finishes on its own, then nothing starts after it. Passive waiters never count.
 */
async function running(host: Host): Promise<RunningTask[]> {
  const harness = host.harness()
  const { tasks } = await harness.inspect(context)
  const titles = new Map(host.conversations().map((c) => [c.id, c.label ?? c.title]))
  const tools = new Map<number, Map<number, string>>()
  const toolName = async (conversationId: ConversationId, task: number) => {
    if (!tools.has(conversationId)) {
      const live = await harness.snapshot(LiveDoc, conversationId, context)
      const slots = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])]
      tools.set(
        conversationId,
        new Map(
          slots.flatMap((slot) => (slot.taskId === undefined ? [] : [[slot.taskId, slot.name]])),
        ),
      )
    }
    return tools.get(conversationId)!.get(task)
  }
  const result: RunningTask[] = []
  for (const call of gate(host).calls.values()) {
    const title = titles.get(call.conversationId)
    result.push({ ...call, ...(title ? { title } : {}) })
  }
  for (const { record, state: inspected } of tasks) {
    if (inspected.kind !== 'running' || (record.background && passive(record))) continue
    const what =
      record.kind === 'pi.generation'
        ? 'model response'
        : record.kind === 'pi.tool'
          ? ((await toolName(record.conversationId, record.id)) ?? 'tool call')
          : record.kind
    const title = titles.get(record.conversationId)
    result.push({
      task: record.id,
      conversationId: record.conversationId,
      ...(title ? { title } : {}),
      what,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    })
  }
  return result
}

async function state(host: Host): Promise<PauseState> {
  const doc = await read(host)
  return {
    paused: doc.paused,
    ...(doc.since === undefined ? {} : { since: doc.since }),
    running: await running(host),
  }
}

// Pi upstream: @earendil-works/pi-durable@1.4.0 — patched Harness.hold()/release() keep the scheduler from starting tasks.
/** Hold the scheduler, then record the pause and each run mid-turn now (its task and first input), which Play notes. */
async function pause(host: Host) {
  const harness = host.harness()
  harness.hold()
  flag(host).paused = true
  await harness.commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    if (doc.paused) return
    const runs: NonNullable<PauseDocState['runs']> = {}
    for (const status of ['pending', 'running', 'waiting'] as const) {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks({ kind: 'pi.generation', status }, 100, cursor)
        for (const task of page.items) {
          const run = (await tx.doc(LiveDoc, task.conversationId)).run
          if (run?.taskId === task.id)
            runs[task.conversationId] = { task: task.id, input: run.inputs[0] }
        }
        cursor = page.next
      } while (cursor)
    }
    Object.assign(doc, { paused: true, since: Date.now(), runs })
  }, context)
  return state(host)
}

/**
 * Whether Play notes conversation `id`: its run recorded at the pause continues (the same task, or the run it handed
 * over to, which keeps its inputs), or it completed during the drain. A run stopped meanwhile, or a new one, gets none.
 */
async function noted(host: Host, id: ConversationId, recorded: { task: number; input?: number }) {
  const harness = host.harness()
  const run = (await harness.snapshot(LiveDoc, id, context))?.run
  if (
    run &&
    (run.taskId === recorded.task ||
      (recorded.input !== undefined && run.inputs[0] === recorded.input))
  )
    return 'continued'
  // Only the recorded input's own answer counts as the run finishing: a completed generation may have handed the run
  // to a successor that was stopped, leaving the input unanswered.
  if (recorded.input === undefined) return undefined
  const input = await (
    await harness.submission(recorded.input as SubmissionId, context)
  )?.status(context)
  return input?.status === 'done' ? 'finished' : undefined
}

/**
 * Leave one note on each run that was mid-turn at the pause and still is, placed at its next step, then record the
 * end and release the scheduler. A retry after a crash finds the notes by request ID and leaves no second one.
 */
async function play(host: Host) {
  const harness = host.harness()
  const doc = await read(host)
  if (doc.paused && doc.since !== undefined) {
    const until = Date.now()
    const span = lasted(until - doc.since)
    for (const [key, recorded] of Object.entries(doc.runs ?? {})) {
      const id = Number(key) as ConversationId
      const how = await noted(host, id, recorded)
      if (!how) continue
      const note: PauseNote = {
        since: doc.since,
        until,
        ...(how === 'finished' && { finished: true }),
      }
      const content =
        how === 'finished'
          ? `Paused for ${span} after this run's last answer.`
          : `Paused for ${span}; the run continued after Play.`
      const conversation = await harness.conversation(id, context)
      await conversation?.submit(
        {
          type: 'write',
          requestId: `pause.note:${note.since}`,
          entry: {
            kind: 'pause.note',
            data: note,
            model: [{ role: 'user', content, timestamp: note.until }],
          },
        },
        context,
      )
    }
  }
  await harness.commit(async (tx) => {
    const current = await tx.doc(State, ROOT_CONVERSATION_ID)
    current.paused = false
    delete current.since
    delete current.runs
    delete current.work
  }, context)
  flag(host).paused = false
  harness.release()
  // Gated work waiting for Play starts now.
  for (const resume of gate(host).waiters) resume()
  return state(host)
}

export default function pauseExtension(host: Host) {
  host.implement(PauseApi, { paused: () => flag(host).paused })
  host.implement(Gate, {
    work: (call, fn, signal) => gated(host, call, fn, signal),
  })
  // The server resumes scheduling only after every opener settled, so a paused host reopens with nothing started.
  host.onOpen(() =>
    serial(host, async () => {
      const paused = (await read(host)).paused
      flag(host).paused = paused
      if (paused) host.harness().hold()
    }),
  )
  return { name: 'pause' }
}

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => state(host)),
  pause: implementAction(PauseAction, (_args, { host }) => serial(host, () => pause(host))),
  play: implementAction(PlayAction, (_args, { host }) => serial(host, () => play(host))),
}
export const userActions = ['pause', 'play']
