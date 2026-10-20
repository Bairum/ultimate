import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { PauseApi } from './api.ts'
import { lasted } from './lasted.ts'
import { PauseAction, PauseDoc, PlayAction, StateAction } from './refs.ts'
import type { PauseDocState, PauseNote, PauseState, RunningTask } from './refs.ts'

const State = defineDoc<PauseDocState>({
  kind: PauseDoc.kind,
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

/** Foreground tasks with a running invocation: each finishes on its own, then nothing starts after it. */
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
  for (const { record, state: inspected } of tasks) {
    if (inspected.kind !== 'running' || record.background) continue
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

// Pi upstream: @earendil-works/pi-durable@1.3.0 — patched Harness.hold()/release() keep the scheduler from starting tasks.
/** Hold the scheduler, then record the pause and the conversations mid-turn now, which Play leaves a note. */
async function pause(host: Host) {
  const harness = host.harness()
  harness.hold()
  flag(host).paused = true
  const { tasks } = await harness.inspect(context)
  const runs = [
    ...new Set(
      tasks
        .filter(({ record }) => record.kind === 'pi.generation')
        .map(({ record }) => record.conversationId),
    ),
  ].toSorted((a, b) => a - b)
  await harness.commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    if (doc.paused) return
    Object.assign(doc, { paused: true, since: Date.now(), runs })
  }, context)
  return state(host)
}

/**
 * Leave one note on each run that was mid-turn at the pause and still is, placed at its next step, then record the
 * end and release the scheduler. A retry after a crash finds the notes by request ID and leaves no second one.
 */
async function play(host: Host) {
  const harness = host.harness()
  const doc = await read(host)
  if (doc.paused && doc.since !== undefined) {
    const note: PauseNote = { since: doc.since, until: Date.now() }
    const content = `Paused for ${lasted(note.until - note.since)}; the run continued after Play.`
    for (const id of doc.runs ?? []) {
      if (!(await harness.snapshot(LiveDoc, id as ConversationId, context))?.run) continue
      const conversation = await harness.conversation(id as ConversationId, context)
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
  }, context)
  flag(host).paused = false
  harness.release()
  return state(host)
}

export default function pauseExtension(host: Host) {
  host.implement(PauseApi, { paused: () => flag(host).paused })
  // The server resumes scheduling only after every opener settled, so a paused host reopens with nothing started.
  host.onOpen(async () => {
    const paused = (await read(host)).paused
    flag(host).paused = paused
    if (paused) host.harness().hold()
  })
  return { name: 'pause' }
}

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => state(host)),
  pause: implementAction(PauseAction, (_args, { host }) => pause(host)),
  play: implementAction(PlayAction, (_args, { host }) => play(host)),
}
export const userActions = ['pause', 'play']
