import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { readSession, updateSession, wake } from './session.ts'
import {
  ConfirmAction,
  ConfirmTaskAction,
  ConfirmChangeAction,
  DenyAction,
  GrantAction,
  HardStopAction,
  ReleaseAction,
  ResumeAction,
  StateAction,
  StopAction,
  TakeoverAction,
} from './refs.ts'
import { plainTask, activatePending, runtime, driverFor } from './runtime.ts'
import * as task from './task.ts'

export function validate<T>(
  args: T,
  requireApp = false,
): asserts args is T &
  Exclude<T, string | number | boolean | unknown[] | null> & { conversation: number; app: string } {
  if (
    !args ||
    typeof args !== 'object' ||
    !('conversation' in args) ||
    typeof args.conversation !== 'number' ||
    !Number.isSafeInteger(args.conversation) ||
    args.conversation < 1
  )
    throw new Error('conversation must be a positive integer')
  if (
    (requireApp && !('app' in args)) ||
    ('app' in args && (typeof args.app !== 'string' || !args.app.trim()))
  )
    throw new Error('app must be nonempty')
}
export async function stop(host: ExtensionHost, conversation: number) {
  validate({ conversation })
  const state = runtime(host)
  const active = state.active.get(conversation)
  if (active) active.stopped = true
  const previous = await readSession(host, conversation)
  await updateSession(host, conversation, (doc) => {
    doc.stopped = true
    if (doc.task) doc.task = task.markInterrupted(plainTask(doc.task), 'stop', [], Date.now())
    doc.takeovers = []
  })
  if (active) {
    active.stopped = true
    if (active.inFlight && !previous.stopped) {
      active.timer = setTimeout(() => {
        if (active.inFlight)
          void hardStop(host).catch((error) => console.error('computer-use: stop failed:', error))
      }, 1000)
      active.timer.unref()
    }
  }
  if (previous.stopped) await hardStop(host)
  return readSession(host, conversation)
}
export async function hardStop(host: ExtensionHost) {
  const state = runtime(host)
  const updates: Promise<void>[] = []
  clearTimeout(state.idle)
  for (const [conversation, active] of state.active) {
    active.stopped = true
    clearTimeout(active.timer)
    updates.push(
      updateSession(host, conversation, (doc) => {
        doc.stopped = true
        if (doc.task) doc.task = task.markInterrupted(plainTask(doc.task), 'stop', [], Date.now())
        doc.takeovers = []
      }),
    )
  }
  state.observations.clear()
  state.zoomed.clear()
  // Kill concurrently with durable updates: disk latency must not delay the emergency stop.
  await Promise.all([
    ...updates,
    (async () => {
      await (state.driver ? await state.driver : await driverFor(host)).stop()
    })(),
  ])
  return { stopped: true as const }
}
export const actions = {
  confirmTask: implementAction(ConfirmTaskAction, async (args, { host }) => {
    validate(args)
    await updateSession(host, args.conversation, (doc) => {
      if (!doc.task) throw new Error('No task confirmation pending')
      doc.task = task.confirmTask(plainTask(doc.task), Date.now())
      doc.pending = doc.pending.filter((p) => p.kind !== 'task')
    })
    await wake(
      host,
      args.conversation,
      'The user confirmed the computer task; continue from a fresh observe.',
    )
    return readSession(host, args.conversation)
  }),
  confirmChange: implementAction(ConfirmChangeAction, async (args, { host }) => {
    validate(args)
    await updateSession(host, args.conversation, (doc) => {
      if (!doc.task) throw new Error('No task change pending')
      doc.task = activatePending(task.confirmChange(plainTask(doc.task), Date.now()))
      doc.pending = doc.pending.filter((p) => p.kind !== 'change')
    })
    await wake(
      host,
      args.conversation,
      'The user confirmed the computer task replan; continue from a fresh observe.',
    )
    return readSession(host, args.conversation)
  }),
  state: implementAction(StateAction, (args, { host }) => {
    validate(args)
    return readSession(host, args.conversation)
  }),
  grant: implementAction(GrantAction, async (args, { host }) => {
    validate(args, true)
    if (
      (args.scope !== 'once' && args.scope !== 'conversation' && args.scope !== 'project') ||
      (args.always !== undefined && typeof args.always !== 'boolean')
    )
      throw new Error('Invalid grant scope or always flag')
    const scope = args.scope
    const always = args.always
    await updateSession(host, args.scope === 'project' ? 1 : args.conversation, (doc) => {
      doc.grants.push({
        app: args.app,
        scope,
        ...(always === undefined ? {} : { always }),
        at: Date.now(),
      })
    })
    await updateSession(host, args.conversation, (doc) => {
      doc.pending = doc.pending.filter(
        (p) => !(p.app.toLowerCase() === args.app.toLowerCase() && p.kind === 'consent'),
      )
    })
    await wake(
      host,
      args.conversation,
      `The user granted ${args.app} (${args.scope}); continue from a fresh observe.`,
    )
    return readSession(host, args.conversation)
  }),
  deny: implementAction(DenyAction, async (args, { host }) => {
    validate(args, true)
    await updateSession(host, args.conversation, (doc) => {
      doc.grants.push({ app: args.app, scope: 'deny', at: Date.now() })
      doc.takeovers = doc.takeovers.filter((t) => t.app.toLowerCase() !== args.app.toLowerCase())
      doc.pending = doc.pending.filter((p) => p.app.toLowerCase() !== args.app.toLowerCase())
    })
    return readSession(host, args.conversation)
  }),
  confirm: implementAction(ConfirmAction, async (args, { host }) => {
    validate(args)
    if (typeof args.key !== 'string') throw new Error('key must be a string')
    const key = args.key
    await updateSession(host, args.conversation, (doc) => {
      if (!doc.pending.some((p) => p.kind === 'confirm' && p.key === args.key))
        throw new Error('key must name an exact pending confirmation')
      doc.confirmed.push(key)
      doc.pending = doc.pending.filter((p) => p.key !== args.key)
    })
    await wake(
      host,
      args.conversation,
      'The user confirmed the pending computer action; continue from a fresh observe.',
    )
    return readSession(host, args.conversation)
  }),
  stop: implementAction(StopAction, (args, { host }) => {
    validate(args)
    return stop(host, args.conversation)
  }),
  hardStop: implementAction(HardStopAction, (_args, { host }) => hardStop(host)),
  resume: implementAction(ResumeAction, async (args, { host }) => {
    validate(args)
    await updateSession(host, args.conversation, (doc) => {
      doc.stopped = false
      if (doc.task && ['stopped', 'paused_by_user'].includes(doc.task.status))
        doc.task.status = 'active'
    })
    await wake(
      host,
      args.conversation,
      'The user resumed computer use; continue from a fresh observe.',
    )
    return readSession(host, args.conversation)
  }),
  takeover: implementAction(TakeoverAction, async (args, { host }) => {
    validate(args, true)
    await updateSession(host, args.conversation, (doc) => {
      doc.takeovers.push({ app: args.app, at: Date.now() })
    })
    await wake(
      host,
      args.conversation,
      `The user granted foreground takeover of ${args.app}; continue from a fresh observe.`,
    )
    return readSession(host, args.conversation)
  }),
  release: implementAction(ReleaseAction, async (args, { host }) => {
    validate(args, true)
    await updateSession(host, args.conversation, (doc) => {
      doc.takeovers = doc.takeovers.filter((t) => t.app.toLowerCase() !== args.app.toLowerCase())
      if (doc.task)
        doc.task = task.markInterrupted(plainTask(doc.task), 'takeover', [args.app], Date.now())
    })
    return readSession(host, args.conversation)
  }),
}
export const userActions = [
  'confirmTask',
  'confirmChange',
  'grant',
  'deny',
  'confirm',
  'stop',
  'hardStop',
  'resume',
  'takeover',
  'release',
]
