import { spawn } from 'node:child_process'
import type { ChildProcessByStdio, SpawnOptions } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { exec } from './exec.ts'

/** The program cannot start until its pid is recorded; a parent that dies before go gives EOF instead. */
export const handshake = 'read -r _ || exit 1; exec "$0" "$@"'

export type GroupProcess = ChildProcessByStdio<Writable, Readable, Readable>

/**
 * Start `program` as the leader of its own process group, held behind the handshake until `pidFile` (when given)
 * names it. `exec` keeps the pid and group, and the program gets an empty stdin. A failed pid write throws; the held
 * process then reads EOF and exits without running.
 */
export function spawnGroup(
  program: string,
  args: string[],
  options: Omit<SpawnOptions, 'detached' | 'stdio'> & { pidFile?: string },
): GroupProcess {
  const { pidFile, ...rest } = options
  const child = spawn('/bin/sh', ['-c', handshake, program, ...args], {
    ...rest,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {
    // A process that exits before reading go closes the pipe; its exit reports what happened.
  })
  if (child.pid === undefined) return child
  try {
    if (pidFile) writeFileSync(pidFile, `${child.pid}\n`)
  } catch (error) {
    child.stdin.end()
    throw error
  }
  child.stdin.end('\n')
  return child
}

/** Whether any process of group `pid` still exists. */
export function groupAlive(pid?: number) {
  if (!pid) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

/** The pid a pid file names, or undefined when there is none. */
export async function readPidFile(path: string) {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const pid = Number(text.trim())
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid pid file ${path}`)
  return pid
}

/** When process `pid` started, in epoch milliseconds (to about a second), or undefined when it is gone. */
async function startedAt(pid: number) {
  if (process.platform === 'darwin') {
    const { stdout } = await exec('ps', ['-o', 'lstart=', '-p', String(pid)]).catch(
      // ps exits 1 when the pid is gone.
      () => ({ stdout: '' }),
    )
    return stdout.trim() ? Date.parse(stdout.trim()) : undefined
  }
  let line: string
  try {
    line = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  // Field 22 is the start time in clock ticks since boot (USER_HZ, 100 on Linux); the name before it may hold spaces.
  const ticks = Number(line.slice(line.lastIndexOf(')') + 2).split(' ')[19])
  const boot = Number(/^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))?.[1])
  return boot * 1000 + ticks * 10
}

/**
 * Whether group `pid` still runs and is the one recorded at `recordedAt`: a leader that started after its pid file
 * was written is a recycled pid. While the group exists its pid is never reused, so a leader that is gone but whose
 * group remains is still ours.
 */
async function ours(pid: number, recordedAt?: number) {
  if (!groupAlive(pid)) return false
  if (recordedAt === undefined) return true
  const started = await startedAt(pid)
  // The start time is precise to about a second; a recycled pid needs a whole pid-space wrap after the write.
  return started === undefined || started <= recordedAt + 1500
}

async function send(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(-pid, name)
  } catch (error) {
    // The group may exit between the check and the signal.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/**
 * Stop the whole group `pid`: TERM, KILL after `grace` ms, then wait until no process of it is left (and `exited`,
 * the caller's own exit promise, settled). With `pidFile`, a pid that file names is only signalled while it is the
 * recorded process, and the file is removed once the group is gone. Rejects when the group survives KILL.
 */
export async function stopGroup(
  pid: number,
  options: { pidFile?: string; grace?: number; exited?: Promise<unknown> } = {},
) {
  const { pidFile, grace = 3000, exited } = options
  const recordedAt =
    pidFile && (await readPidFile(pidFile)) === pid ? (await stat(pidFile)).mtimeMs : undefined
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms
    while ((await ours(pid, recordedAt)) && Date.now() < deadline) await sleep(20)
  }
  if (await ours(pid, recordedAt)) await send(pid, 'SIGTERM')
  await wait(grace)
  if (await ours(pid, recordedAt)) await send(pid, 'SIGKILL')
  await exited
  await wait(3000)
  if (await ours(pid, recordedAt)) throw new Error(`Process group ${pid} did not exit`)
  // Never erase a pid file that names a replacement process.
  if (pidFile && (await readPidFile(pidFile)) === pid) await rm(pidFile, { force: true })
}

/**
 * Run `program` as a recorded process group to its end and resolve its exit code (128 + signal number when a signal
 * ended it). An abort of `signal`, and the leader's exit, stop whatever remains of the group; the pid file goes with it.
 */
export async function runGroup(
  program: string,
  args: string[],
  options: {
    cwd: string
    pidFile: string
    signal?: AbortSignal
    grace?: number
    onOutput: (text: string) => void
  },
) {
  const { signal, grace, onOutput, ...spawnOptions } = options
  await mkdir(dirname(options.pidFile), { recursive: true })
  const child = spawnGroup(program, args, spawnOptions)
  // The leader's exit gives the code; its output ends only when every process holding the pipes is gone.
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, name) =>
      resolve(code ?? (name ? 128 + (osConstants.signals[name] ?? 0) : 1)),
    )
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', onOutput)
  }
  const stop = () =>
    child.pid === undefined
      ? Promise.resolve()
      : stopGroup(child.pid, { pidFile: options.pidFile, grace, exited: closed })
  let stopping: Promise<void> | undefined
  const halt = () => {
    stopping ??= stop()
  }
  signal?.addEventListener('abort', halt, { once: true })
  if (signal?.aborted) halt()
  try {
    const code = await exited
    // A finished leader can leave background children in its group; nothing of a run outlives it.
    halt()
    await stopping
    return code
  } finally {
    signal?.removeEventListener('abort', halt)
  }
}

/** Stop every group that a `*.pid` file in `directory` names: what a crash left behind. */
export async function sweepPidFiles(directory: string) {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names.filter((file) => file.endsWith('.pid'))) {
    const pidFile = join(directory, name)
    const pid = await readPidFile(pidFile)
    if (pid) await stopGroup(pid, { pidFile })
  }
}
