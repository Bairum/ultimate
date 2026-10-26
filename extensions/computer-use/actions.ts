import type { ExtensionHost } from '../../server/extensions.ts'
import {
  TeachStartAction,
  TeachStopAction,
  TeachPauseAction,
  TeachResumeAction,
  TeachEditAction,
  TeachSaveAction,
  TeachRejectAction,
  TeachReopenAction,
  TeachWindowsAction,
} from './refs.ts'
import type { TeachStart } from './refs.ts'
import {
  startTeaching,
  finishTeaching,
  resumeTeaching,
  editTeaching,
  saveTeaching,
  rejectTeaching,
  pickableWindows,
} from './teach.ts'
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
import { plainTask, activatePending } from './tool-helpers.ts'
import { runtime } from './runtime.ts'
import { stopDriver } from './driver.ts'
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
  const previous = await readSession(host, 1)
  const affected = new Set([conversation, ...state.calls.values(), ...state.active.keys()])
  for (const abort of state.calls.keys()) abort.abort()
  for (const active of state.active.values()) {
    active.stopped = true
    active.abort?.abort()
    if (active.inFlight && !previous.stopped) {
      active.timer = setTimeout(() => {
        if (active.inFlight || active.uncertain)
          void hardStop(host).catch((error) => console.error('computer-use: stop failed:', error))
      }, 1000)
      active.timer.unref()
    }
  }
  await updateSession(host, 1, (doc) => {
    doc.stopped = true
    doc.confirmed = []
  })
  for (const id of new Set([...host.conversations().map((c) => c.id), ...affected]))
    await interrupt(host, id, affected.has(id))
  state.observations.clear()
  state.zoomed.clear()
  await Promise.all(host.conversations().map(({ id }) => finishTeaching(host, id)))
  if (previous.stopped) await hardStop(host)
  return readSession(host, conversation)
}
export async function hardStop(host: ExtensionHost) {
  const state = runtime(host)
  const affected = new Set([...state.calls.values(), ...state.active.keys()])
  for (const abort of state.calls.keys()) abort.abort()
  const updates: Promise<void>[] = [
    updateSession(host, 1, (doc) => {
      doc.stopped = true
      doc.confirmed = []
    }),
    ...[...new Set([...host.conversations().map((c) => c.id), ...affected])].map((id) =>
      interrupt(host, id, affected.has(id)),
    ),
  ]
  clearTimeout(state.idle)
  for (const active of state.active.values()) {
    active.stopped = true
    active.abort?.abort()
    clearTimeout(active.timer)
  }
  state.observations.clear()
  state.zoomed.clear()
  // Kill concurrently with durable updates: disk latency must not delay the emergency stop.
  await Promise.all([
    ...updates,
    ...host.conversations().map(({ id }) => finishTeaching(host, id)),
    (async () => {
      if (state.driver) await (await state.driver).stop()
      else await stopDriver()
    })(),
  ])
  return { stopped: true as const }
}

