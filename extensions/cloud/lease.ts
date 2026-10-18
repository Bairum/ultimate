// The writer lease lifecycle: a machine serves a project only while it holds the lease (`cloud/protocol.ts`), and the
// lease moves between machines with a snapshot of the closed database.
//
// - Serving, a `standby` role closes storage (`host.deactivate`), parking the database as `state.stale-<time>.sqlite`
//   unless it is the lease's last snapshot.
// - The writer releases on a clean stop, after `cloud.idleRelease` idle minutes, or when a standby asks: it closes
//   storage, uploads a snapshot, records its hash in `cloud-lease.json`, sends `release` and waits for the free lease.
// - A standby takes the lease on start (`cloud.autoClaim`, a free lease only), with "Move here", or when the cloud UI
//   sends `move-to`. It first prepares, reporting each step as a `Transition`: it fast-forwards the checkout, installs
//   when the lockfile changed, checks the model login, secrets and the project root, asks a holding writer to release,
//   downloads the snapshot unless its database is that snapshot, and only then claims and opens storage with the
//   snapshot installed. The transition records who started it (`by`).
//
// Lifecycle switches never run inside a socket handler: roles are handled after a `setTimeout(0)`, one switch at a time.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonObject } from '@earendil-works/pi-durable'
import { exec as run } from '../../lib/exec.ts'
import { applyWaiting, handoverDetail, LEFT_LIMITS } from '../../cloud/protocol.ts'
import type { MoveBy, Transition, TransitionStep } from '../../cloud/protocol.ts'
import type { projectBuilds } from '../../cloud/ui-build.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
// oxlint-disable-next-line no-restricted-imports -- a stop release holds storage's lock, which a swapped-in core owns
import { acquireLock } from '../../server/lock.ts'
import { AutomationsApi } from '../automations/api.ts'
import { readSecret, secretMetadata } from '../../lib/secrets.ts'
import { modelLogin, noLogin } from './login.ts'
import type { ModelLogin } from './types.ts'
import type { Connect, startSync, SyncOptions, SyncState } from './server.ts'
import type { databaseHash, downloadSnapshot, uploadSnapshot } from './snapshot.ts'

export interface LeaseOptions extends SyncOptions {
  /** Idle minutes before the writer releases; 0 never. */
  idleRelease: number
  /** Claim a free lease when the process starts. */
  autoClaim: boolean
}
/** Run a program without a shell, as `execFile` does: resolves its output, rejects with `stdout`/`stderr` attached. */
export type Exec = (
  command: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>
export interface LeaseDeps {
  sync: typeof startSync
  dial: Connect
  snapshots: {
    uploadSnapshot: typeof uploadSnapshot
    downloadSnapshot: typeof downloadSnapshot
    databaseHash: typeof databaseHash
  }
  builds?: ReturnType<typeof projectBuilds>
  /** The snapshot key, read from Secrets unless injected. */
  secret?: () => Promise<string | undefined>
  /** Runs git and pnpm for the prepare steps. */
  exec?: Exec
  /** The model login this machine's agents run with, read from the host's model runtime unless injected. */
  login?: () => Promise<ModelLogin>
}
/** `cloud.state`: everything the standby page shows. */
export interface LeaseState {
  role?: 'writer' | 'standby'
  free: boolean
  writer?: SyncState['writer']
  /** Secret names the writer has and this machine lacks. */
  missing: string[]
  /** Why "Move here" cannot work right now. */
  blocked?: string
  /** The upload of a release. A move's download shows in its transition. */
  progress?: { kind: 'upload'; done: number; total: number }
  /** The move this machine runs, or else the latest one the cloud reported. */
  transition?: Transition
  /** The last move this machine ran itself, ended or not, also when a newer one shows as `transition`. */
  ran?: Transition
  /** The replica's project key the cloud admitted this machine under; a relinked checkout's differs from its origin's. */
  key?: string
  /** The model login this machine's agents run with; a move here fails its checks without one. */
  login: ModelLogin
  lastError?: string
}

const SECRET = 'ULTIMATE_CLOUD_SNAPSHOT_KEY'
/** Room for the snapshot and the release inside the supervisor's 10-second stop. */
const STOP_BUDGET = 8000
const MOVE_CAP = 10 * 60_000
/** A held move rechecks its worktrees this often, besides on every task graph change. */
export const HOLD_RECHECK = 30_000
const suffixes = ['', '-wal', '-shm']
const STEPS: TransitionStep['name'][] = [
  'fetch',
  'install',
  'checks',
  'handover',
  'download',
  'branches',
  'claim',
]
const exec: Exec = (command, args, options) =>
  run(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 })

/** What `cloud-lease.json` holds beyond the epoch: the snapshot the last release uploaded and its database hash. */
interface LeaseFile {
  key?: string
  epoch?: number
  snapshot?: string
  snapshotHash?: string
}
/**
 * `cloud-claim.json`, written before `claim` is sent: the lease epoch claimed, the snapshot it takes over, its download
 * (absent when the local database is that snapshot) and the hash of the database it opens as the writer.
 */
interface ClaimIntent {
  key: string
  epoch: number
  snapshot: { id: string; epoch: number }
  download?: string
  hash: string
}

