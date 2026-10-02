import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { ExtensionHost } from '../../../server/extensions.ts'
import type { CreatedIsolate, Isolate } from './types.ts'
const exec = promisify(execFile)
export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec('git', args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
export async function create(
  parent: string,
  home: string,
  agent: string,
  call: string,
  projectSettings: ExtensionHost['projectSettings'] = async () => ({}),
  signal?: AbortSignal,
) {
  const key = createHash('sha256').update(call).digest('hex')
  const path = await worktreePath(home, key)
  const branch = `ultimate/${agent}-${key.slice(0, 16)}`
  let base: string
  try {
    base = await git(parent, 'rev-parse', 'HEAD')
  } catch {
    throw new Error(`Worktree isolate requires a git repository with a HEAD: ${parent}`)
  }
  const registered = (await git(parent, 'worktree', 'list', '--porcelain'))
    .split('\n')
    .includes(`worktree ${path}`)
  if (!registered) {
    await rm(path, { recursive: true, force: true })
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
    const record = JSON.parse(await readFile(marker, 'utf8')) as Isolate
    return { cwd: record.path, record }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const record: Isolate = { kind: 'worktree', path, branch, base, state: 'active' }
  try {
    await setupWorktree(projectSettings, parent, path, signal)
    await writeFile(`${marker}.tmp`, JSON.stringify(record))
    await rename(`${marker}.tmp`, marker)
  } catch (error) {
    await git(parent, 'worktree', 'remove', '--force', path)
    throw error
  }
  return { cwd: path, record } satisfies CreatedIsolate
}
async function setupWorktree(
  projectSettings: ExtensionHost['projectSettings'],
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
async function worktreePath(home: string, key: string) {
  const directory = join(home, 'worktrees')
  await mkdir(directory, { recursive: true })
  return join(await realpath(directory), key)
}
const locks = new Map<string, Promise<unknown>>()
export async function locked<T>(parent: string, run: () => Promise<T>) {
  parent = await git(parent, 'rev-parse', '--show-toplevel')
  const previous = locks.get(parent) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(run)
  locks.set(parent, operation)
  try {
    return await operation
  } finally {
    if (locks.get(parent) === operation) locks.delete(parent)
  }
}
export const land = (parent: string, record: Isolate) =>
  locked(parent, () => operate(parent, record, 'land'))
export const discard = (parent: string, record: Isolate) =>
  locked(parent, () => operate(parent, record, 'discard'))
export async function operate(parent: string, isolate: Isolate, action: 'land' | 'discard') {
  if (isolate.state === 'discarded') {
    if (action === 'discard') return { text: `Already discarded; kept branch ${isolate.branch}.` }
    throw new Error('Isolate is discarded')
  }
  if (action === 'discard') {
    if (
      (await git(parent, 'worktree', 'list', '--porcelain'))
        .split('\n')
        .includes(`worktree ${join(await realpath(dirname(isolate.path)), basename(isolate.path))}`)
    )
      await git(parent, 'worktree', 'remove', '--force', isolate.path)
    return {
      text: `Discarded isolate; kept branch ${isolate.branch}.`,
      state: 'discarded' as const,
    }
  }
  const head = await git(parent, 'rev-parse', 'HEAD')
  const dirty = await git(isolate.path, 'status', '--porcelain')
  if (dirty) throw new Error(`Worktree is dirty:\n${dirty}`)
  if (!Number(await git(parent, 'rev-list', '--count', `${head}..${isolate.branch}`))) {
    const tip = await git(parent, 'rev-parse', isolate.branch)
    return { text: 'Nothing to land.', ...(tip === isolate.base ? {} : { landed: tip }) }
  }
  try {
    await git(isolate.path, 'rebase', head)
  } catch (error) {
    const conflicts = await git(isolate.path, 'diff', '--name-only', '--diff-filter=U')
    await git(isolate.path, 'rebase', '--abort').catch(() => {})
    throw new Error(
      `Rebase failed: ${conflicts || String(error)}. Message the child to rebase onto ${head} and resolve these files before landing.`,
      { cause: error },
    )
  }
  const commits = await git(isolate.path, 'log', '--oneline', `${head}..HEAD`)
  const paths = (await git(isolate.path, 'diff', '--name-only', head, 'HEAD'))
    .split('\n')
    .filter(Boolean)
  await git(parent, 'merge', '--ff-only', isolate.branch)
  const landed = await git(parent, 'rev-parse', 'HEAD')
  return {
    text: `Landed commits:\n${commits}\nChanged paths:\n${paths.join('\n')}`,
    landed,
    paths,
  }
}
