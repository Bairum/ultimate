/**
 * The packages of the Ultimate clone the host runs from: whether its lockfile is installed, installing it under the
 * clone-wide lock, and the gate every extension reload, web build and restart waits for (`host.onBeforeLoad`).
 *
 * Core tier, so turning an optional extension off never turns the gate off. Origin: on 2026-11-13 landing 1e338e7 moved
 * Pi 1.5.0 → 1.5.2 while the gate lived in the optional `update` extension, which this machine had disabled; every host
 * on the clone hot-reloaded against the old packages and advisor, conversations and workspaces failed to load (#116515).
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
// oxlint-disable-next-line no-restricted-imports -- the core's process-safe lock, shared with update, secrets and tailscale
import { acquireLock } from '../../server/lock.ts'

export type InstallResult = { install: 'done' | 'failed' | 'skipped'; installError?: string }

type Host = Pick<ExtensionHost, 'ultimateRoot' | 'resource' | 'notice' | 'reloadExtensions'>

/** How long a load waits for git to finish writing the checkout; a lock left by a crashed git must not block forever. */
const CHECKOUT_WAIT = 60_000
/** How long an install waits for another Ultimate's install on the clone: as long as an install may take. */
const INSTALL_WAIT = 10 * 60_000

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

const gitPaths = new Map<string, Promise<string | undefined>>()
/**
 * `name` inside the clone's git directory, shared by every Ultimate on the clone; undefined outside git. Cached per
 * process: while reloads are held, each page request asks the gate again.
 */
function gitPath(root: string, name: string) {
  const key = `${root}\0${name}`
  let path = gitPaths.get(key)
  if (!path) {
    path = git(root, 'rev-parse', '--git-path', name).then(
      (found) => (isAbsolute(found) ? found : join(root, found)),
      // Not a git checkout: nothing moves its files under us, and no other Ultimate shares a lock with it.
      () => undefined,
    )
    gitPaths.set(key, path)
  }
  return path
}

type Shared = {
  installing: Promise<InstallResult | undefined> | undefined
  /** The lockfile whose install failed, and why; until an install succeeds. */
  failed: { lockfile: string | undefined; error: string } | undefined
}

/** Shared across reloads: a reload installs the new facet before the old one closes, and only one install may run. */
const state = (host: Host) =>
  host.resource<Shared>('workspaces.packages', () => ({ installing: undefined, failed: undefined }))

/** Whether an install is owed: the lockfile differs from the installed packages, or the last install failed. */
export async function owed(host: Host) {
  return !!state(host).failed || (await installOwed(host.ultimateRoot))
}

/** The last output lines of a failed command. */
function tail(error: unknown) {
  const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
  const output = `${stdout}${stderr}`.trim()
  return output ? output.split('\n').slice(-20).join('\n') : String(error)
}

/**
 * Install the lockfile's packages under the clone-wide lock when they differ from the installed ones or the last install
 * failed (pnpm can write the installed lockfile and still fail after it); undefined when another Ultimate still held the
 * lock after `INSTALL_WAIT`. A failure is remembered with its lockfile. Calls while one runs join it. After a success,
 * reloads held by an earlier failure go on.
 */
export function install(host: Host): Promise<InstallResult | undefined> {
  const shared = state(host)
  const root = host.ultimateRoot
  shared.installing ??= (async () => {
    const lock = await gitPath(root, 'ultimate-update.lock')
    const held = lock ? await acquireLock(lock, { pid: process.pid }, INSTALL_WAIT) : undefined
    try {
      // Read again under the lock: another Ultimate may just have installed it.
      if (!shared.failed && !(await installOwed(root))) return { install: 'skipped' as const }
      const lockfile = await read(join(root, 'pnpm-lock.yaml'))
      const id = createHash('sha256')
        .update(lockfile ?? '')
        .digest('hex')
        .slice(0, 8)
      host.notice(`Installing packages for lockfile ${id}; extensions reload once it is done`)
      try {
        await exec('pnpm', ['install', '--frozen-lockfile'], { cwd: root, timeout: 10 * 60_000 })
      } catch (error) {
        const installError = tail(error)
        shared.failed = { lockfile, error: installError }
        host.notice(
          `pnpm install failed for lockfile ${id}: extension reloads are held until Retry`,
        )
        return { install: 'failed' as const, installError }
      }
      const recovered = !!shared.failed
      shared.failed = undefined
      host.notice(`Packages installed for lockfile ${id}`)
      // Reloads held since the failure load what changed meanwhile. Not awaited: the reload waits for this very install.
      if (recovered)
        host
          .reloadExtensions()
          .catch((error: unknown) => host.notice(`Reload after install: ${String(error)}`))
      return { install: 'done' as const }
    } finally {
      await held?.close()
    }
  })()
    .catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Ultimate core already owns'))
        return undefined
      throw error
    })
    .finally(() => {
      shared.installing = undefined
    })
  return shared.installing
}

/**
 * Settle once the clone at `host.ultimateRoot` can be loaded from: git is done writing its checkout (a fast-forward holds
 * `index.lock` until every file is written) and the packages its lockfile names are installed, installing them when
 * they are owed. Read from disk, never from an event, so every Ultimate on the clone waits the same way whoever moved it:
 * the lander, an update, another Ultimate, a pull by hand. Throws when the install failed, and at once again for the
 * same lockfile until an explicit `install` (Retry). A throw holds reloads and web builds (`server/extensions.ts`).
 */
export async function loadable(host: Host): Promise<void> {
  const shared = state(host)
  const root = host.ultimateRoot
  const index = await gitPath(root, 'index.lock')
  const deadline = Date.now() + CHECKOUT_WAIT
  if (index) while (existsSync(index) && Date.now() < deadline) await sleep(50)
  const failure = (error: string) =>
    new Error(`pnpm install failed, so the packages on disk are not the lockfile's:\n${error}`)
  // Before comparing lockfiles: a failed install may have left them equal. Tried again for another lockfile only.
  const failed = shared.failed
  if (failed && failed.lockfile === (await read(join(root, 'pnpm-lock.yaml'))))
    throw failure(failed.error)
  if (!failed && !shared.installing && !(await installOwed(root))) return
  const result = await install(host)
  if (!result) throw new Error('Another Ultimate is still installing packages into this clone')
  if (result.install === 'failed') throw failure(result.installError!)
}