/** Move a SQLite database with its `-wal` and `-shm`; never deletes one. */
async function moveDatabase(from: string, to: string) {
  for (const suffix of suffixes)
    if (existsSync(from + suffix)) await rename(from + suffix, to + suffix)
}
async function writeJson(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, JSON.stringify(value))
  await rename(`${path}.tmp`, path)
}
const staleName = (database: string) =>
  database.replace(/state\.sqlite$/, `state.stale-${new Date().toISOString()}.sqlite`)
/** The last lines of a failed command's output. */
function tail(error: unknown) {
  const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
  const output = `${stdout}${stderr}`.trim()
  return output ? output.split('\n').slice(-20).join('\n') : String(error)
}
// Conversation runs and lander runs are foreground tasks; schedulers and reporters wait in the background.
const foregroundTasks = (graph: {
  value: { tasks: Record<string, { background: boolean; conversationId: number }> }
}) => Object.values(graph.value.tasks).filter((task) => !task.background)
const foreground = (graph: Parameters<typeof foregroundTasks>[0]) => foregroundTasks(graph).length
/** Transition text bounded well under the replica's limit, keeping the end, where errors say what failed. */
const clipTo = (text: string, max: number) =>
  text.length > max ? `…${text.slice(-(max - 1))}` : text
const clip = (text: string) => clipTo(text, 500)
const runs = (count: number) => `${count} running ${count === 1 ? 'task' : 'tasks'}`
const changes = (paths: string[]) =>
  `${paths.length} ${paths.length === 1 ? 'worktree' : 'worktrees'} with uncommitted changes`
/**
 * The writer's secret names this machine lacks. A writer that could not name all of its secrets adds one entry for
 * the unnamed rest, so an ordinary move stops at checks rather than proceeding unverified.
 */
const missingSecrets = (state: SyncState | undefined, local: Set<string>) => {
  const writer = state?.writer
  const missing = (writer?.secrets ?? []).filter((name) => !local.has(name))
  if (writer && !writer.secretsComplete) missing.push('(more the writer could not list)')
  return missing
}