async function interrupt(host: ExtensionHost, conversation: number, markStopped: boolean) {
  await updateSession(host, conversation, (doc) => {
    if (markStopped) doc.stopped = true
    if (doc.task) doc.task.runTakeover = false
    doc.confirmed = []
    doc.pending = doc.pending.filter((p) => p.kind !== 'confirm')
    if (markStopped && doc.task)
      doc.task = task.markInterrupted(plainTask(doc.task), 'stop', [], Date.now())
    doc.takeovers = []
  })
}
export const actions = {
  teachStart: implementAction(TeachStartAction, (args, { host }) => {
    validate(args)
    if (!('windows' in args) && !('app' in args)) throw new Error('app must be nonempty')
    if (
      typeof args.title !== 'string' ||
      (args.window !== undefined &&
        typeof args.window !== 'string' &&
        typeof args.window !== 'number') ||
      (args.windows !== undefined && !Array.isArray(args.windows)) ||
      (args.allow !== undefined && !Array.isArray(args.allow)) ||
      (args.minutes !== undefined && typeof args.minutes !== 'number')
    )
      throw new Error('Invalid teaching arguments')
    // startTeaching validates each picked window and allowed app.
    return startTeaching(host, {
      conversation: args.conversation,
      app: args.app,
      title: args.title,
      window: args.window,
      windows: args.windows as TeachStart['windows'],
      allow: args.allow as TeachStart['allow'],
      minutes: args.minutes,
    })
  }),
  teachWindows: implementAction(TeachWindowsAction, async (args, { host }) => {
    validate(args)
    return { windows: await pickableWindows(host, args.conversation) }
  }),
  teachStop: implementAction(TeachStopAction, (args, { host }) => {
    validate(args)
    return finishTeaching(host, args.conversation)
  }),
  teachPause: implementAction(TeachPauseAction, (args, { host }) => {
    validate(args)
    return finishTeaching(host, args.conversation, true)
  }),
  teachResume: implementAction(TeachResumeAction, (args, { host }) => {
    validate(args)
    return resumeTeaching(host, args.conversation)
  }),
  teachEdit: implementAction(TeachEditAction, (args, { host }) => {
    validate(args)
    return editTeaching(host, args.conversation, args.steps)
  }),
  teachSave: implementAction(TeachSaveAction, (args, { host }) => {
    validate(args)
    if (
      (args.scope !== 'project' && args.scope !== 'personal') ||
      typeof args.name !== 'string' ||
      (args.overwrite !== undefined && typeof args.overwrite !== 'boolean')
    )
      throw new Error('Invalid save arguments')
    return saveTeaching(host, {
      conversation: args.conversation,
      scope: args.scope,
      name: args.name,
      overwrite: args.overwrite,
    })
  }),
  teachReopen: implementAction(TeachReopenAction, async (args, { host, device }) => {
    validate(args)
    if (!device) throw new Error('teachReopen requires a user browser action')
    if ((args.scope !== 'project' && args.scope !== 'personal') || typeof args.name !== 'string')
      throw new Error('Invalid skill destination')
    const { reopenTeaching } = await import('./practice.ts')
    return reopenTeaching(host, {
      conversation: args.conversation,
      scope: args.scope,
      name: args.name,
    })
  }),
  teachReject: implementAction(TeachRejectAction, (args, { host }) => {
    validate(args)
    return rejectTeaching(host, args.conversation)
  }),
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
    const pid = args.pid
    if (
      (args.scope !== 'once' && args.scope !== 'conversation' && args.scope !== 'project') ||
      (args.always !== undefined && typeof args.always !== 'boolean') ||
      (pid !== undefined && (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1))
    )
      throw new Error('Invalid grant scope, always flag or pid')
    const scope = args.scope
    const always = args.always
    await updateSession(host, args.scope === 'project' ? 1 : args.conversation, (doc) => {
      doc.grants.push({
        app: args.app,
        scope,
        ...(always === undefined ? {} : { always }),
        ...(pid === undefined ? {} : { pid }),
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
    if (args.scope !== undefined && args.scope !== 'conversation' && args.scope !== 'project')
      throw new Error('Invalid deny scope')
    await updateSession(host, args.scope === 'project' ? 1 : args.conversation, (doc) => {
      doc.grants.push({
        app: args.app,
        scope: 'deny',
        denyScope: args.scope === 'project' ? 'project' : 'conversation',
        at: Date.now(),
      })
      doc.takeovers = doc.takeovers.filter((t) => t.app.toLowerCase() !== args.app.toLowerCase())
      doc.pending = doc.pending.filter((p) => p.app.toLowerCase() !== args.app.toLowerCase())
    })
    if (args.scope === 'project' && args.conversation !== 1)
      await updateSession(host, args.conversation, (doc) => {
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
      if (
        !doc.task ||
        !doc.pending.some(
          (p) => p.kind === 'confirm' && p.key === key && p.task === doc.task!.spec.id,
        )
      )
        throw new Error('key must name an exact pending confirmation')
      doc.confirmed.push({ key, at: Date.now(), task: doc.task.spec.id })
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
    await updateSession(host, 1, (doc) => {
      doc.stopped = false
    })
    await updateSession(host, args.conversation, (doc) => {
      doc.stopped = false
      doc.budget = { steps: 0, startedAt: 0 }
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
  'teachStart',
  'teachWindows',
  'teachReopen',
  'teachStop',
  'teachPause',
  'teachResume',
  'teachEdit',
  'teachSave',
  'teachReject',
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
