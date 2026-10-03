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
export async function discard(parent: string, isolate: Isolate) {
  if (isolate.state === 'discarded')
    return { text: `Already discarded; kept branch ${isolate.branch}.` }
  if (
    (await git(parent, 'worktree', 'list', '--porcelain'))
      .split('\n')
      .includes(`worktree ${join(await realpath(dirname(isolate.path)), basename(isolate.path))}`)
  )
    await git(parent, 'worktree', 'remove', '--force', isolate.path)
  return { text: `Discarded isolate; kept branch ${isolate.branch}.`, state: 'discarded' as const }
}