export function startLease(host: ExtensionHost, options: LeaseOptions, deps: LeaseDeps) {
  const { identity } = options
  const leasePath = join(host.home, 'cloud-lease.json')
  const claimPath = join(host.home, 'cloud-claim.json')
  /** An install the checkout owes: its lockfile changed and no install succeeded since. */
  const owed = join(host.home, 'cloud-install-pending')
  const standbyPath = join(host.home, 'standby.json')
  const database = join(host.home, 'state.sqlite')
  const execute = deps.exec ?? exec
  const loginHere = deps.login ?? (() => modelLogin(host))
  let sync: ReturnType<typeof startSync> | undefined
  let mode: 'serving' | 'standby' | undefined
  let closed = false
  // Only the first standby role after this process starts may claim by itself.
  let autoClaim = options.autoClaim
  let progress: LeaseState['progress']
  let lastError: string | undefined
  let idleSince: number | undefined
  let idleTimer: ReturnType<typeof setInterval> | undefined
  let pendingRelease:
    | { epoch: number; id: string; sent: boolean; done: PromiseWithResolvers<void> }
    | undefined
  /** A claim sent and its answer; after a reconnect the new connection's first role is that answer. */
  let pendingClaim:
    | { epoch: number; done: PromiseWithResolvers<boolean>; reconnected: boolean }
    | undefined
  /** The move this machine prepares, and how to stop it before its claim. */
  let moving: { transition: Transition; abort: AbortController } | undefined
  /** The last move this machine ran, ended or not; the cloud's copy may lag behind it. */
  let ran: Transition | undefined
  /** The transition this writer releases for: its hellos name it, so the cloud keeps that transition alive. */
  let releasingFor: string | undefined
  /** Wakes a release that holds for a move, set while it holds. */
  let holding: (() => void) | undefined
  /** A move's handover waits for the free lease. */
  let freed: PromiseWithResolvers<SyncState> | undefined
  /** Roles seen by a draining writer, which stops when the move it drains for ends. */
  const watchers = new Set<(state: SyncState) => void>()
  // Lifecycle work runs one task at a time, outside every socket handler.
  let chain: Promise<unknown> = Promise.resolve()
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work)
    // The caller gets the failure; the chain only waits for the work to settle.
    chain = next.catch(() => undefined)
    return next
  }
  const fail = (message: string) => {
    lastError = message
    host.notice(message)
  }
  const report = (error: unknown) => fail(`Cloud lease: ${String(error)}`)
  const serving = () => {
    try {
      host.harness()
      return true
    } catch {
      // The harness is closed: on standby, or between switches.
      return false
    }
  }

  const readLeaseFile = async (): Promise<LeaseFile> => {
    try {
      return JSON.parse(await readFile(leasePath, 'utf8')) as LeaseFile
    } catch {
      // No lease file yet: nothing is known about the local database.
      return {}
    }
  }
  const readIntent = async (): Promise<ClaimIntent | undefined> => {
    try {
      const intent = JSON.parse(await readFile(claimPath, 'utf8')) as ClaimIntent
      return intent.key === identity.key ? intent : undefined
    } catch {
      // No claim in flight.
      return undefined
    }
  }
  /** Drop a claim that did not win, with its download. */
  const dropIntent = async (intent: ClaimIntent) => {
    if (intent.download) await rm(intent.download, { force: true })
    await rm(claimPath, { force: true })
  }
  // A previous process may have died mid-snapshot or mid-download: only a claim in flight keeps its download.
  const tidy = (async () => {
    const intent = await readIntent()
    for (const name of await readdir(host.home)) {
      const path = join(host.home, name)
      if (name.startsWith('.snapshot-')) await rm(path, { recursive: true, force: true })
      else if (name.startsWith('snapshot-') && path !== intent?.download)
        await rm(path, { force: true })
    }
  })().catch(report)
  // Snapshots live under the replica's own key: after a relink, machines connect with different keys to one replica.
  const snapshotKey = () => sync?.state().project?.key ?? identity.key
  /** Open storage as the writer at `epoch`, installing `download` in place of any local database. */
  const openAsWriter = async (epoch: number, download?: string) => {
    await writeJson(leasePath, { key: identity.key, epoch } satisfies LeaseFile)
    await host.activate(async (path) => {
      if (!download) return
      if (suffixes.some((suffix) => existsSync(path + suffix)))
        await moveDatabase(path, staleName(path))
      await rename(download, path)
    })
    await rm(claimPath, { force: true })
  }
  const fetchSnapshot = async (
    id: string,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ) => {
    const key = await secret()
    if (!key) throw new Error(missingKey)
    return deps.snapshots.downloadSnapshot({
      url: options.url,
      token: options.token,
      secret: key,
      key: snapshotKey(),
      id,
      dir: host.home,
      repo: host.projectRoot,
      signal,
      progress: onProgress,
    })
  }
  /**
   * Finish or drop a claim a previous process left in flight. It won when the cloud names this machine the writer at
   * the claimed epoch + 1: install its download (fetched again when it is gone or does not verify, unless the local
   * database already is that snapshot), then open storage. Otherwise the download and the intent go. True: it opened.
   */
  /**
   * `path` is the database hashing to `hash`: a download or its installed copy byte for byte (the manifest hashes the
   * plaintext), or a database whose content `databaseHash` finds unchanged.
   */
  const holds = async (path: string, hash: string) => {
    if (!existsSync(path)) return false
    const bytes = createHash('sha256')
    for await (const chunk of createReadStream(path)) bytes.update(chunk as Buffer)
    return bytes.digest('hex') === hash || (await deps.snapshots.databaseHash(path)) === hash
  }
  const recover = async (intent: ClaimIntent, state: SyncState) => {
    if (state.role !== 'writer' || state.epoch !== intent.epoch + 1) {
      await dropIntent(intent)
      return false
    }
    let download = intent.download
    if (download && !(await holds(download, intent.hash))) {
      await rm(download, { force: true })
      download = undefined
    }
    if (!download && !(await holds(database, intent.hash)))
      download = (await fetchSnapshot(intent.snapshot.id)).database
    await openAsWriter(state.epoch, download)
    return true
  }
  /** The local database is the snapshot `snapshot`: the last release recorded it and its content is unchanged. */
  const isSnapshot = async (snapshot: SyncState['snapshot']) => {
    const lease = await readLeaseFile()
    return (
      !!snapshot &&
      lease.key === identity.key &&
      lease.snapshot === snapshot.id &&
      lease.epoch === snapshot.epoch &&
      !!lease.snapshotHash &&
      existsSync(database) &&
      (await deps.snapshots.databaseHash(database)) === lease.snapshotHash
    )
  }
  const secret = async () =>
    (await deps.secret?.()) ?? process.env[SECRET] ?? (await readSecret(host.userHome, SECRET))
  const missingKey = `Missing ${SECRET}. Add it in the Secrets panel (⌘K → Secrets) to move this project.`
  const localSecrets = async () =>
    new Set(
      await secretMetadata(host.userHome).then(
        (secrets) => secrets.map((item) => item.name),
        // The Secrets panel reports an unreadable store; until then every writer secret counts as missing.
        () => [],
      ),
    )

  const connect = (next: 'serving' | 'standby') => {
    sync?.()
    mode = next
    const current = deps.sync(
      host,
      options,
      deps.dial,
      next === 'serving' ? deps.builds : undefined,
      {
        serving: next === 'serving',
        // A replaced connection's last roles no longer apply.
        role: (state) => setTimeout(() => sync === current && onRole(state, current), 0),
        releaseRequested: (by, id, force) =>
          setTimeout(() => void moveTo(by, id, force).catch(report), 0),
        releaseWaiting: (waiting) => {
          const { by, tasks, dirty, held = false, unchecked } = waiting
          if (tasks > 0) host.notice(`Move to ${by} waits for ${runs(tasks)}`)
          else if (held && dirty?.length) host.notice(`Move to ${by} waits for ${changes(dirty)}`)
          else if (unchecked)
            host.notice(`Move to ${by} waits: could not check worktrees: ${unchecked}`)
          if (!moving) return
          applyWaiting(moving.transition, waiting)
          const handover = moving.transition.steps.find((step) => step.name === 'handover')
          if (handover && moving.transition.from) {
            handover.detail = handoverDetail(
              moving.transition.from,
              tasks,
              moving.transition.left?.length,
              held,
              unchecked,
            )
            publish()
          }
        },
        moveTo: (id, force, by) => setTimeout(() => void move({ id, force, by }).catch(report), 0),
        cancel: (id) => {
          if (moving?.transition.id === id) cancel()
        },
        transition: () => moving?.transition.id ?? releasingFor,
        hello: () => {
          if (pendingClaim) pendingClaim.reconnected = true
        },
      },
    )
    sync = current
    clearInterval(idleTimer)
    idleSince = undefined
    // Checked every minute, or four times within a shorter threshold.
    if (next === 'serving' && options.idleRelease > 0)
      idleTimer = setInterval(
        () => void checkIdle().catch(report),
        Math.min(60_000, Math.max(1000, options.idleRelease * 15_000)),
      )
  }
  const disconnect = () => {
    sync?.()
    clearInterval(idleTimer)
    mode = undefined
    holding?.()
  }

  const onRole = (state: SyncState, connection: typeof sync) => {
    for (const watch of watchers) watch(state)
    if (pendingRelease) {
      if (state.role === 'writer' && !pendingRelease.sent)
        pendingRelease.sent = sync!.send({
          type: 'release',
          epoch: pendingRelease.epoch,
          snapshot: { id: pendingRelease.id },
        })
      else if (state.role === 'standby') {
        if (pendingRelease.sent) pendingRelease.done.resolve()
        else pendingRelease.done.reject(new Error('this machine no longer holds the lease'))
        pendingRelease = undefined
      }
      return
    }
    if (pendingClaim) {
      if (state.role === 'writer') pendingClaim.done.resolve(true)
      // A free lease at the claimed epoch is an announcement sent before the claim arrived, unless it answers the
      // hello of a new connection, which named the claimed epoch + 1: then the claim was lost.
      else if (pendingClaim.reconnected || !state.free || state.epoch !== pendingClaim.epoch)
        pendingClaim.done.resolve(false)
      return
    }
    // A preparing move decides for itself; it only waits for the lease to be freed, or ends when the cloud ended it.
    if (moving) {
      const reported = state.transition
      if (reported?.id === moving.transition.id && reported.error)
        moving.abort.abort(new Error(reported.error))
      else if (state.free) freed?.resolve(state)
      return
    }
    if (closed) return
    void queue(() => decide(state, connection)).catch(report)
  }
  const decide = async (state: SyncState, connection: typeof sync) => {
    await tidy
    if (sync !== connection) return
    const intent = await readIntent()
    // Serving after a claim means it won and opened; only its intent was left.
    if (intent && mode === 'serving') await dropIntent(intent)
    // A claim that did not win leaves this machine an ordinary standby, which may claim again.
    if (intent && mode === 'standby' && (await recover(intent, state))) return
    if (mode === 'serving' && state.role === 'standby') {
      const { writer, free } = state
      await host.deactivate(
        {
          reason: writer?.machine ? `Runs on ${writer.machine}` : 'Released · resume here',
          ...(writer ? { writer: { ...writer } } : {}),
          free: !!free,
          cloud: true,
        },
        // The released snapshot stays in place; anything else is history of its own, kept aside.
        async (path) => {
          if (
            suffixes.some((suffix) => existsSync(path + suffix)) &&
            !(await isSnapshot(state.snapshot))
          )
            await moveDatabase(path, staleName(path))
        },
      )
      connect('standby')
      return
    }
    if (mode !== 'standby') return
    // The cloud names this machine the writer while it is on standby: a release that never happened, or a project
    // this machine just registered. It opens its own database only when that is the writer's state at this epoch.
    if (state.role === 'writer') {
      const lease = await readLeaseFile()
      if (
        (lease.key === identity.key && lease.epoch === state.epoch) ||
        !state.snapshot ||
        (await isSnapshot(state.snapshot))
      )
        return openAsWriter(state.epoch!)
      // Otherwise the last snapshot is the best state there is, installed as a claim would.
      const { database: download, manifest } = await fetchSnapshot(state.snapshot.id)
      await writeJson(claimPath, {
        key: identity.key,
        epoch: state.epoch! - 1,
        snapshot: state.snapshot,
        download,
        hash: manifest.database.sha256,
      } satisfies ClaimIntent)
      return openAsWriter(state.epoch!, download)
    }
    const claimNow = autoClaim && !!state.free
    autoClaim = false
    if (claimNow) await prepare(randomUUID(), false, 'auto')
  }

  /** Why "Move here" cannot work right now, if it cannot. */
  const blocked = (state: SyncState | undefined) => {
    const writer = state?.writer
    if (!state?.connected || !writer) return 'The cloud is not connected'
    if (state.role === 'writer') return 'This machine runs the project'
    if (writer.root !== host.projectRoot)
      return `The project runs at ${writer.root}; this checkout is ${host.projectRoot}`
    if (state.free && !state.snapshot) return 'The project has no snapshot to move yet'
    if (!state.free && !writer.online) return `${writer.machine} is offline`
    return undefined
  }

  // The latest transition goes to the cloud at once on a step change, and at most every half second for progress.
  let published = 0
  // A throttled update is sent once the half second is up, so the latest progress is never lost.
  let trailing: ReturnType<typeof setTimeout> | undefined
  const publish = (throttled = false) => {
    if (!moving) return
    const wait = published + 500 - Date.now()
    if (throttled && wait > 0) {
      trailing ??= setTimeout(() => {
        trailing = undefined
        publish()
      }, wait)
      return
    }
    clearTimeout(trailing)
    trailing = undefined
    published = Date.now()
    // Every detail is bounded here, whichever step wrote it, so the cloud never refuses an update for its size.
    const value = structuredClone(moving.transition)
    for (const step of value.steps) if (step.detail !== undefined) step.detail = clip(step.detail)
    if (value.error !== undefined) value.error = clip(value.error)
    sync?.send({ type: 'transition', value })
  }
  const cancel = () => {
    if (moving?.transition.cancellable) moving.abort.abort(new Error('Cancelled'))
  }

  /** Fast-forward the checkout's default branch to origin's; true when `pnpm-lock.yaml` changed with it. */
  const fastForward = async (step: TransitionStep, signal: AbortSignal) => {
    const git = async (...args: string[]) => {
      try {
        return (await execute('git', args, { cwd: host.projectRoot, signal })).stdout.trim()
      } catch (error) {
        if (signal.aborted) throw signal.reason
        throw new Error(`git ${args[0]} failed: ${tail(error)}`, { cause: error })
      }
    }
    if (await git('status', '--porcelain', '--untracked-files=no'))
      throw new Error('The checkout has uncommitted changes')
    await git('fetch', '--quiet', 'origin')
    const remote = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => {
      throw new Error('origin has no default branch; run git remote set-head origin --auto')
    })
    const branch = remote.replace(/^origin\//, '')
    const current = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
    if (current !== branch)
      throw new Error(`The checkout is on ${current || 'a detached HEAD'}, not ${branch}`)
    const [ahead, behind] = (await git('rev-list', '--left-right', '--count', `HEAD...${remote}`))
      .split(/\s+/)
      .map(Number)
    if (ahead && behind) throw new Error(`${branch} has diverged from ${remote}`)
    const before = await git('rev-parse', 'HEAD')
    // The install is owed before the lockfile changes, so a crash between the two still installs on the next try.
    if (behind && (await git('diff', '--name-only', 'HEAD', remote, '--', 'pnpm-lock.yaml')))
      await writeFile(owed, '')
    if (behind) await git('merge', '--ff-only', '--quiet', remote)
    const after = await git('rev-parse', 'HEAD')
    if (before === after) {
      step.detail = `${branch} already up to date`
      return
    }
    step.commits = behind
    step.detail = `${branch} fast-forwarded ${behind} ${behind === 1 ? 'commit' : 'commits'}, ${before.slice(0, 7)}..${after.slice(0, 7)}`
  }

  /**
   * The worktrees of this checkout, the main one included, with uncommitted changes: they stay on this machine when
   * the project moves. At most `LEFT_LIMITS.paths`, each path bounded, keeping its end.
   */
  const dirtyWorktrees = async () => {
    const signal = AbortSignal.timeout(30_000)
    const gitIn = async (cwd: string, ...args: string[]) =>
      (await execute('git', args, { cwd, signal })).stdout
    const list = await gitIn(host.projectRoot, 'worktree', 'list', '--porcelain')
    const dirty: string[] = []
    for (const block of list.split('\n\n')) {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      if (!path || /^(bare|prunable)/m.test(block)) continue
      // A worktree whose folder is gone is `prunable`, skipped above; any other failure leaves its state unknown.
      const status = await gitIn(path, 'status', '--porcelain').catch((error: unknown) => {
        throw new Error(`${path}: ${tail(error)}`, { cause: error })
      })
      if (status.trim())
        dirty.push(
          path.length > LEFT_LIMITS.path ? `…${path.slice(-(LEFT_LIMITS.path - 1))}` : path,
        )
      if (dirty.length === LEFT_LIMITS.paths) break
    }
    return dirty
  }

  /**
   * Prepare to take the lease and take it, reporting each step. A failure or a cancel before the claim leaves the
   * holder untouched and deletes only the download. Resolves whether this machine runs the project now.
   */
  const prepare = async (id: string, force: boolean, by: MoveBy) => {
    const start = sync?.state()
    const refused = moving
      ? 'Another move is preparing'
      : mode !== 'standby'
        ? 'This machine is not on standby'
        : blocked(start)
    if (refused) {
      fail(`Move here refused: ${refused}`)
      return false
    }
    const transition: Transition = {
      id,
      target: options.machine,
      from: start!.free ? null : (start!.writer?.machine ?? null),
      by,
      step: 'fetch',
      steps: STEPS.map((name) => ({ name, state: 'pending' })),
      cancellable: true,
      startedAt: Date.now(),
    }
    const abort = new AbortController()
    const { signal } = abort
    moving = { transition, abort }
    ran = transition
    let downloaded: string | undefined
    let claimed = 0
    let current: TransitionStep | undefined
    const begin = (name: TransitionStep['name']) => {
      signal.throwIfAborted()
      current = transition.steps.find((step) => step.name === name)!
      current.state = 'running'
      transition.step = name
      publish()
      return current
    }
    const end = (state: 'done' | 'skipped', detail?: string) => {
      current!.state = state
      if (detail !== undefined) current!.detail = detail
      publish()
    }
    try {
      const fetched = begin('fetch')
      await fastForward(fetched, signal)
      end('done')

      begin('install')
      // Owed since the fast-forward changed the lockfile, and until an install succeeds.
      if (!existsSync(owed)) end('skipped', 'pnpm-lock.yaml is unchanged')
      else {
        try {
          await execute('pnpm', ['install', '--frozen-lockfile'], {
            cwd: host.projectRoot,
            signal,
            timeout: MOVE_CAP,
          })
        } catch (error) {
          if (signal.aborted) throw signal.reason
          throw new Error(`pnpm install failed:\n${tail(error)}`, { cause: error })
        }
        await rm(owed)
        end('done', 'pnpm install --frozen-lockfile')
      }

      begin('checks')
      let state = sync!.state()
      const reason = blocked(state)
      if (reason) throw new Error(reason)
      const key = await secret()
      if (!key) throw new Error(missingKey)
      // Without a model login nothing runs here once it moved: `force` only skips missing secrets.
      const login = await (deps.login ?? (() => modelLogin(host, { confirm: true })))()
      if (!login.ok) throw new Error(noLogin(login.provider, login.error))
      const local = await localSecrets()
      const missing = missingSecrets(state, local)
      if (missing.length && !force) throw new Error(`Missing secrets: ${missing.join(', ')}`)
      end('done', missing.length ? `Continuing without ${missing.join(', ')}` : 'Ready')

      begin('handover')
      if (state.free) end('skipped', 'The lease is free')
      else {
        freed = Promise.withResolvers<SyncState>()
        const aborted = () => freed?.reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        sync!.send({ type: 'request-release', id, ...(force ? { force: true } : {}) })
        try {
          state = await freed.promise
        } finally {
          signal.removeEventListener('abort', aborted)
          freed = undefined
        }
        // Uncommitted work the writer left behind stays the step's line once it released.
        end(
          'done',
          transition.left?.length
            ? handoverDetail(transition.from!, 0, transition.left.length)
            : `${transition.from} released the project`,
        )
      }

      const download = begin('download')
      const snapshot = state.snapshot
      if (!snapshot) throw new Error('The project has no snapshot to move yet')
      let keptRefs: string[] = []
      // The database this machine opens as the writer: the local one, or the download.
      let hash: string
      if (await isSnapshot(snapshot)) {
        hash = (await readLeaseFile()).snapshotHash!
        end('skipped', 'This machine has the snapshot')
      } else {
        const result = await fetchSnapshot(snapshot.id, signal, (done, total) => {
          download.done = done
          download.total = total
          publish(true)
        })
        downloaded = result.database
        keptRefs = result.keptRefs
        hash = result.manifest.database.sha256
        end('done')
      }

      begin('branches')
      if (!downloaded) end('skipped')
      else if (keptRefs.length)
        end('done', `Kept local branches; the moved ones are ${keptRefs.join(', ')}`)
      else end('done', 'ultimate/* branches restored')

      begin('claim')
      transition.cancellable = false
      publish()
      // The intent outlives a crash from here on: a restart finishes the claim it won or drops the one it lost.
      await writeJson(claimPath, {
        key: identity.key,
        epoch: state.epoch!,
        snapshot,
        ...(downloaded ? { download: downloaded } : {}),
        hash,
      } satisfies ClaimIntent)
      const done = Promise.withResolvers<boolean>()
      pendingClaim = { epoch: state.epoch!, done, reconnected: false }
      const won = sync!.send({ type: 'claim', epoch: state.epoch! }) && (await done.promise)
      pendingClaim = undefined
      if (!won) throw new Error('Another machine took the project first')
      end('done', `Runs here from epoch ${state.epoch! + 1}`)
      lastError = undefined
      moving = undefined
      claimed = state.epoch! + 1
    } catch (error) {
      const reason: unknown = signal.aborted ? signal.reason : error
      const message = reason instanceof Error ? reason.message : String(reason)
      // Only the download and the claim intent go; the holder and the local database stay as they are.
      if (downloaded) await rm(downloaded, { force: true })
      await rm(claimPath, { force: true })
      if (current) {
        current.state = 'failed'
        current.detail = message
      }
      transition.error = message
      transition.cancellable = false
      publish()
      moving = undefined
      fail(`Move here failed: ${message}`)
      return false
    }
    // The claim won. A failure from here keeps the download and the intent: the next start finishes opening storage.
    try {
      await openAsWriter(claimed, downloaded)
      return true
    } catch (error) {
      fail(
        `Opening storage as the writer failed; restart Ultimate to finish the move: ${String(error)}`,
      )
      return false
    }
  }
  const move = ({
    id = randomUUID(),
    force = false,
    by = 'local',
  }: { id?: string; force?: boolean; by?: MoveBy } = {}) => queue(() => prepare(id, force, by))

  /**
   * With storage closed: upload the snapshot, record it, release and wait for the free lease. Resolves whether the
   * release was sent, so a failure before it keeps the lease.
   */
  const releaseClosed = async (epoch: number, key: string, signal?: AbortSignal) => {
    let pending: NonNullable<typeof pendingRelease> | undefined
    try {
      progress = { kind: 'upload', done: 0, total: 0 }
      const manifest = await deps.snapshots.uploadSnapshot({
        url: options.url,
        token: options.token,
        secret: key,
        key: snapshotKey(),
        epoch,
        machine: options.machine,
        database,
        repo: host.projectRoot,
        signal,
        progress: (done, total) => {
          progress = { kind: 'upload', done, total }
        },
      })
      progress = undefined
      // The manifest hashes the same consistent copy `databaseHash` does.
      const lease: LeaseFile = {
        key: identity.key,
        epoch,
        snapshot: manifest.id,
        snapshotHash: manifest.database.sha256,
      }
      await writeJson(leasePath, lease)
      const done = Promise.withResolvers<void>()
      pending = { epoch, id: manifest.id, sent: false, done }
      pendingRelease = pending
      connect('standby')
      const aborted = () => done.reject(signal!.reason)
      signal?.addEventListener('abort', aborted, { once: true })
      try {
        await done.promise
      } finally {
        signal?.removeEventListener('abort', aborted)
        if (pendingRelease === pending) pendingRelease = undefined
      }
      lastError = undefined
      return { released: true, sent: true }
    } catch (error) {
      progress = undefined
      fail(`Releasing the lease failed; this machine keeps it: ${String(error)}`)
      return { released: false, sent: pending?.sent ?? false }
    }
  }

  /** Release from a serving writer: storage closes, the snapshot goes up, the lease is freed. */
  const release = async (info: JsonObject) => {
    const state = sync?.state()
    if (mode !== 'serving' || state?.role !== 'writer' || state.epoch === undefined) return false
    const key = await secret()
    if (!key) {
      fail(missingKey)
      return false
    }
    autoClaim = false
    await host.deactivate({ ...info, cloud: true }, async () => {})
    const result = await releaseClosed(state.epoch, key, AbortSignal.timeout(MOVE_CAP))
    // Nothing was released: serve again. A release sent but unconfirmed waits for the cloud's next role.
    if (!result.sent) await host.activate()
    return result.released
  }

  const busyTasks = async () => {
    const graph = await host.harness().taskGraph(context)
    try {
      return foreground(graph)
    } finally {
      graph.dispose()
    }
  }
  /** No foreground task runs and no automation is due within the idle threshold. */
  const idle = async (now: number) => {
    if ((await busyTasks()) > 0) return false
    const due = await host.want(AutomationsApi)?.nextDue()
    return due === undefined || due > now + options.idleRelease * 60_000
  }
  // A move's hold occupies the queue; idle checks would only pile up behind it.
  const checkIdle = (now = Date.now()) =>
    holding
      ? Promise.resolve(false)
      : queue(async () => {
          if (mode !== 'serving' || sync?.state().role !== 'writer' || !(await idle(now))) {
            idleSince = undefined
            return false
          }
          idleSince ??= now
          if (now - idleSince < options.idleRelease * 60_000) return false
          idleSince = undefined
          return release({ reason: 'Released · resume here', released: true })
        })

  /** `#12 Review the lease`: the conversations whose foreground runs a move waits for, bounded like worktrees. */
  const runningIn = (graph: Parameters<typeof foregroundTasks>[0]) => {
    const titles = new Map(
      host.conversations().map((summary) => [summary.id, summary.label ?? summary.title]),
    )
    return [...new Set(foregroundTasks(graph).map((task) => task.conversationId))]
      .toSorted((a, b) => a - b)
      .slice(0, LEFT_LIMITS.paths)
      .map((conversation) =>
        `#${conversation} ${titles.get(conversation) ?? ''}`.trim().slice(0, LEFT_LIMITS.path),
      )
  }

  /**
   * A standby asked for the lease for transition `id`. The release holds while foreground tasks run, then while
   * worktrees hold uncommitted changes, however long, reporting each with `release-waiting`: it rechecks on every task
   * graph change and every `HOLD_RECHECK`. A worktree check that fails holds it too, and a run that starts during the
   * check sends it back to waiting for runs. `force` skips every hold and releases at once, naming the dirty worktrees
   * that stay behind. A transition that ends meanwhile, failed or cancelled, stops the wait. @sync, which may have
   * asked, runs in the machine home's own process, so its run never counts here.
   */
  const moveTo = (by: string, id: string, force = false) =>
    queue(async () => {
      if (mode !== 'serving' || sync?.state().role !== 'writer') return false
      // Only this transition's own end counts: roles sent before it was reported may still be on their way.
      const ended = (state: SyncState) => state.transition?.id === id && !!state.transition.error
      const stopped = () => {
        host.notice(`The move to ${by} stopped; this machine keeps the project`)
        return false
      }
      // An unforced move cannot release on worktrees it could not check: the error holds it like dirty ones.
      const scan = (): Promise<{ dirty: string[]; unchecked?: string }> =>
        dirtyWorktrees().then(
          (dirty) => ({ dirty }),
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            if (force) host.notice(`Could not list worktrees with uncommitted changes: ${message}`)
            return { dirty: [], unchecked: clipTo(message, LEFT_LIMITS.path) }
          },
        )
      const graph = await host.harness().taskGraph(context)
      let wake = Promise.withResolvers<void>()
      let cancelled = false
      // Counts task graph changes, so a run that came and went during a scan is noticed.
      let changed = 0
      const unsubscribe = graph.subscribe(() => {
        changed++
        wake.resolve()
      })
      const watch = (state: SyncState) => {
        if (!ended(state)) return
        cancelled = true
        wake.resolve()
      }
      watchers.add(watch)
      const timer = setInterval(() => wake.resolve(), HOLD_RECHECK)
      holding = () => wake.resolve()
      // Each hold is reported once per change.
      let reported = ''
      let dirty: string[] = []
      try {
        for (;;) {
          wake = Promise.withResolvers<void>()
          if (closed || mode !== 'serving') return false
          if (cancelled || ended(sync.state())) return stopped()
          let waiting: { tasks: number; runs?: string[]; dirty?: string[]; held?: boolean }
          let unchecked: string | undefined
          if (!force && foreground(graph) > 0)
            waiting = { tasks: foreground(graph), runs: runningIn(graph) }
          else {
            // Scanned once the drained runs have written theirs, so the target hears which worktrees hold it.
            const before = changed
            ;({ dirty, unchecked } = await scan())
            // The move may have ended while the scan ran.
            if (cancelled || ended(sync.state())) return stopped()
            if (force) break
            // A run that started during the scan holds the move again.
            // A run that started during the scan holds the move again; one that also ended may have changed a
            // worktree the scan had already passed, so the scan runs again.
            if (foreground(graph) > 0 || changed !== before) continue
            if (!dirty.length && !unchecked) break
            waiting = { tasks: 0, dirty, held: true, ...(unchecked ? { unchecked } : {}) }
          }
          const key = JSON.stringify(waiting)
          if (key !== reported) {
            reported = key
            sync.send({ type: 'release-waiting', by, ...waiting })
            host.notice(
              waiting.tasks > 0
                ? `Move to ${by} waits for ${runs(waiting.tasks)}`
                : unchecked
                  ? `Move to ${by} waits: could not check worktrees: ${unchecked}`
                  : `Move to ${by} waits for ${changes(dirty)}`,
            )
          }
          await wake.promise
        }
      } finally {
        holding = undefined
        clearInterval(timer)
        unsubscribe()
        watchers.delete(watch)
        graph.dispose()
      }
      // A forced move names the worktrees that stay behind; a held one clears what it waited for.
      if (dirty.length || reported) sync.send({ type: 'release-waiting', by, tasks: 0, dirty })
      releasingFor = id
      try {
        // The standby page's cloud facet explains the move, and that "Move here" pulls it back.
        return await release({ reason: `Moved to ${by}`, explained: true })
      } finally {
        releasingFor = undefined
      }
    })

  /** The process stops: release within the supervisor's shutdown, or keep the lease and open normally next time. */
  const stopRelease = async () => {
    const state = sync?.state()
    disconnect()
    if (state?.role !== 'writer' || state.epoch === undefined || host.standby()) return
    const key = await secret()
    if (!key) {
      host.notice(`Kept the lease on stop: ${SECRET} is missing.`)
      return
    }
    const signal = AbortSignal.timeout(STOP_BUDGET)
    const info = { reason: 'Released when Ultimate stopped', released: true, cloud: true }
    if (serving()) await host.deactivate(info, async () => {})
    let lock: Awaited<ReturnType<typeof acquireLock>>
    try {
      lock = await acquireLock(join(host.home, 'storage.lock'), { pid: process.pid })
    } catch {
      // A core swap: the next process owns storage and the lease.
      return
    }
    try {
      if (!existsSync(standbyPath)) await writeJson(standbyPath, info)
      const result = await releaseClosed(state.epoch, key, signal)
      // Nothing was released, so the next start opens normally and still holds the lease.
      if (!result.sent) await rm(standbyPath, { force: true })
    } finally {
      disconnect()
      await lock.close()
    }
  }

  // A process starting on standby opens no harness; it is on standby once the server read `standby.json`.
  const onStandby = () => {
    if (closed || mode) return true
    if (!host.standby()) return false
    connect('standby')
    return true
  }
  const wait = setInterval(() => onStandby() && clearInterval(wait), 100)
  if (onStandby()) clearInterval(wait)

  return {
    /** The harness opened (at start or after a claim): sync as the writer. */
    opened() {
      if (!closed) connect('serving')
    },
    /** The harness is about to close: stop syncing before it does. */
    released: disconnect,
    sync: () => sync,
    async state(): Promise<LeaseState> {
      const state = sync?.state()
      const local = await localSecrets()
      const reported = state?.transition
      const transition =
        ran && (!reported || reported.id === ran.id || reported.startedAt < ran.startedAt)
          ? ran
          : reported
      return {
        role: state?.role,
        free: !!state?.free,
        writer: state?.writer,
        missing: missingSecrets(state, local),
        blocked: blocked(state),
        progress,
        ...(transition ? { transition: structuredClone(transition) } : {}),
        ...(ran ? { ran: structuredClone(ran) } : {}),
        ...(state?.project ? { key: state.project.key } : {}),
        login: await loginHere(),
        lastError,
      }
    },
    /**
     * Start taking the project here: prepare, then claim a free lease or have the online writer release it first.
     * `force` continues although secrets are missing; `by` says who started it, this machine's page unless @sync.
     * Resolves the transition ID at once; `move` resolves at its end.
     */
    moveHere({ force = false, by = 'local' }: { force?: boolean; by?: 'local' | 'sync' } = {}) {
      const reason = moving ? 'Another move is preparing' : blocked(sync?.state())
      if (reason) throw new Error(reason)
      const id = randomUUID()
      void move({ id, force, by }).catch(report)
      return { id }
    },
    move,
    /** Stop the preparing move, until its claim is sent. */
    cancel() {
      if (!moving?.transition.cancellable) throw new Error('No move to cancel')
      cancel()
    },
    checkIdle,
    /** Reconnect with a fresh hello, as after a relink. */
    restart() {
      if (mode) connect(mode)
    },
    /** The facet closes; `stopRelease` may still follow for the process. */
    close() {
      closed = true
      clearInterval(wait)
      cancel()
      disconnect()
    },
    /** Lifecycle work queued so far has settled. */
    settled: () => chain,
    stopRelease,
  }
}
export type Lease = ReturnType<typeof startLease>
