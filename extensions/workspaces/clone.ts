import type { JsonObject } from '@earendil-works/pi-durable'
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'

export type CloneMode = 'auto' | 'apfs' | 'reflink' | 'git'
const modes: CloneMode[] = ['auto', 'apfs', 'reflink', 'git']

/** The `isolates.worktree.clone` setting: how a new worktree's files are made. */
export function cloneMode(settings: JsonObject): CloneMode {
  const mode =
    (settings as { isolates?: { worktree?: { clone?: unknown } } }).isolates?.worktree?.clone ??
    'auto'
  if (!modes.includes(mode as CloneMode))
    throw new Error(`isolates.worktree.clone must be one of ${modes.join(', ')}`)
  return mode as CloneMode
}

/** The copy-on-write backend to try for `mode` on this platform, or none for a plain checkout. */
export function backend(mode: CloneMode, platform = process.platform): 'apfs' | 'reflink' | null {
  if (mode !== 'auto') return mode === 'git' ? null : mode
  return platform === 'darwin' ? 'apfs' : platform === 'linux' ? 'reflink' : null
}

/**
 * Fill the worktree at `path`, registered with `git worktree add --no-checkout`, from the `source` checkout. With a
 * copy-on-write backend every entry of the source but `.git` and its submodules is cloned, ignored files such as
 * `node_modules` included, the source index is copied for its stat cache, and `git reset --hard` and `git clean -fd`
 * then bring tracked and untracked files to the worktree's HEAD; only files that differ take new blocks. When cloning
 * fails, `auto` falls back to a plain checkout and an explicit backend throws. Returns the backend used.
 *
 * Adapted from oh-my-pi's worktree cloning (https://github.com/can1357/oh-my-pi, MIT, crates/pi-iso and
 * crates/pi-vcs/src/git/mutate.rs): per-entry clones that skip `.git` and special files, the copied index, the
 * refusal under sparse checkout or split index, and the fallback to a plain checkout.
 */
export async function populate(source: string, path: string, mode: CloneMode) {
  await clear(path)
  const kind = backend(mode)
  if (kind) {
    try {
      await clone(source, path, kind)
      await git(path, 'reset', '--hard', '--quiet', 'HEAD')
      // The second -f also drops untracked nested repositories.
      await git(path, 'clean', '-ffdq')
      return kind
    } catch (error) {
      if (mode !== 'auto') throw error
      console.warn(`Worktree clone failed, checking out instead: ${(error as Error).message}`)
      await clear(path)
    }
  }
  await git(path, 'reset', '--hard', '--quiet', 'HEAD')
  return 'git' as const
}

/** Empty the worktree at `path` but its `.git` file, index included. */
async function clear(path: string) {
  for (const entry of await readdir(path))
    if (entry !== '.git') await rm(join(path, entry), { recursive: true, force: true })
  await rm(await gitPath(path, 'index'), { force: true })
}

async function clone(source: string, path: string, kind: 'apfs' | 'reflink') {
  for (const key of ['core.sparseCheckout', 'core.splitIndex'])
    if ((await git(source, 'config', '--bool', key).catch(() => 'false')) === 'true')
      throw new Error(`Cannot clone a checkout with ${key} enabled`)
  // `git submodule status` lists each submodule's path; their `.git` files point into the source's module store,
  // which two checkouts must not share, so they stay out of the clone.
  const submodules = (await git(source, 'submodule', 'status').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/)[1])
  // A directory holding a submodule deeper down is entered rather than cloned whole, so only the submodule stays out.
  const copy = async (relative: string) => {
    await mkdir(join(path, relative), { recursive: true })
    for (const entry of await readdir(join(source, relative))) {
      const name = join(relative, entry)
      if (name === '.git' || submodules.includes(name)) continue
      const stat = await lstat(join(source, name))
      if (stat.isDirectory() && submodules.some((module) => module.startsWith(`${name}/`))) {
        await copy(name)
        continue
      }
      // Sockets, fifos and devices belong to running processes; clonefile refuses them.
      if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) continue
      await exec(
        'cp',
        kind === 'apfs'
          ? ['-c', '-R', '-P', join(source, name), join(path, name)]
          : ['-R', '-P', '--reflink=always', join(source, name), join(path, name)],
        { timeout: 600_000 },
      )
    }
  }
  await copy('')
  await copyFile(await gitPath(source, 'index'), await gitPath(path, 'index')).catch(
    (error: NodeJS.ErrnoException) => {
      // A repository without commits staged has no index; reset builds one.
      if (error.code !== 'ENOENT') throw error
    },
  )
}

async function gitPath(checkout: string, name: string) {
  const path = await git(checkout, 'rev-parse', '--git-path', name)
  return isAbsolute(path) ? path : join(checkout, path)
}
