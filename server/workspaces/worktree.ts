import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readlink, realpath, rename, stat, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  join,
  resolve as resolvePath,
  relative,
  isAbsolute,
  sep,
} from 'node:path'
import { promisify } from 'node:util'

import type { JsonObject } from '@earendil-works/pi-durable'
import type { Workspace } from '../../shared/protocol.ts'
type ProjectSettings = () => Promise<JsonObject>
const exec = promisify(execFile)
export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec('git', args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolvePath(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Removed workspaces and dangling aliases still retain their physical identity.
    const link = await readlink(absolute).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code !== 'ENOENT' && failure.code !== 'EINVAL') throw failure
      return undefined
    })
    if (link !== undefined) return canonicalPath(resolvePath(dirname(absolute), link))
    return join(await canonicalPath(dirname(absolute)), basename(absolute))
  }
}
export function contains(root: string, path: string) {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}
export async function target(cwd: string): Promise<Pick<Workspace, 'targetBranch' | 'targetHead'>> {
  try {
    return { targetBranch: await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD') }
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error
    return { targetBranch: null, targetHead: await git(cwd, 'rev-parse', 'HEAD') }
  }
}
export async function create(
  parent: string,
  home: string,
  agent: string,
  call: string,
  projectSettings: ProjectSettings = async () => ({}),
  signal?: AbortSignal,
  prepared?: Workspace,
) {
  const key = createHash('sha256').update(call).digest('hex')
  const path = await worktreePath(home, key)
  const branch = `ultimate/${agent}-${key.slice(0, 16)}`
  let base: string
  try {
    base = prepared?.base ?? (await git(parent, 'rev-parse', 'HEAD'))
  } catch {
    throw new Error(`Worktree isolate requires a git repository with a HEAD: ${parent}`)
  }
  const registered = (await git(parent, 'worktree', 'list', '--porcelain'))
    .split('\n')
    .includes(`worktree ${path}`)
  if (!registered) {
    if (await stat(path).catch(() => undefined))
      throw new Error(
        `Unregistered workspace path exists; inspect it before explicit cleanup: ${path}`,
      )
    const branches = await git(parent, 'branch', '--list', branch)
    if (branches) base = await git(parent, 'rev-parse', branch)
    await git(
      parent,
      'worktree',
      'add',
      ...(branches ? [] : ['-b', branch]),
      path,
      branches ? branch : base,
    )
  }
  const marker = join(home, 'worktrees', `${key}.ready`)
  try {
    const record = JSON.parse(await readFile(marker, 'utf8')) as Workspace
    return { cwd: record.path, record }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const record: Workspace = prepared
    ? { ...prepared, preparation: 'ready' }
    : {
        kind: 'worktree',
        path,
        branch,
        base,
        state: 'active',
        source: await realpath(await git(parent, 'rev-parse', '--show-toplevel')),
        ...(await target(parent)),
        preparation: 'ready',
      }
  try {
    await setupWorktree(projectSettings, parent, path, signal)
    await writeFile(`${marker}.tmp`, JSON.stringify(record))
    await rename(`${marker}.tmp`, marker)
  } catch (error) {
    // A failed setup may have valuable untracked output; never force-remove it.
    await git(parent, 'worktree', 'remove', path).catch(() => undefined)
    throw error
  }
  return { cwd: path, record }
}
async function setupWorktree(
  projectSettings: ProjectSettings,
  parent: string,
  path: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const settings = (await projectSettings()) as { isolates?: { worktree?: { setup?: string[] } } }
  const commands = settings.isolates?.worktree?.setup ?? []
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === 'string'))
    throw new Error('isolates.worktree.setup must be an array of command strings')
  for (const command of commands) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'sh',
        ['-c', command],
        {
          cwd: path,
          env: { ...process.env, ULTIMATE_SOURCE: parent },
          signal,
          timeout: 120000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error)
            reject(
              new Error(
                `Worktree setup failed: ${command}\n${`${stdout}${stderr}${error.message}`.slice(-4000)}`,
              ),
            )
          else resolve()
        },
      )
      child.stdin?.end()
    })
  }
}
export async function worktreePath(home: string, key: string) {
  const directory = join(home, 'worktrees')
  await mkdir(directory, { recursive: true })
  return join(await realpath(directory), key)
}
export async function discard(parent: string, isolate: Workspace) {
  if (isolate.state === 'discarded')
    return { text: `Already discarded; kept branch ${isolate.branch}.` }
  if (
    (await git(parent, 'worktree', 'list', '--porcelain'))
      .split('\n')
      .includes(`worktree ${join(await realpath(dirname(isolate.path)), basename(isolate.path))}`)
  )
    await git(parent, 'worktree', 'remove', isolate.path)
  return { text: `Discarded isolate; kept branch ${isolate.branch}.`, state: 'discarded' as const }
}
