import { readFile, stat } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { EventToken } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import { compareUrl } from '../../lib/compare.ts'
import { exec } from '../../lib/exec.ts'
import { fastForward, Refusal } from '../../lib/fast-forward.ts'
import type { Git } from '../../lib/fast-forward.ts'
import { githubRepo } from '../../lib/project-identity.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import {
  cloneState,
  fetchIfDue,
  gitPath,
  layersOf,
  SUMMARY_SYSTEM,
  summaryFor,
  withLock,
} from './clone.ts'
import { Applied, DemoAction, Refused, StateAction, UpdateAction } from './refs.ts'
import type { UpdateResult, UpdateState } from './refs.ts'

/** How often the clone is compared with origin locally; origin itself is fetched at most hourly (`FETCH_EVERY`). */
export const TICK = 5 * 60_000

/** Git in `root`, never prompting: an HTTPS fetch without a login must fail rather than hang a background check. */
export const gitIn =
  (root: string): Git =>
  async (...args) => {
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      return (await exec('git', args, { cwd: root, env, timeout: 120_000 })).stdout.trim()
    } catch (error) {
      const { stderr = '' } = error as { stderr?: string }
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || String(error)}`, { cause: error })
    }
  }

const read = (path: string) =>
  readFile(path, 'utf8').catch(
    // A missing lockfile or install reads as absent: no clone of Ultimate lacks both.
    () => undefined,
  )

/** Whether `pnpm-lock.yaml` differs from what pnpm last installed (`node_modules/.pnpm/lock.yaml`). */
export async function installOwed(root: string) {
  const wanted = await read(join(root, 'pnpm-lock.yaml'))
  return wanted !== undefined && wanted !== (await read(join(root, 'node_modules/.pnpm/lock.yaml')))
}

/** Whether packages were installed after `startedAt` (ms): this server still runs the ones before. */
const installedSince = (root: string, startedAt: number) =>
  stat(join(root, 'node_modules/.pnpm/lock.yaml')).then(
    (info) => info.mtimeMs > startedAt,
    () => false,
  )

/** The last output lines of a failed command. */
function tail(error: unknown) {
  const { stdout = '', stderr = '' } = error as {
    stdout?: string
    stderr?: string
  }
  const output = `${stdout}${stderr}`.trim()
  return output ? output.split('\n').slice(-20).join('\n') : String(error)
}

/** What a faux host shows, by demo state; the default is a clone 5 commits behind. */
export function demoState(root: string, state: string, now: number): UpdateState {
  const commits = [
    {
      sha: '0eb16c0',
      subject: 'feat(review): comment on diff lines and send them to an agent',
    },
    {
      sha: 'fadd20a',
      subject: 'feat(cloud): record backups and moves as durable events',
    },
    {
      sha: 'ac9ee15',
      subject: 'feat(coding-tools): record every commit made through bash',
    },
    {
      sha: 'fa5dd27',
      subject: 'perf(prompt): announce a new build in a note on the next input',
    },
    {
      sha: '2b3770c',
      subject: 'feat(questions): an Open questions panel and Dismiss',
    },
  ]
  const base = {
    root,
    branch: 'main',
    fetchedAt: now - 12 * 60_000,
    install: false,
    restart: false,
  }
  const layers = { core: true, bin: false, lockfile: true, live: true }
  const compare = 'https://diffshub.com/HazAT/ultimate/compare/5ef0c6e...0eb16c0'
  if (state === 'current') return { ...base, behind: 0, commits: [] }
  if (state === 'refused')
    return {
      ...base,
      behind: 5,
      commits,
      layers,
      compare,
      refused: 'The checkout has uncommitted changes',
    }
  if (state === 'updated')
    return {
      ...base,
      behind: 0,
      commits: [],
      restart: true,
      updated: {
        ok: true,
        from: '5ef0c6e',
        to: '0eb16c0',
        commits: 5,
        layers: { core: true, bin: true, lockfile: true, live: true },
        install: 'done',
      },
    }
  const summary = [
    'Review surface: comment on diff lines and send them to an agent',
    'Backups and moves now show in the System stream',
    'Open questions stay in a panel until you answer or dismiss them',
  ]
  return { ...base, behind: 5, commits, summary, layers, compare }
}

/** A preview started by another Ultimate's `instance` tool: it shares the clone and must never touch it. */
const preview = () => Boolean(process.env.ULTIMATE_INSTANCE_OWNER)

export default function update(host: ExtensionHost) {
  // Resolved where they are called; declared here so the catalogue lists them.
  host.need(WorkspacesApi)
  host.need(ConversationsApi)
  const shared = state(host)
  // Faux and previews never fetch: the demo stands in, and a preview must not race the host on the same clone.
  if (host.faux || preview()) return defineExtension({ name: 'update' })
  const tick = () => {
    shared.ticking ??= refresh(host, true)
      .catch((error: unknown) => host.notice(`Update check: ${String(error)}`))
      .finally(() => {
        shared.ticking = undefined
      })
  }
  const start = setTimeout(tick, 30_000)
  const timer = setInterval(tick, TICK)
  host.onClose(async () => {
    clearTimeout(start)
    clearInterval(timer)
    await shared.ticking
  })
  return defineExtension({ name: 'update' })
}

type Shared = {
  ticking: Promise<void> | undefined
  updating: Promise<UpdateResult> | undefined
  latest: UpdateState | undefined
  updated: (UpdateResult & { ok: true }) | undefined
  demo: string | undefined
}

/** Shared across reloads: a reload installs the new facet before the old one closes, and only one tick may run. */
const state = (host: ExtensionHost) =>
  host.resource<Shared>('update.state', () => ({
    ticking: undefined,
    updating: undefined,
    latest: undefined,
    updated: undefined,
    demo: undefined,
  }))

/** The clone-wide lock: fetches, updates and installs of one clone never overlap across the Ultimates on it. */
const lockOf = (root: string) => gitPath(gitIn(root), root, 'ultimate-update.lock')

/** Ask the summary model once with the range's commit messages; undefined without one. */
async function ask(host: ExtensionHost, input: string) {
  const conversations = host.need(ConversationsApi)
  const model = await conversations.summaryModel()
  if (!model) return undefined
  const response = await conversations.askSummaryModel(
    host.modelRuntime,
    SUMMARY_SYSTEM,
    input,
    AbortSignal.timeout(60_000),
    { model },
  )
  return response.stopReason === 'stop' ? response.text : undefined
}

/**
 * Compare the clone with origin and keep the result for `state`. A `check` fetches when due and summarizes a new
 * range (once per range, cached in the clone's git directory); a plain refresh only reads.
 */
async function refresh(host: ExtensionHost, check: boolean) {
  const shared = state(host)
  const root = host.ultimateRoot
  const git = gitIn(root)
  const summaryFile = await gitPath(git, root, 'ultimate-update-summary.json')
  /** The summary of the clone's current range; asks the model only with `asking`, else reads the cache. */
  const summarize = async (asking: boolean) => {
    const { head, remoteHead } = await cloneState(git, root)
    if (!remoteHead) return undefined
    return summaryFor(
      summaryFile,
      `${head}..${remoteHead}`,
      () => git('log', '--format=%s%n%n%b', `${head}..${remoteHead}`),
      asking ? (input) => ask(host, input) : undefined,
    )
  }
  // Under the clone's lock the fetch's age and the summary cache are read again, so the Ultimates on one clone fetch
  // and ask the summary model once between them.
  const checked = check
    ? await withLock(await lockOf(root), async () => {
        const error = await fetchIfDue(git, root, Date.now())
        await summarize(true)
        return { error }
      })
    : undefined
  const error = checked ? checked.error : shared.latest?.error
  const clone = await cloneState(git, root)
  const repo = clone.remoteHead ? await githubRepo(root) : undefined
  const startedAt = Date.parse(host.system().process.startedAt)
  const { head, remoteHead, ...rest } = clone
  const summary = await summarize(false)
  shared.latest = {
    root,
    ...rest,
    ...(summary ? { summary } : {}),
    refused: rest.refused ?? (rest.behind ? await landing(host) : undefined),
    ...(error ? { error } : {}),
    ...(repo && remoteHead ? { compare: compareUrl(repo, head, remoteHead) } : {}),
    install: await installOwed(root),
    restart: await installedSince(root, startedAt),
    ...(shared.updated ? { updated: shared.updated } : {}),
  }
  if (!shared.latest.refused) delete shared.latest.refused
}

/** Why an update must wait: the lander is landing into the clone (it fast-forwards the same branch). */
async function landing(host: ExtensionHost) {
  let index
  try {
    index = await host
      .harness()
      .snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, context)
  } catch {
    // Storage is closed (standby, a switch): nothing lands from this home meanwhile.
    return undefined
  }
  const root = await realpath(host.ultimateRoot)
  return index?.queue.some((entry) => entry.source === root && entry.state === 'landing')
    ? 'The lander is landing into this clone'
    : undefined
}

/** Commit one update event on its own: the clone lives outside storage. Only while storage is open. */
async function record<D extends JsonValue>(host: ExtensionHost, event: EventToken<D>, data: D) {
  try {
    await host.harness().commit((tx) => host.emit(tx, event, data), context)
  } catch (error) {
    // Storage is closed (standby, a switch) or the commit failed: the update itself stands, only its record is lost.
    host.notice(`Update event: ${String(error)}`)
  }
}

/**
 * Fast-forward the clone, install when the lockfile is owed (also with nothing to pull, so a failed install is retried),
 * and record what happened. Holds the clone-wide lock throughout.
 */
async function run(host: ExtensionHost): Promise<UpdateResult> {
  const root = host.ultimateRoot
  const refuse = async (refused: string): Promise<UpdateResult> => {
    await record(host, Refused, { root, reason: refused })
    return { ok: false, refused }
  }
  const result = await withLock(await lockOf(root), () => apply(host, refuse))
  return result ?? refuse('Another Ultimate is updating this clone')
}

async function apply(
  host: ExtensionHost,
  refuse: (refused: string) => Promise<UpdateResult>,
): Promise<UpdateResult> {
  const root = host.ultimateRoot
  const git = gitIn(root)
  let moved
  try {
    // The landing check runs again right before the merge, after the fetch. A landing that starts after it is safe:
    // the lander fast-forwards only from the base it merged onto, sees the moved branch and retries.
    moved = await fastForward(git, undefined, () => landing(host))
  } catch (error) {
    if (error instanceof Refusal) return refuse(error.message)
    throw error
  }
  const files =
    moved.before === moved.after ? '' : await git('diff', '--name-only', moved.before, moved.after)
  const layers = layersOf(files.split('\n').filter(Boolean))
  let install: 'done' | 'failed' | 'skipped' = 'skipped'
  let installError: string | undefined
  // Owed while the lockfile differs from the installed one: a failed install is retried by the next update.
  if (await installOwed(root))
    try {
      await exec('pnpm', ['install', '--frozen-lockfile'], {
        cwd: root,
        timeout: 10 * 60_000,
      })
      install = 'done'
    } catch (error) {
      install = 'failed'
      installError = tail(error)
    }
  const result = {
    ok: true as const,
    from: moved.before.slice(0, 7),
    to: moved.after.slice(0, 7),
    commits: moved.behind,
    layers,
    install,
    ...(installError ? { installError } : {}),
  }
  if (moved.behind || install !== 'skipped') state(host).updated = result
  if (moved.behind) {
    await record(host, Applied, {
      root,
      from: moved.before,
      to: moved.after,
      commits: moved.behind,
      layers,
      install,
    })
  }
  return result
}

export const userActions = ['update', 'demo']

export const actions = {
  /** The clone's update state from the last check; a faux host answers its demo. */
  state: implementAction(StateAction, async (_args, { host }) => {
    const shared = state(host)
    if (host.faux) return demoState(host.ultimateRoot, shared.demo ?? 'behind', Date.now())
    if (preview())
      return { root: host.ultimateRoot, behind: 0, commits: [], install: false, restart: false }
    if (!shared.latest) await refresh(host, false)
    return shared.latest!
  }),
  update: implementAction(UpdateAction, async (_args, { host }): Promise<UpdateResult> => {
    const shared = state(host)
    if (host.faux) {
      shared.demo = (shared.demo ?? 'behind') === 'refused' ? 'refused' : 'updated'
      const demo = demoState(host.ultimateRoot, shared.demo, Date.now())
      return demo.updated ?? { ok: false, refused: demo.refused! }
    }
    if (preview()) return { ok: false, refused: 'A preview never updates the clone it runs from' }
    // One update at a time: a second click joins the first.
    shared.updating ??= run(host).finally(() => {
      shared.updating = undefined
    })
    const result = await shared.updating
    await refresh(host, false)
    return result
  }),
  demo: implementAction(DemoAction, (args, { host }) => {
    if (!host.faux) throw new Error('demo runs only under faux')
    const value = typeof args === 'object' && args && !Array.isArray(args) ? args.state : undefined
    if (value !== 'behind' && value !== 'refused' && value !== 'updated' && value !== 'current')
      throw new Error('state must be behind, refused, updated or current')
    state(host).demo = value
    return demoState(host.ultimateRoot, value, Date.now())
  }),
}
