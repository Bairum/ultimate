import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { access, appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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
import type { AgentDefinition } from '../../lib/agents.ts'
import {
  closeOutput,
  groupAlive,
  readPidFile,
  spawnGroup,
  stopGroup,
} from '../../lib/process-group.ts'
import type { Group, GroupProcess } from '../../lib/process-group.ts'
import { readSecret, validateName } from '../../lib/secrets.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { MessagesApi } from '../messages/api.ts'
import { SubscriptionsApi } from './api.ts'
import {
  CreateAction,
  DeleteAction,
  Done,
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
import { doneText, fireText, isId, isSlug, trimLog } from './types.ts'
import { writeJson } from '../../lib/json-file.ts'
import type { Args, Manifest, Subscription, SubscriptionListItem } from './types.ts'

export const Subscriptions = defineDoc<{
  next: number
  subscriptions: Record<string, Subscription>
}>({
  kind: 'ultimate.subscriptions',
  checkpointWhen: () => false,
  version: 1,
  scope: 'session',
  initial: () => ({ next: 1, subscriptions: {} }),
})
type Effect = { id: string; action: string; previousPid?: number }
const Receipt = defineDoc<{ result?: JsonValue; effect?: Effect }>({
  kind: 'ultimate.subscription-receipt',
  checkpointWhen: () => false,
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
export { handshake as launchHandshake } from '../../lib/process-group.ts'
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}
function validId(value: unknown): string {
  const id = required(value, 'id')
  if (!isId(id)) throw new Error('id must be S<n> or a project subscription slug')
  return id
}
const MANIFEST = 'subscription.json'
/** A project record discovery made and nobody has used yet: never started, no subscribers or fires. */
const pristine = (sub: Subscription) =>
  sub.scope === 'project' &&
  sub.state === 'stopped' &&
  !sub.startedAt &&
  !sub.fires &&
  !sub.subscribers.length
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
/** A project subscription's committed manifest, or undefined when the file is missing or malformed. */
function manifest(value: unknown): Manifest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { title, ask, once, secrets } = value as Record<string, unknown>
  if (typeof ask !== 'string' || !ask.trim()) return undefined
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) return undefined
  if (once !== undefined && typeof once !== 'boolean') return undefined
  if (
    secrets !== undefined &&
    (!Array.isArray(secrets) || secrets.some((s) => typeof s !== 'string'))
  )
    return undefined
  return {
    title: title?.trim() ?? ask.trim().slice(0, 80),
    ask: ask.trim(),
    once: once ?? true,
    ...(secrets?.length ? { secrets: secrets as string[] } : {}),
  }
}
type Delivery = {
  sub: Subscription
  event: number | string
  kind: 'writing' | 'fired' | 'failed' | 'escalated'
  text: string
  targets: number[]
}
/** What an action validated before its transaction: the agent to create, a project slug, a subscriber. */
type Prepared = {
  profile?: AgentDefinition
  parent?: Agent
  slug?: string
  target?: number
}
type Run = {
  child: GroupProcess
  group: Group
  active: boolean
  afterFire: boolean
  /** The text of a `DONE` line; an exit 0 after it stops the subscription cleanly. */
  done?: string
  queue: Promise<void>
  cleanup?: Promise<void>
  error?: string
  finished?: boolean
  stopped?: 'stop' | 'restart' | 'shutdown'
}

function backend(host: ExtensionHost) {
  return host.resource('subscriptions.supervisor', () => {
    const runs = new Map<string, Run>()
    const launches = new Set<Promise<void>>()
    let closing = false
    // home is the stable project state directory (~/.ultimate/projects/<name>-<hash>), not a worktree cwd.
    const folder = (id: string) =>
      join(host.userHome, '.ultimate/subscriptions', basename(host.home), id)
    // A project subscription's `run` and manifest are committed in the host checkout; its runtime stays in folder().
    const projectDir = (id: string) => join(host.projectRoot, '.ultimate/subscriptions', id)
    const runPath = (sub: Pick<Subscription, 'id' | 'scope'>) =>
      join(sub.scope === 'project' ? projectDir(sub.id) : folder(sub.id), 'run')
    const trusted = async () => (await host.projectSetup()).decision === true
    /** Manifests under `<project>/.ultimate/subscriptions/<slug>/`, only in a project chosen as local. */
    async function manifests() {
      const found = new Map<string, Manifest>()
      if (!(await trusted())) return found
      let entries: Dirent[]
      try {
        entries = await readdir(join(host.projectRoot, '.ultimate/subscriptions'), {
          withFileTypes: true,
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found
        throw error
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !isSlug(entry.name)) continue
        let text: string
        try {
          text = await readFile(join(projectDir(entry.name), MANIFEST), 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        let parsed: Manifest | undefined
        try {
          parsed = manifest(JSON.parse(text))
          parsed?.secrets?.forEach(validateName)
        } catch {
          // Malformed JSON or a bad secret name is reported below like any other invalid manifest.
          parsed = undefined
        }
        if (parsed) found.set(entry.name, parsed)
        else host.notice(`Subscription ${entry.name}: invalid ${MANIFEST}`)
      }
      return found
    }
    /**
     * Bring project records in line with the committed manifests: a new folder becomes a stopped subscription that
     * never starts by itself, a changed manifest updates its fields, and a removed folder (or an untrusted project)
     * stops and forgets its record. Commits only when something changed.
     */
    async function discover() {
      const found = await manifests()
      // A slug whose create is in flight belongs to that create: discovery neither adds nor forgets it.
      for (const slug of creating) found.delete(slug)
      const gone = (s: Subscription) =>
        s.scope === 'project' && !found.has(s.id) && !creating.has(s.id)
      const differs = (subs: Record<string, Subscription>) =>
        [...found].some(([id, m]) => {
          const sub = subs[id]
          return (
            !sub ||
            (sub.scope === 'project' &&
              JSON.stringify([sub.title, sub.ask, sub.once, sub.secrets]) !==
                JSON.stringify([m.title, m.ask, m.once, m.secrets]))
          )
        }) || Object.values(subs).some(gone)
      const current =
        (await host.harness().snapshot(Subscriptions, BACKGROUND_CONTEXT))?.subscriptions ?? {}
      if (!differs(current)) return
      // A new subscription gets its idle agent conversation now, so every record has one.
      const prepared = [...found.keys()].some((id) => !current[id]) ? await agentFor() : undefined
      const trust = await trusted()
      const removed = await host.harness().commit(async (tx) => {
        const state = await tx.doc(Subscriptions)
        const stops: Effect[] = []
        const now = Date.now()
        for (const [id, m] of found) {
          if (creating.has(id)) continue
          const sub = state.subscriptions[id]
          if (!sub && prepared)
            state.subscriptions[id] = {
              id,
              scope: 'project',
              ...m,
              enabled: false,
              conversationId: await agentConversation(tx, prepared, id, m.title, host.projectRoot),
              subscribers: [],
              createdAt: now,
              updatedAt: now,
              state: 'stopped',
              fires: 0,
            }
          else if (sub?.scope === 'project') {
            delete sub.secrets
            Object.assign(sub, m, { updatedAt: now })
          }
        }
        for (const sub of Object.values(state.subscriptions)) {
          if (!gone(sub)) continue
          // The scan may predate a create that has since published its manifest: forget only what is still gone.
          if (trust && (await exists(join(projectDir(sub.id), MANIFEST)))) continue
          delete state.subscriptions[sub.id]
          stops.push({ id: sub.id, action: 'stop', ...(sub.pid ? { previousPid: sub.pid } : {}) })
        }
        return stops
      }, BACKGROUND_CONTEXT)
      for (const stop of removed) await apply(stop)
    }
    /** Project slugs whose create runs between publishing the manifest and committing the record. */
    const creating = new Set<string>()
    /** Create, inside `tx`, the ownerless conversation of subscription `id`'s agent. */
    async function agentConversation(
      tx: Tx,
      prepared: Prepared,
      id: string,
      title: string,
      cwd: string,
    ) {
      const child = await host.need(SubagentsApi).createChild(tx, {
        owner: { kind: 'ownerless' },
        definition: prepared.profile,
        parentAgent: prepared.parent!,
        modelRuntime: host.modelRuntime,
        metadata: host.metadata,
        label: 'subscription',
        title: `${id} · ${title}`,
        cwd,
      })
      return child.id
    }
    /** The agent a new subscription conversation is configured from, and whose model and tools it copies: the caller, else @ultimate. */
    async function agentFor(caller?: number): Promise<Prepared> {
      const profile = (
        await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
      ).definitions.find((d) => d.name === 'subscription')
      if (!profile) throw new Error('Missing subscription agent definition')
      const parentId =
        caller ?? (await host.need(SubagentsApi).standing('ultimate', BACKGROUND_CONTEXT))
      const conversation = await host
        .harness()
        .conversation(parentId as ConversationId, BACKGROUND_CONTEXT)
      if (!conversation) throw new Error(`Unknown caller #${parentId}`)
      return { profile, parent: await conversation.agent(BACKGROUND_CONTEXT) }
    }
    /** What a subscription agent is told about its subscription, at creation and on each failure. */
    const brief = (sub: Subscription) =>
      [
        `You own subscription ${sub.id} "${sub.title}".`,
        `Ask: ${sub.ask}`,
        `Mode: ${sub.once ? 'one-shot' : 'recurring'}`,
        `Named secret environment variables: ${sub.secrets?.join(', ') || 'none'}`,
        `Executable: ${runPath(sub)}`,
        `Persistent memory: ${join(folder(sub.id), 'state')} ($SUBSCRIPTION_STATE).`,
        ...(sub.scope === 'project'
          ? [
              `This is a project subscription: run and ${MANIFEST} are committed in ${projectDir(sub.id)}, and run starts in ${host.projectRoot}. After you change run, say that the change is uncommitted in the project checkout.`,
            ]
          : []),
      ].join('\n')
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
              ? `${brief(sub)}\nWrite and briefly test run, then use subscription start {id:"${sub.id}"}.`
              : kind === 'failed'
                ? `Subscription ${sub.id} "${sub.title}" failed: ${text}\nInvestigate, fix run, and use subscription start. After 2 failed recovery attempts, or if it cannot work, use subscription escalate with a clear reason.\n${sub.scope === 'project' ? `${brief(sub)}\n` : ''}Last 50 log lines:\n${await tail(sub.id)}`
                : `Subscription ${sub.id} "${sub.title}" ${kind}: ${text}`
          if (kind === 'escalated')
            await host
              .need(MessagesApi)
              .send(
                sub.conversationId,
                { to: '@ultimate', text: content, reply: false },
                `subscriptions:${sub.id}:${event}:ultimate`,
                ctx,
              )
          for (const target of targets) {
            const id = target as ConversationId
            const requestId = `subscriptions:${sub.id}:${event}:${target}`
            const conversation = await runtime.conversation(id, ctx)
            if (!conversation)
              throw new Error(`Subscription ${sub.id}: conversation #${id} is missing`)
            // Pi admits requestId in the submission transaction, including queued follow-ups.
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
    const readPid = (id: string) => readPidFile(join(folder(id), 'pid'))
    function cleanup(id: string, pid: number, run?: Run): Promise<void> {
      if (run?.cleanup) return run.cleanup
      const work = (async () => {
        // The pid file stays until the whole group is confirmed gone, and never names a replacement when removed.
        // A run's own group is identified by its unreaped leader, a crashed host's by its pid file.
        await stopGroup(pid, { pidFile: join(folder(id), 'pid'), leader: run?.group }).catch(
          (error: unknown) => {
            throw new Error(`Subscription ${id}: ${String(error)}`)
          },
        )
        if (run) await closeOutput(run.group)
        if (runs.get(id) === run) runs.delete(id)
      })()
      if (!run) return work
      run.cleanup = work.catch((error: unknown) => {
        // Keep the pid file and allow a later close/open to retry cleanup after a failed kill.
        delete run.cleanup
        throw error
      })
      return run.cleanup
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
      if (run?.child.pid) await cleanup(id, run.child.pid, run)
      else if (run && runs.get(id) === run) runs.delete(id)
      if (closing && !run) return
      await host.harness().commit(async (tx) => {
        const sub = (await tx.doc(Subscriptions)).subscriptions[id]
        if (!sub || (run && sub.pid !== run.child.pid)) return
        const done = sub.once && sub.state === 'done'
        const stopped = !!run?.stopped || closing
        if (!stopped && sub.state !== 'running' && !done) return
        // A recurring script that printed DONE and exited 0 asked to stop: the same state as `stop`, with nobody woken.
        const said = run?.done
        const finished = !sub.once && !stopped && !done && said !== undefined && code === 0
        // A fired one-shot is already done in its FIRE commit, so any other unplanned exit is a failure.
        // Shutdown keeps running subscriptions enabled for reopen.
        if (finished) {
          sub.state = 'stopped'
          sub.enabled = false
        } else if (!stopped && !done) sub.state = 'investigating'
        sub.updatedAt = sub.exitedAt = Date.now()
        if (code !== null) sub.exitCode = code
        delete sub.pid
        const event = await host.emit(tx, Exited, { id, code, ...(signal ? { signal } : {}) })
        if (finished) await host.emit(tx, Done, { id, ...(said ? { text: said } : {}) })
        else if (sub.state === 'done') sub.enabled = false
        else if (!stopped) {
          sub.error = error ?? `Process exited with code ${code}${signal ? ` (${signal})` : ''}`
          await deliver(tx, sub, event.id, 'failed', sub.error)
        }
      }, BACKGROUND_CONTEXT)
    }
    async function stopProcess(id: string, pid?: number, reason: Run['stopped'] = 'stop') {
      // Receipts target the process present at mutation time, never a later start.
      if (!pid) return
      const run = runs.get(id)
      if (run && run.child.pid !== pid) return
      if (run) {
        run.stopped = reason
        run.active = false
        await cleanup(id, pid, run)
        await run.queue
      } else if ((await readPid(id)) === pid) await cleanup(id, pid)
    }
    async function launch(id: string, previousPid?: number) {
      const work = launchRun(id, previousPid)
      launches.add(work)
      try {
        await work
      } finally {
        launches.delete(work)
      }
    }
    async function launchRun(id: string, previousPid?: number) {
      if (closing) throw new Error('Subscription supervisor is closing')
      const sub = await snapshot(id)
      if (!sub.enabled || sub.state !== 'running') return
      const current = runs.get(id)
      // A replay of a start receipt (including after onOpen reconciliation) reuses this process.
      if (current?.active && current.child.pid === sub.pid && current.child.pid !== previousPid)
        return
      await stopProcess(id, current?.child.pid, 'restart')
      const recorded = await readPid(id)
      if (recorded) await cleanup(id, recorded)
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
      await access(runPath(sub), constants.X_OK)
      if (closing) throw new Error('Subscription supervisor is closing')
      let group: Group
      try {
        // The script waits behind the handshake until its pid file is written.
        group = spawnGroup(runPath(sub), [], {
          cwd: sub.scope === 'project' ? host.projectRoot : dir,
          env,
          pidFile: join(dir, 'pid'),
        })
      } catch (error) {
        throw new Error(`Subscription ${id}: could not record its pid: ${String(error)}`, {
          cause: error,
        })
      }
      const { child } = group
      const run: Run = {
        child,
        group,
        active: true,
        afterFire: false,
        queue: Promise.resolve(),
      }
      runs.set(id, run)
      child.on('error', (error) => {
        run.error = error.message
      })
      child.on('close', (code, signal) => {
        enqueue(() => finish(id, run, code, signal ?? undefined, run.error))
      })
      // Hold output until the pid and Started event are committed, even for an immediately exiting script.
      run.queue = host.harness().commit(async (tx) => {
        const saved = (await tx.doc(Subscriptions)).subscriptions[id]
        if (!saved || !saved.enabled || saved.state !== 'running') {
          run.active = false
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
        const done = doneText(text, stdout)
        if (done !== undefined) run.done = done
        await host.harness().commit(async (tx) => {
          const saved = (await tx.doc(Subscriptions)).subscriptions[id]
          if (!saved || saved.pid !== child.pid || saved.state !== 'running') return
          saved.lastOutputAt = saved.updatedAt = Date.now()
          if (fire === undefined || run.afterFire) return
          saved.lastFireAt = Date.now()
          saved.fires++
          const event = await host.emit(tx, Fired, { id, text: fire, fire: saved.fires })
          if (saved.once) {
            saved.state = 'done'
            saved.enabled = false
            run.afterFire = true
          }
          await deliver(tx, saved, event.id, 'fired', fire)
        }, BACKGROUND_CONTEXT)
        if (run.afterFire && child.pid) {
          run.active = false
          await cleanup(id, child.pid, run)
        }
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
      await run.queue
      if (!run.active && !run.afterFire) await stopProcess(id, child.pid)
    }
    async function effect(value: Effect) {
      if (value.action === 'start') {
        try {
          await launch(value.id, value.previousPid)
        } catch (error) {
          await finish(value.id, undefined, null, undefined, String(error))
          throw error
        }
      } else await stopProcess(value.id, value.previousPid)
    }
    async function prepare(args: Args, caller?: number): Promise<Prepared> {
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
        if (args.scope !== undefined && args.scope !== 'user' && args.scope !== 'project')
          throw new Error('scope must be user or project')
        if (args.scope !== 'project') {
          if (args.slug !== undefined) throw new Error('slug is only for project subscriptions')
          return await agentFor(caller)
        }
        if (!(await trusted()))
          throw new Error("Choose this project's local setup before creating project subscriptions")
        const slug =
          args.slug ??
          (args.title ?? required(args.ask, 'ask'))
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^[^a-z]+|-+$/g, '')
            .slice(0, 40)
            .replace(/-+$/, '')
        if (typeof slug !== 'string' || !isSlug(slug))
          throw new Error(
            'slug must match ^[a-z][a-z0-9-]*$ (at most 63 characters) and not be an object key',
          )
        const committed: Manifest = {
          title: args.title?.trim() ?? required(args.ask, 'ask').slice(0, 80),
          ask: required(args.ask, 'ask'),
          once: args.once ?? true,
          ...(args.secrets?.length ? { secrets: args.secrets } : {}),
        }
        const path = join(projectDir(slug), MANIFEST)
        // Published before the record commits. A replay finds its own equal manifest and adopts it; a different
        // one is another subscription.
        // Resolved before reserving the slug: only the guarded block below may leave it reserved.
        const agent = await agentFor(caller)
        if (creating.has(slug)) throw new Error(`Subscription ${slug} is being created`)
        creating.add(slug)
        try {
          const existing = await readFile(path, 'utf8').then(
            (text) => {
              try {
                return manifest(JSON.parse(text)) ?? null
              } catch {
                // An unreadable manifest is someone's broken subscription, not ours to overwrite.
                return null
              }
            },
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
              return undefined
            },
          )
          if (
            existing !== undefined &&
            JSON.stringify(existing) !== JSON.stringify(manifest(committed))
          )
            throw new Error(`Subscription ${slug} already exists; pass another slug`)
          const record = (await host.harness().snapshot(Subscriptions, BACKGROUND_CONTEXT))
            ?.subscriptions[slug]
          if (record && !pristine(record))
            throw new Error(`Subscription ${slug} already exists; pass another slug`)
          if (existing === undefined) await writeJson(path, committed)
        } catch (error) {
          creating.delete(slug)
          throw error
        }
        return { ...agent, slug }
      }
      if (args.action === 'list') {
        await discover()
        return {}
      }
      const id = validId(args.id)
      if (!id.startsWith('S')) await discover()
      const sub = await snapshot(id)
      if (args.action === 'start') {
        try {
          await access(runPath(sub), constants.X_OK)
        } catch {
          throw new Error(
            `Missing or non-executable ${runPath(sub)}; write it and chmod +x it first`,
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
      prepared: Prepared,
      caller?: number,
    ): Promise<{ result: JsonValue; effect?: Effect }> {
      const state = await tx.doc(Subscriptions)
      if (args.action === 'list')
        return {
          result: Object.values(state.subscriptions).map((s) => ({
            ...s,
            alive: groupAlive(s.pid),
          })),
        }
      if (args.action === 'create') {
        // Only a record discovery made from this create's own manifest (crash, replay) is adopted, with its agent.
        if (
          prepared.slug &&
          state.subscriptions[prepared.slug] &&
          !pristine(state.subscriptions[prepared.slug])
        )
          throw new Error(`Subscription ${prepared.slug} already exists; pass another slug`)
        const id = prepared.slug ?? `S${state.next++}`
        const title = args.title?.trim() ?? required(args.ask, 'ask').slice(0, 80)
        // A concurrent list may already have discovered the manifest written in prepare: adopt its agent.
        const conversationId =
          (prepared.slug && state.subscriptions[prepared.slug]?.conversationId) ||
          (await agentConversation(
            tx,
            prepared,
            id,
            title,
            prepared.slug
              ? host.projectRoot
              : ((await tx.doc(AgentDoc, caller as ConversationId)).cwd ?? host.projectRoot),
          ))
        const now = Date.now()
        const sub: Subscription = {
          id,
          ...(prepared.slug ? { scope: 'project' as const } : {}),
          title: args.title?.trim() ?? required(args.ask, 'ask').slice(0, 80),
          ask: required(args.ask, 'ask'),
          once: args.once ?? true,
          enabled: true,
          conversationId,
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
      const id = validId(args.id)
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
        if (args.action === 'escalate') sub.state = 'failed'
        else if (sub.state !== 'done') sub.state = 'stopped'
        const pid = sub.pid
        if (args.action === 'escalate') {
          sub.error = required(args.reason, 'reason')
          const event = await host.emit(tx, Escalated, { id, reason: sub.error })
          await deliver(tx, sub, event.id, 'escalated', sub.error)
        }
        if (args.action === 'delete') delete state.subscriptions[id]
        return {
          result: args.action === 'delete' ? { id } : sub,
          effect: { id, action: 'stop', ...(pid ? { previousPid: pid } : {}) },
        }
      }
      return { result: sub }
    }
    const effects = new Map<string, Promise<void>>()
    async function apply(value?: Effect) {
      if (!value) return
      const previous = effects.get(value.id) ?? Promise.resolve()
      const work = previous.then(async () => {
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
        .finally(() => settle(prepared))
      await apply(receipt.effect)
      if (args.action === 'start') return json(await snapshot(required(args.id, 'id')))
      return receipt.result
    }
    /** A project create's record is committed (or failed): discovery owns its slug again. */
    const settle = (prepared: Prepared) => {
      if (prepared.slug) creating.delete(prepared.slug)
    }
    async function status(id: string): Promise<SubscriptionListItem> {
      if (!validId(id).startsWith('S')) await discover()
      const sub = await snapshot(id)
      return { ...json(sub), alive: groupAlive(sub.pid) }
    }
    const close = async () => {
      closing = true
      // A pending launch may be reading secrets or checking its executable; it must settle before cleanup.
      await Promise.allSettled(launches)
      for (const [id, run] of runs) await stopProcess(id, run.child.pid, 'shutdown')
    }
    const open = async () => {
      closing = false
      let folders: Dirent[]
      try {
        folders = await readdir(
          join(host.userHome, '.ultimate/subscriptions', basename(host.home)),
          { withFileTypes: true },
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        folders = []
      }
      // Sweep files, not ledger records: stop/delete may have committed just before a crash.
      for (const entry of folders) {
        if (!entry.isDirectory() || !isId(entry.name)) continue
        const pid = await readPid(entry.name)
        if (pid) await cleanup(entry.name, pid, runs.get(entry.name))
      }
      // A project subscription whose folder is gone, or whose project is no longer chosen, is forgotten before restarts.
      await discover()
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
    return { Deliver, operate, status, prepare, change, settle, apply, open, close, runPath }
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
    const api = backend(host)
    // status discovers project subscriptions first, so a new, removed or untrusted slug reads like list shows it.
    const path = api.runPath(await api.status(validId(input(args, 'script').id)))
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
/** The Subscriptions panel polls these every 2 s while it is open. */
export const pollActions = ['list', 'log', 'script']
export default function subscriptions(host: ExtensionHost) {
  host.need(SubagentsApi)
  host.need(MessagesApi)
  const api = backend(host)
  host.implement(SubscriptionsApi, {
    start: async (id) => (await api.operate({ action: 'start', id }), api.status(id)),
    stop: async (id) => (await api.operate({ action: 'stop', id }), api.status(id)),
    status: api.status,
  })
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
          'Subscribe conversations to background conditions. create {ask,title?,once?,secrets?,subscribers?,scope?,slug?} starts an agent that writes a cheap script; returns immediately. scope "project" commits it in <project>/.ultimate/subscriptions/<slug>/ for everyone on the repo (default "user": this machine only). list; subscribe/unsubscribe {id,to?: "#id"|"@name"} (default caller); start/stop/delete {id}; log {id,lines?}; escalate {id,reason}. IDs are S<n> for user subscriptions and the slug for project ones; project subscriptions never start by themselves. A recurring script that prints DONE and exits 0 stops cleanly; start resumes it. Failures wake only the subscription agent; escalation notifies subscribers and @ultimate. Files and conversation survive delete.',
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
          scope: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('project')])),
          slug: Type.Optional(Type.String()),
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
            receipt = await tool
              .commit(async (tx) => {
                const value = await tx.doc(Receipt, tool.taskId)
                if (value.result === undefined)
                  Object.assign(value, await api.change(tx, args, prepared, tool.conversationId))
                return json(value)
              }, context)
              .finally(() => api.settle(prepared))
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
