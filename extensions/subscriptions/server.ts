import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { Agent, ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { readSecret, validateName } from '../../lib/secrets.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { BoardApi } from '../board/api.ts'
import {
  CreateAction,
  DeleteAction,
  EscalateAction,
  Escalated,
  Exited,
  Fired,
  ListAction,
  LogAction,
  ScriptAction,
  StartAction,
  Started,
  StopAction,
  SubscribeAction,
  UnsubscribeAction,
} from './refs.ts'
import { exitState, fireText, trimLog } from './types.ts'
import type { Args, Subscription } from './types.ts'

export const Subscriptions = defineDoc<{
  next: number
  subscriptions: Record<string, Subscription>
}>({
  kind: 'ultimate.subscriptions',
  version: 1,
  scope: 'session',
  initial: () => ({ next: 1, subscriptions: {} }),
})
type Effect = { id: string; action: string; previousPid?: number }
const Receipt = defineDoc<{ result?: JsonValue; effect?: Effect }>({
  kind: 'ultimate.subscription-receipt',
  version: 1,
  scope: 'task',
  initial: () => ({}),
})
const owner = {
  ownership: { kind: 'conversation' as const },
  conversationId: ROOT_CONVERSATION_ID,
  background: true,
}
const terminal = {
  status: 'terminal' as const,
  outcome: { status: 'completed' as const, result: null },
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}
function kill(pid: number) {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch (error) {
    // The group may already have exited between the snapshot and the kill.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
function alive(pid?: number) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
type Delivery = {
  sub: Subscription
  event: number | string
  kind: 'writing' | 'fired' | 'failed' | 'escalated'
  text: string
  targets: number[]
}
type Run = {
  child: ChildProcess
  active: boolean
  fires: number
  afterFire: boolean
  queue: Promise<void>
  error?: string
  finished?: boolean
  stopped?: 'stop' | 'restart' | 'shutdown'
}

function backend(host: ExtensionHost) {
  return host.resource('subscriptions.supervisor', () => {
    const runs = new Map<string, Run>()
    let closing = false
    // home is the stable project state directory (~/.ultimate/projects/<name>-<hash>), not a worktree cwd.
    const folder = (id: string) =>
      join(host.userHome, '.ultimate/subscriptions', basename(host.home), id)
    const snapshot = async (id: string) => {
      const sub = (await host.harness().snapshot(Subscriptions, BACKGROUND_CONTEXT))?.subscriptions[
        id
      ]
      if (!sub) throw new Error(`Unknown subscription: ${id}`)
      return sub
    }
    const tail = async (id: string, lines = 50) => {
      if (!Number.isInteger(lines) || lines < 1 || lines > 2000)
        throw new Error('lines must be 1–2000')
      try {
        return (await readFile(join(folder(id), 'output.log'), 'utf8'))
          .trimEnd()
          .split('\n')
          .slice(-lines)
          .join('\n')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      }
    }
    const Deliver = defineTask<Delivery, { phase: 'deliver' }, null>({
      name: 'ultimate.subscription-delivery',
      version: 1,
      initial: () => ({ phase: 'deliver' }),
      phases: {
        deliver: async (task, runtime, ctx) => {
          const { sub, event, kind, text, targets } = task.input
          if (kind === 'writing') await mkdir(join(folder(sub.id), 'state'), { recursive: true })
          const content =
            kind === 'writing'
              ? `You own subscription ${sub.id} "${sub.title}".\nAsk: ${sub.ask}\nMode: ${sub.once ? 'one-shot' : 'recurring'}\nNamed secret environment variables: ${sub.secrets?.join(', ') || 'none'}\nFolder: ${folder(sub.id)}\nExecutable: ${join(folder(sub.id), 'run')}\nPersistent memory: ${join(folder(sub.id), 'state')} ($SUBSCRIPTION_STATE).\nWrite and briefly test run, then use subscription start {id:"${sub.id}"}.`
              : kind === 'failed'
                ? `Subscription ${sub.id} "${sub.title}" failed: ${text}\nInvestigate, fix run, and use subscription start. After 2 failed recovery attempts, or if it cannot work, use subscription escalate with a clear reason.\nLast 50 log lines:\n${await tail(sub.id)}`
                : `Subscription ${sub.id} "${sub.title}" ${kind}: ${text}`
          if (kind === 'escalated')
            await host
              .need(BoardApi)
              .send(
                sub.conversationId,
                { to: '@ultimate', text: content, reply: false },
                `subscriptions:${sub.id}:${event}:ultimate`,
                ctx,
              )
          for (const target of targets) {
            const id = target as ConversationId
            const requestId = `subscriptions:${sub.id}:${event}:${target}`
            const delivered = await host
              .harness()
              .commit((tx) => tx.submissionByRequest(id, requestId), ctx)
            if (delivered) continue
            const conversation = await runtime.conversation(id, ctx)
            if (!conversation)
              throw new Error(`Subscription ${sub.id}: conversation #${id} is missing`)
            await conversation.submit(
              {
                type: 'input',
                content,
                whenBusy: 'followUp',
                requestId,
                entry: {
                  kind: `subscriptions.${kind}`,
                  data: { id: sub.id, title: sub.title, text },
                },
              },
              ctx,
            )
          }
          await runtime.commit(() => terminal, ctx)
        },
      },
      abort: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
    })
    async function deliver(
      tx: Tx,
      sub: Subscription,
      event: number | string,
      kind: Delivery['kind'],
      text: string,
    ) {
      await tx.createTask(
        Deliver,
        {
          sub: json(sub),
          event,
          kind,
          text,
          targets:
            kind === 'writing' || kind === 'failed' ? [sub.conversationId] : [...sub.subscribers],
        },
        owner,
      )
    }
    async function finish(
      id: string,
      run: Run | undefined,
      code: number | null,
      signal?: string,
      error?: string,
    ) {
      if (run?.finished) return
      if (run) {
        run.finished = true
        run.active = false
      }
      if (runs.get(id) === run) runs.delete(id)
      // Release leaves the durable running state intact for the next open; storage is closing.
      if (closing || run?.stopped === 'shutdown') return
      await host.harness().commit(async (tx) => {
        const sub = (await tx.doc(Subscriptions)).subscriptions[id]
        if (!sub) return
        if (run?.stopped) {
          if (!sub.pid) {
            sub.updatedAt = sub.exitedAt = Date.now()
            if (code !== null) sub.exitCode = code
          }
          await host.emit(tx, Exited, { id, code, ...(signal ? { signal } : {}) })
          return
        }
        if (sub.state !== 'running' || (run && sub.pid !== run.child.pid)) return
        sub.state = exitState(
          sub.once,
          run?.fires ?? 0,
          code,
          !!run?.afterFire && signal === 'SIGTERM',
        )
        sub.updatedAt = sub.exitedAt = Date.now()
        if (code !== null) sub.exitCode = code
        delete sub.pid
        const event = await host.emit(tx, Exited, { id, code, ...(signal ? { signal } : {}) })
        if (sub.state === 'done') sub.enabled = false
        else {
          sub.error = error ?? `Process exited with code ${code}${signal ? ` (${signal})` : ''}`
          await deliver(tx, sub, event.id, 'failed', sub.error)
        }
      }, BACKGROUND_CONTEXT)
    }
    async function stopProcess(id: string, reason: Run['stopped'] = 'stop') {
      const run = runs.get(id)
      if (!run) return
      run.stopped = reason
      run.active = false
      runs.delete(id)
      if (run.child.pid) kill(run.child.pid)
      await run.queue
    }
    async function launch(id: string, previousPid?: number) {
      const sub = await snapshot(id)
      if (!sub.enabled || sub.state !== 'running') return
      const current = runs.get(id)
      // A replay of a start receipt (including after onOpen reconciliation) reuses this process.
      if (current?.active && current.child.pid === sub.pid && current.child.pid !== previousPid)
        return
      await stopProcess(id, 'restart')
      if (sub.pid) kill(sub.pid)
      const dir = folder(id)
      await mkdir(join(dir, 'state'), { recursive: true })
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        SUBSCRIPTION_ID: id,
        SUBSCRIPTION_STATE: join(dir, 'state'),
      }
      for (const name of sub.secrets ?? []) {
        const value = await readSecret(host.userHome, name)
        if (!value) throw new Error(`Missing secret ${name}; add it in Secrets (⌘K → Secrets)`)
        env[name] = value
      }
      await access(join(dir, 'run'), constants.X_OK)
      const child = spawn(join(dir, 'run'), [], {
        cwd: dir,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
      const run: Run = { child, active: true, fires: 0, afterFire: false, queue: Promise.resolve() }
      runs.set(id, run)
      // Hold output until the pid and Started event are committed, even for an immediately exiting script.
      run.queue = host.harness().commit(async (tx) => {
        const saved = (await tx.doc(Subscriptions)).subscriptions[id]
        if (!saved || !saved.enabled || saved.state !== 'running') {
          run.active = false
          if (child.pid) kill(child.pid)
          return
        }
        delete saved.pid
        if (child.pid) {
          saved.pid = child.pid
          saved.startedAt = saved.updatedAt = Date.now()
          delete saved.exitedAt
          delete saved.exitCode
          delete saved.error
          await host.emit(tx, Started, { id, pid: child.pid })
        }
      }, BACKGROUND_CONTEXT)
      function enqueue(work: () => Promise<void>) {
        run.queue = run.queue
          .then(work)
          .catch(async (error: unknown) => {
            host.notice(`Subscription ${id}: ${String(error)}`)
            if (child.pid) kill(child.pid)
            await finish(id, run, null, undefined, String(error))
          })
          .catch((error: unknown) => {
            // If storage itself failed, no durable recovery can be scheduled; retain a loud host diagnostic.
            host.notice(`Subscription ${id} recovery could not be recorded: ${String(error)}`)
          })
      }
      async function line(text: string, stdout: boolean) {
        if (!run.active) return
        const path = join(dir, 'output.log')
        await appendFile(path, `${text}\n`)
        const output = await readFile(path, 'utf8')
        const trimmed = trimLog(output)
        if (trimmed !== output) await writeFile(path, trimmed)
        const fire = fireText(text, stdout)
        await host.harness().commit(async (tx) => {
          const saved = (await tx.doc(Subscriptions)).subscriptions[id]
          if (!saved || saved.pid !== child.pid || saved.state !== 'running') return
          saved.lastOutputAt = saved.updatedAt = Date.now()
          if (fire === undefined || run.afterFire) return
          saved.lastFireAt = Date.now()
          saved.fires++
          run.fires++
          const event = await host.emit(tx, Fired, { id, text: fire, fire: saved.fires })
          await deliver(tx, saved, event.id, 'fired', fire)
          if (saved.once) run.afterFire = true
        }, BACKGROUND_CONTEXT)
        if (run.afterFire && child.pid) kill(child.pid)
      }
      for (const [stream, stdout] of [
        [child.stdout, true],
        [child.stderr, false],
      ] as const) {
        let pending = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          pending += chunk
          let index: number
          while ((index = pending.indexOf('\n')) !== -1) {
            const text = pending.slice(0, index).replace(/\r$/, '')
            pending = pending.slice(index + 1)
            enqueue(() => line(text, stdout))
          }
          // Bound memory for scripts that produce output without newlines; only a complete line can FIRE.
          if (Buffer.byteLength(pending) > 256 * 1024) {
            const text = pending
            pending = ''
            enqueue(() => line(text, false))
          }
        })
        stream.on('end', () => {
          if (pending) enqueue(() => line(pending, stdout))
        })
      }
      child.on('error', (error) => {
        run.error = error.message
      })
      child.on('close', (code, signal) =>
        enqueue(() => finish(id, run, code, signal ?? undefined, run.error)),
      )
      await run.queue
    }
    async function effect(value: Effect) {
      if (value.action === 'start') {
        try {
          await launch(value.id, value.previousPid)
        } catch (error) {
          await finish(value.id, undefined, null, undefined, String(error))
          throw error
        }
      } else await stopProcess(value.id)
    }
    async function prepare(args: Args, caller?: number) {
      const valid = [
        'create',
        'list',
        'subscribe',
        'unsubscribe',
        'start',
        'stop',
        'log',
        'escalate',
        'delete',
      ]
      if (!valid.includes(args.action)) throw new Error(`Unknown action: ${args.action}`)
      if (args.action === 'create') {
        required(args.ask, 'ask')
        if (args.title !== undefined) required(args.title, 'title')
        if (args.once !== undefined && typeof args.once !== 'boolean')
          throw new Error('once must be boolean')
        if (
          args.secrets !== undefined &&
          (!Array.isArray(args.secrets) || args.secrets.some((s) => typeof s !== 'string'))
        )
          throw new Error('secrets must be names')
        args.secrets?.forEach(validateName)
        if (
          args.subscribers !== undefined &&
          (!Array.isArray(args.subscribers) ||
            args.subscribers.some((s) => !Number.isInteger(s) || s < 1))
        )
          throw new Error('subscribers must be conversation ids')
        if (!caller) throw new Error('create requires a caller conversation')
        for (const id of args.subscribers ?? [])
          if (!(await host.harness().conversation(id as ConversationId, BACKGROUND_CONTEXT)))
            throw new Error(`Unknown subscriber #${id}`)
        const profile = (
          await discoverAgents(
            host.ultimateRoot,
            host.projectRoot,
            host.userHome,
            host.modelRuntime,
          )
        ).definitions.find((d) => d.name === 'subscription')
        if (!profile) throw new Error('Missing subscription agent definition')
        const conversation = await host
          .harness()
          .conversation(caller as ConversationId, BACKGROUND_CONTEXT)
        if (!conversation) throw new Error(`Unknown caller #${caller}`)
        return { profile, parent: await conversation.agent(BACKGROUND_CONTEXT) }
      }
      if (args.action === 'list') return {}
      const id = required(args.id, 'id')
      if (!/^S[1-9]\d*$/.test(id)) throw new Error('id must be S<n>')
      await snapshot(id)
      if (args.action === 'start') {
        try {
          await access(join(folder(id), 'run'), constants.X_OK)
        } catch {
          throw new Error(
            `Missing or non-executable ${join(folder(id), 'run')}; write it and chmod +x it first`,
          )
        }
      }
      if (args.action === 'escalate') required(args.reason, 'reason')
      if (args.action === 'subscribe' || args.action === 'unsubscribe') {
        let target = caller
        if (args.to !== undefined) {
          if (typeof args.to !== 'string') throw new Error('to must be #id or @name')
          if (args.to.startsWith('@'))
            target = await host.need(SubagentsApi).standing(args.to.slice(1), BACKGROUND_CONTEXT)
          else if (/^#[1-9]\d*$/.test(args.to)) target = Number(args.to.slice(1))
          else throw new Error('to must be #id or @name')
        }
        if (
          !target ||
          !(await host.harness().conversation(target as ConversationId, BACKGROUND_CONTEXT))
        )
          throw new Error('Subscriber conversation is missing')
        return { target }
      }
      return {}
    }
    async function change(
      tx: Tx,
      args: Args,
      prepared: Awaited<ReturnType<typeof prepare>>,
      caller?: number,
    ): Promise<{ result: JsonValue; effect?: Effect }> {
      const state = await tx.doc(Subscriptions)
      if (args.action === 'list')
        return {
          result: Object.values(state.subscriptions).map((s) => ({ ...s, alive: alive(s.pid) })),
        }
      if (args.action === 'create') {
        const id = `S${state.next++}`
        const child = await host.need(SubagentsApi).createChild(tx, {
          owner: { kind: 'ownerless' },
          definition: prepared.profile,
          parentAgent: prepared.parent as Agent,
          modelRuntime: host.modelRuntime,
          metadata: host.metadata,
          label: 'subscription',
          title: `${id} · ${args.title?.trim() ?? required(args.ask, 'ask').slice(0, 80)}`,
          cwd: (await tx.doc(AgentDoc, caller as ConversationId)).cwd ?? host.projectRoot,
        })
        const now = Date.now()
        const sub: Subscription = {
          id,
          title: args.title?.trim() ?? required(args.ask, 'ask').slice(0, 80),
          ask: required(args.ask, 'ask'),
          once: args.once ?? true,
          enabled: true,
          conversationId: child.id,
          subscribers: [...new Set([caller!, ...(args.subscribers ?? [])])],
          ...(args.secrets ? { secrets: args.secrets } : {}),
          createdAt: now,
          updatedAt: now,
          state: 'writing',
          fires: 0,
        }
        state.subscriptions[id] = sub
        await deliver(tx, sub, 'create', 'writing', sub.ask)
        return { result: sub }
      }
      const id = required(args.id, 'id')
      const sub = state.subscriptions[id]
      if (!sub) throw new Error(`Unknown subscription: ${id}`)
      if (args.action === 'log') return { result: { text: await tail(id, args.lines) } }
      sub.updatedAt = Date.now()
      if (args.action === 'subscribe')
        sub.subscribers = [...new Set([...sub.subscribers, prepared.target!])]
      else if (args.action === 'unsubscribe')
        sub.subscribers = sub.subscribers.filter((s) => s !== prepared.target)
      else if (args.action === 'start') {
        sub.enabled = true
        sub.state = 'running'
        // Retain the old pid until launch so onOpen can sweep it if the process dies before the effect.
        delete sub.error
        return {
          result: sub,
          effect: { id, action: 'start', ...(sub.pid ? { previousPid: sub.pid } : {}) },
        }
      } else if (args.action === 'stop' || args.action === 'delete' || args.action === 'escalate') {
        sub.enabled = false
        sub.state = args.action === 'escalate' ? 'failed' : 'stopped'
        const pid = sub.pid
        delete sub.pid
        if (args.action === 'escalate') {
          sub.error = required(args.reason, 'reason')
          const event = await host.emit(tx, Escalated, { id, reason: sub.error })
          await deliver(tx, sub, event.id, 'escalated', sub.error)
        }
        if (args.action === 'delete') delete state.subscriptions[id]
        // Stop sweeps a recorded pid too, even when no process-local handle survived a crash.
        return {
          result: args.action === 'delete' ? { id } : sub,
          effect: { id, action: pid ? `stop:${pid}` : 'stop' },
        }
      }
      return { result: sub }
    }
    const effects = new Map<string, Promise<void>>()
    async function apply(value?: Effect) {
      if (!value) return
      const previous = effects.get(value.id) ?? Promise.resolve()
      const work = previous.then(async () => {
        if (value.action.startsWith('stop:')) kill(Number(value.action.slice(5)))
        await effect(value)
      })
      // A failed start has already become an investigating subscription; it must not block its repair.
      const settled = work.catch(() => {})
      effects.set(value.id, settled)
      try {
        await work
      } finally {
        if (effects.get(value.id) === settled) effects.delete(value.id)
      }
    }
    async function operate(args: Args, caller?: number) {
      const prepared = await prepare(args, caller)
      const receipt = await host
        .harness()
        .commit(async (tx) => json(await change(tx, args, prepared, caller)), BACKGROUND_CONTEXT)
      await apply(receipt.effect)
      if (args.action === 'start') return json(await snapshot(required(args.id, 'id')))
      return receipt.result
    }
    const close = async () => {
      closing = true
      for (const id of runs.keys()) await stopProcess(id, 'shutdown')
    }
    const open = async () => {
      closing = false
      const state = await host.harness().snapshot(Subscriptions, BACKGROUND_CONTEXT)
      for (const sub of Object.values(state?.subscriptions ?? {})) {
        if (sub.state !== 'running' || !sub.enabled) continue
        try {
          await launch(sub.id)
        } catch (error) {
          host.notice(`Subscription ${sub.id}: ${String(error)}`)
          await finish(sub.id, undefined, null, undefined, String(error))
        }
      }
    }
    return { Deliver, operate, prepare, change, apply, open, close }
  })
}

function input(args: unknown, action: string): Args {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Expected an object')
  return { ...(args as Omit<Args, 'action'>), action }
}
export const actions = {
  create: implementAction(
    CreateAction,
    (args, { host, conversationId }) =>
      backend(host).operate(input(args, 'create'), conversationId) as Promise<Subscription>,
  ),
  list: implementAction(
    ListAction,
    (_args, { host }) =>
      backend(host).operate({ action: 'list' }) as Promise<(Subscription & { alive: boolean })[]>,
  ),
  subscribe: implementAction(
    SubscribeAction,
    (args, { host, conversationId }) =>
      backend(host).operate(input(args, 'subscribe'), conversationId) as Promise<Subscription>,
  ),
  unsubscribe: implementAction(
    UnsubscribeAction,
    (args, { host, conversationId }) =>
      backend(host).operate(input(args, 'unsubscribe'), conversationId) as Promise<Subscription>,
  ),
  start: implementAction(
    StartAction,
    (args, { host }) => backend(host).operate(input(args, 'start')) as Promise<Subscription>,
  ),
  stop: implementAction(
    StopAction,
    (args, { host }) => backend(host).operate(input(args, 'stop')) as Promise<Subscription>,
  ),
  log: implementAction(
    LogAction,
    (args, { host }) => backend(host).operate(input(args, 'log')) as Promise<{ text: string }>,
  ),
  // Outside the reload-stable supervisor: a read needs no process state, and stays current on reload.
  script: implementAction(ScriptAction, async (args, { host }) => {
    const id = input(args, 'script').id
    if (typeof id !== 'string' || !/^S[1-9]\d*$/.test(id)) throw new Error('id must be S<n>')
    const state = await host.harness().snapshot(Subscriptions, BACKGROUND_CONTEXT)
    if (!state?.subscriptions[id]) throw new Error(`Unknown subscription: ${id}`)
    const path = join(host.userHome, '.ultimate/subscriptions', basename(host.home), id, 'run')
    try {
      const text = await readFile(path, 'utf8')
      return { path, text: text.length > 65536 ? `${text.slice(0, 65536)}\n…` : text }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: '' }
      throw error
    }
  }),
  escalate: implementAction(
    EscalateAction,
    (args, { host }) => backend(host).operate(input(args, 'escalate')) as Promise<Subscription>,
  ),
  delete: implementAction(
    DeleteAction,
    (args, { host }) => backend(host).operate(input(args, 'delete')) as Promise<{ id: string }>,
  ),
}
/** The Subscriptions surface polls these every 2 s while it is on screen. */
export const pollActions = ['list', 'log', 'script']
export default function subscriptions(host: ExtensionHost) {
  host.need(SubagentsApi)
  host.need(BoardApi)
  const api = backend(host)
  host.onOpen(api.open)
  host.onRelease(api.close)
  host.onClose(api.close)
  return defineExtension({
    name: 'subscriptions',
    tasks: [api.Deliver],
    tools: [
      defineTool({
        name: 'subscription',
        // Transactional receipts deduplicate mutations; start reuses its committed live pid on replay.
        replay: 'safe',
        description:
          'Subscribe conversations to background conditions. create {ask,title?,once?,secrets?,subscribers?} starts an agent that writes a cheap script; returns immediately. list; subscribe/unsubscribe {id,to?: "#id"|"@name"} (default caller); start/stop/delete {id}; log {id,lines?}; escalate {id,reason}. IDs are S<n>. Failures wake only the subscription agent; escalation notifies subscribers and @ultimate. Files and conversation survive delete.',
        parameters: Type.Object({
          action: Type.Union(
            [
              'create',
              'list',
              'subscribe',
              'unsubscribe',
              'start',
              'stop',
              'log',
              'escalate',
              'delete',
            ].map((s) => Type.Literal(s)),
          ),
          id: Type.Optional(Type.String()),
          ask: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          once: Type.Optional(Type.Boolean()),
          secrets: Type.Optional(Type.Array(Type.String())),
          subscribers: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
          to: Type.Optional(Type.String()),
          lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
          reason: Type.Optional(Type.String()),
        }),
        execute: async (args, tool, context) => {
          const cached = await tool.memo<{ output: { type: 'text'; text: string }[] }>(
            'result',
            context,
          )
          if (cached) return cached
          const saved = await tool.commit(
            async (tx) => json(await tx.doc(Receipt, tool.taskId)),
            context,
          )
          let receipt = saved
          if (saved.result === undefined) {
            const prepared = await api.prepare(args, tool.conversationId)
            receipt = await tool.commit(async (tx) => {
              const value = await tx.doc(Receipt, tool.taskId)
              if (value.result === undefined)
                Object.assign(value, await api.change(tx, args, prepared, tool.conversationId))
              return json(value)
            }, context)
          }
          await api.apply(receipt.effect)
          return tool.memo(
            'result',
            { output: [{ type: 'text' as const, text: concise(receipt.result!) }] },
            context,
          )
        },
      }),
    ],
  })
}
function concise(value: JsonValue): string {
  if (Array.isArray(value)) return value.length ? value.map(concise).join('\n') : 'None.'
  if (value && typeof value === 'object' && 'state' in value) {
    const sub = value as Subscription
    const up = sub.startedAt
      ? ` up ${Math.max(0, Math.floor((Date.now() - sub.startedAt) / 60000))}m`
      : ''
    return `${sub.id} ${sub.state} "${sub.title}"${sub.pid ? ` pid ${sub.pid}${up}` : ''} · fired ${sub.fires} · #${sub.conversationId} · subscribers ${sub.subscribers.map((id) => `#${id}`).join(' ')}`
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  return JSON.stringify(value)
}
