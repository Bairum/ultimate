// `pnpm test`: the fast suite. A full run (no file filter) first takes the machine-wide test lock in ~/.ultimate, so
// the lander's and every branch's full runs on this machine go one at a time instead of starving each other; a run
// with file filters starts at once. The lock is an exclusive SQLite transaction (`server/lock.ts`): it dies with the
// process, so a crashed or killed run frees it. Usage: pnpm test [vitest args…]. See docs/running.md.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseCLI } from 'vitest/node'
import { acquireLock, readOwner } from '../server/lock.ts'

const args = process.argv.slice(2)
// Vitest's own parser tells file filters from option values (`--maxWorkers 2`, `--run test/x.test.ts`).
const full = parseCLI(['vitest', ...args]).filter.length === 0
const directory = join(homedir(), '.ultimate')
const path = join(directory, 'test.lock')

let lock: Awaited<ReturnType<typeof acquireLock>> | undefined
if (full) {
  mkdirSync(directory, { recursive: true })
  const value = { pid: process.pid, project: process.cwd() }
  for (let waited = false; !lock; waited = true) {
    try {
      lock = await acquireLock(path, value, waited ? 30000 : 0)
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Ultimate core already owns')))
        throw error
      // Repeated every 30 s: tells the user who holds it, and the output keeps the lander's stall watchdog quiet.
      const owner = await readOwner(path)
      console.log(
        `Waiting for the machine-wide test lock ${path}: held by pid ${owner?.pid ?? 'unknown'}${owner?.project ? ` in ${owner.project}` : ''}`,
      )
    }
  }
}

const child = spawn('vp', ['test', ...args], {
  stdio: 'inherit',
  env: { ...process.env, MIMALLOC_ALLOW_THP: '0', MIMALLOC_PURGE_DELAY: '0' },
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
const code = await new Promise<number>((resolve) =>
  child.on('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0))),
)
await lock?.close()
process.exit(code)
