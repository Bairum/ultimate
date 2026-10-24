import type { JsonObject } from '@earendil-works/pi-durable'
import { copyFile, lstat, mkdir, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative as relativePath, resolve } from 'node:path'
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
  const common = await realpath(await gitPath(source, '--common'))
  const guard = async () => {
    const top = await git(path, 'rev-parse', '--show-toplevel')
    if (
      (await realpath(top)) !== (await realpath(path)) ||
      (await realpath(await gitPath(path, '--common'))) !== common
    )
      throw new Error(`Unsafe worktree repository: ${path}`)
  }
  await guard()
  await clear(path)
  let reason: string | undefined
  const kind = backend(mode)
  if (kind) {
    try {
      await clone(source, path, kind)
    } catch (error) {
      if (mode !== 'auto') throw error
      reason = (error as Error).message
      await guard()
      await clear(path)
    }
  }
  await guard()
  await git(path, 'reset', '--hard', '--quiet', 'HEAD')
  if (kind && !reason) {
    // The second -f also drops untracked nested repositories.
    await guard()
    await git(path, 'clean', '-ffdq')
  }
  return { backend: reason ? ('git' as const) : (kind ?? ('git' as const)), reason }
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
  // Gitlinks stay out: their .git files point into the source's module store.
  const submodules = (await git(source, 'ls-files', '-s', '-z'))
    .split('\0')
    .filter((entry) => entry.startsWith('160000 '))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1))
  // Walk directories to exclude nested submodules and source-pointing absolute symlinks.
  const copy = async (relative: string) => {
    await mkdir(join(path, relative), { recursive: true })
    for (const entry of await readdir(join(source, relative))) {
      const name = join(relative, entry)
      if (name === '.git' || submodules.includes(name)) continue
      const stat = await lstat(join(source, name))
      if (stat.isSymbolicLink()) {
        const target = await readlink(join(source, name))
        const inside = relativePath(resolve(source), resolve(target))
        if (
          isAbsolute(target) &&
          inside !== '..' &&
          !inside.startsWith('../') &&
          !isAbsolute(inside)
        )
          continue
      }
      if (stat.isDirectory()) {
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
  const path = await git(
    checkout,
    'rev-parse',
    ...(name === '--common' ? ['--git-common-dir'] : ['--git-path', name]),
  )
  return isAbsolute(path) ? path : join(checkout, path)
}
