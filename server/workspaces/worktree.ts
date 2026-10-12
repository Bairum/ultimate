import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readlink, realpath, rename, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  join,
  resolve as resolvePath,
  relative,
  isAbsolute,
  sep,
} from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'

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
export function requestName(request: string) {
  return `w-${createHash('sha256').update(request).digest('hex').slice(0, 10)}`
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
  const name = requestName(call)
  const defaultPath = await worktreePath(home, name)
  const legacyMarker = join(dirname(defaultPath), `${key}.ready`)
  const legacyPrepared =
    prepared?.path === join(dirname(defaultPath), key) &&
    prepared.branch === `ultimate/${agent}-${key.slice(0, 16)}`
  let marker = legacyMarker
  let saved: (Workspace & { request?: string }) | undefined
  try {
    saved = JSON.parse(await readFile(marker, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (!legacyPrepared) {
      marker = join(dirname(defaultPath), `${name}.ready`)
      try {
        saved = JSON.parse(await readFile(marker, 'utf8'))
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure
      }
    }
  }
  // Persisted identities, including old long names, are authoritative on resume.
  const path = prepared?.path ?? saved?.path ?? defaultPath
  const branch = prepared?.branch ?? saved?.branch ?? `ultimate/${name}`
  let base: string
  let source: string
  try {
    base = prepared?.base ?? saved?.base ?? (await git(parent, 'rev-parse', 'HEAD'))
    source = await realpath(await git(parent, 'rev-parse', '--show-toplevel'))
  } catch {
    throw new Error(`Worktree isolate requires a git repository with a HEAD: ${parent}`)
  }
  const conflict = () =>
    new Error(`Workspace ownership conflict: ${path} (${branch}); marker ${marker}`)
  if (saved) {
    const legacy =
      marker === legacyMarker &&
      saved.request === undefined &&
      saved.path === join(dirname(defaultPath), key) &&
      (prepared !== undefined || saved.branch === `ultimate/${agent}-${key.slice(0, 16)}`)
    if (
      (!legacy && saved.request !== call) ||
      saved.path !== path ||
      saved.branch !== branch ||
      saved.base !== base ||
      saved.source !== source ||
      saved.kind !== 'worktree' ||
      saved.state !== 'active' ||
      (saved.preparation !== 'pending' && saved.preparation !== 'ready')
    )
      throw conflict()
  }
  if (
    prepared &&
    (prepared.source !== source ||
      prepared.state !== 'active' ||
      (saved &&
        (prepared.targetBranch !== saved.targetBranch || prepared.targetHead !== saved.targetHead)))
  )
    throw conflict()
  if (!contains(dirname(defaultPath), await canonicalPath(path))) throw conflict()
  const registered = (await git(parent, 'worktree', 'list', '--porcelain'))
    .split('\n\n')
    .find((entry) => entry.split('\n').includes(`worktree ${path}`))
  if (registered) {
    if (
      (!saved && !legacyPrepared) ||
      !registered.split('\n').includes(`branch refs/heads/${branch}`)
    )
      throw conflict()
  } else {
    if (
      await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      })
    )
      throw new Error(
        `Unregistered workspace path exists; inspect it before explicit cleanup: ${path}`,
      )
    // A retained or unrelated branch is never adopted, even after a failed setup.
    if (await git(parent, 'branch', '--list', branch)) throw conflict()
    if (saved?.preparation === 'ready') throw conflict()
  }
  const record: Workspace = prepared
    ? { ...prepared, preparation: 'ready' }
    : {
        kind: 'worktree',
        path,
        branch,
        base,
        state: 'active',
        source,
        ...(saved
          ? { targetBranch: saved.targetBranch, targetHead: saved.targetHead }
          : await target(parent)),
        preparation: 'ready',
      }
  if (saved?.preparation === 'ready') return { cwd: path, record }
  const temporary = `${marker}.tmp`
  const checkpoint = await lstat(temporary).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (checkpoint) {
    if (!checkpoint.isFile() || !registered || saved?.preparation !== 'pending') throw conflict()
    const complete = JSON.parse(await readFile(temporary, 'utf8'))
    if (!isDeepStrictEqual(complete, JSON.parse(JSON.stringify({ ...record, request: call }))))
      throw conflict()
    // Setup already finished; recover only the exact owned publication checkpoint.
    signal?.throwIfAborted()
    await rename(temporary, marker)
    return { cwd: path, record }
  }
  if (!saved) {
    // Claim the full request identity before Git mutation, so interrupted add/setup can resume.
    await writeFile(marker, JSON.stringify({ ...record, preparation: 'pending', request: call }), {
      flag: 'wx',
    })
  }
  if (!registered) await git(parent, 'worktree', 'add', '-b', branch, path, base)
  try {
    await setupWorktree(projectSettings, parent, path, signal)
  } catch (error) {
    // A failed setup may have valuable untracked output; never force-remove it.
    await git(parent, 'worktree', 'remove', path).catch(() => undefined)
    throw error
  }
  await writeFile(temporary, JSON.stringify({ ...record, request: call }), { flag: 'wx' })
  await rename(temporary, marker)
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
