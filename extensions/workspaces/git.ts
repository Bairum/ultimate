import { execFile } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { JsonObject } from '@earendil-works/pi-durable'

const exec = promisify(execFile)
export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec('git', args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
export const noRepository = 'Isolation needs a Git repository'
export const noCommit = 'Isolation needs a first commit'
/** Whether the repository holding `cwd` (or `cwd` itself, outside Git) has nothing in it but `.git`. */
export async function empty(cwd: string) {
  const top = await git(cwd, 'rev-parse', '--show-toplevel').catch(
    // Outside Git the folder itself is what a new repository would hold.
    () => cwd,
  )
  return (await readdir(top)).every((name) => name === '.git')
}
/** The checkout and branch an isolate of `cwd` would branch from, or why there is none. */
export async function isolatable(
  cwd: string,
): Promise<{ source: string; target: string } | { reason: string }> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel').catch(
    // Outside Git there is nothing to branch from; the reason says so.
    () => undefined,
  )
  if (!top) return { reason: noRepository }
  const source = await realpath(top)
  const target = await git(source, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  if (!target) return { reason: 'Isolation needs a checked-out branch' }
  if (!(await git(source, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(() => '')))
    return { reason: noCommit }
  return { source, target }
}
export async function setup(
  source: string,
  path: string,
  settings: JsonObject,
  signal: AbortSignal,
) {
  const commands =
    (settings as { isolates?: { worktree?: { setup?: string[] } } }).isolates?.worktree?.setup ?? []
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === 'string'))
    throw new Error('isolates.worktree.setup must be an array of command strings')
  for (const command of commands) {
    signal.throwIfAborted()
    try {
      const pending = exec('sh', ['-c', command], {
        cwd: path,
        env: { ...process.env, ULTIMATE_SOURCE: source },
        signal,
        timeout: 120000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      })
      pending.child.stdin?.end()
      await pending
    } catch (error) {
      const output = error as Error & { stdout?: string; stderr?: string }
      throw new Error(
        `Worktree setup failed: ${command}\n${`${output.stdout ?? ''}${output.stderr ?? ''}${output.message}`.slice(-4000)}`,
        { cause: error },
      )
    }
  }
}
