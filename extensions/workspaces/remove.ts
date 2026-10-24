import { readdir, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'

/**
 * Remove the registered worktree at `path` of `source`. Git refuses, even when the checkout is clean, a worktree with
 * populated submodules or with submodule repositories in its admin dir (`.git/worktrees/<id>/modules`), because
 * removing it deletes those repositories. Only then, and only once `submoduleWork` proves that no submodule holds
 * changes or commits found on no remote, this forces the removal. `git submodule deinit` is no alternative: Git still
 * refuses while the module repositories exist, and deinit in a worktree unsets the submodules in the configuration it
 * shares with the main checkout.
 */
export async function removeWorktree(source: string, path: string) {
  try {
    // English messages: the refusal below is recognised by its text.
    await exec('git', ['worktree', 'remove', path], {
      cwd: source,
      timeout: 30000,
      env: { ...process.env, LC_ALL: 'C' },
    })
    return
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('containing submodules')) throw error
  }
  const work = await submoduleWork(path)
  if (work) throw new Error(`Kept ${path} for its submodules: ${work}`)
  // --force also skips Git's own check of the checkout; repeat it, as plain removal would have refused. `dirty` still
  // shows a moved submodule pointer, staged or not; changes inside the submodules were checked above.
  if (await git(path, 'status', '--porcelain', '--ignore-submodules=dirty'))
    throw new Error(`Kept ${path}: it has uncommitted changes`)
  await git(source, 'worktree', 'remove', '--force', path)
}

/**
 * Why removing the submodules of the checkout at `path` would lose work, or '' when nothing would be lost. Commits
 * count as safe once a remote-tracking ref reaches them; the slow part, counting and fetching, runs before the
 * changes are read, so those are read last, just before removal.
 */
export async function submoduleWork(path: string) {
  const reasons: string[] = []
  const repos = new Map<string, string>()
  const add = async (repo: string, name: string) => {
    const real = await realpath(repo)
    if (!repos.has(real)) repos.set(real, name)
  }
  const populated = (
    await git(path, 'submodule', 'foreach', '--quiet', '--recursive', 'echo "$displaypath"')
  )
    .split('\n')
    .filter(Boolean)
  for (const name of populated) {
    const gitdir = await git(join(path, name), 'rev-parse', '--absolute-git-dir')
    await add(gitdir, name)
    // A submodule with its own .git directory keeps its deinitialised submodules there.
    for (const repo of await moduleRepos(join(gitdir, 'modules')))
      await add(repo, join(name, relative(join(gitdir, 'modules'), repo)))
  }
  const modules = join(await git(path, 'rev-parse', '--absolute-git-dir'), 'modules')
  for (const repo of await moduleRepos(modules)) await add(repo, relative(modules, repo))
  for (const [repo, name] of repos) {
    const count = await unique(repo)
    if (count) reasons.push(`${name} has ${count} commit${count === 1 ? '' : 's'} on no remote`)
  }
  for (const name of populated) {
    const changed = (await git(join(path, name), 'status', '--porcelain'))
      .split('\n')
      .filter(Boolean).length
    if (changed)
      reasons.push(`${name} has ${changed} uncommitted change${changed === 1 ? '' : 's'}`)
  }
  return reasons.join('; ')
}

/** The submodule repositories under a `modules` dir, nested ones included; a name may contain slashes. */
async function moduleRepos(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return []
    },
  )
  const repos: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = join(dir, entry.name)
    const inner = await readdir(child)
    if (inner.includes('HEAD') && inner.includes('objects'))
      repos.push(child, ...(await moduleRepos(join(child, 'modules'))))
    else repos.push(...(await moduleRepos(child)))
  }
  return repos
}

/** Commits of the repository at `gitdir` (its HEAD, branches, tags, stash and reflogs) that no remote-tracking ref reaches. */
async function unique(gitdir: string) {
  const count = async () =>
    Number(
      await git(
        gitdir,
        `--git-dir=${gitdir}`,
        'rev-list',
        '--count',
        'HEAD',
        '--all',
        '--reflog',
        '--not',
        '--remotes',
      ),
    )
  // A tracking ref whose remote branch was since deleted still counts: fetching each repository on every removal
  // to find out would cost more than the case is worth.
  if (!(await count())) return 0
  // Tracking refs go stale once a submodule's remote moves on; refresh them before counting again.
  await exec('git', [`--git-dir=${gitdir}`, 'fetch', '--all', '--no-tags', '--quiet'], {
    cwd: gitdir,
    timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).catch(
    // An unreachable remote only leaves the tracking refs as they were; the commits then count as unique.
    () => undefined,
  )
  return count()
}
