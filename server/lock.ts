import { open, readFile, unlink, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
export async function readOwner(path: string): Promise<{ pid: number; port?: number } | undefined> {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8'))
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid pid')
    return owner
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`Cannot parse Ultimate lock ${path}`, { cause: error })
  }
}
// flock serializes the wx/create and stale-takeover transaction. The kernel releases
// the guard even if a contender crashes; the guard inode is never replaced.
async function guarded<T>(path: string, action: () => Promise<T>) {
  const guard = spawn(
    'flock',
    ['-x', path + '.guard', 'sh', '-c', 'printf ready; cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const exited = once(guard, 'exit')
  await Promise.race([
    once(guard.stdout, 'data'),
    exited.then(() => {
      throw new Error(`Cannot acquire lock guard ${path}`)
    }),
  ])
  try {
    return await action()
  } finally {
    guard.stdin.end()
    await exited
  }
}
export async function acquireLock(path: string, value: { pid: number; port?: number }, waitMs = 0) {
  const deadline = Date.now() + waitMs
  let stale = false
  for (;;) {
    const owner = await guarded(path, async () => {
      const previous = await readOwner(path)
      if (previous && alive(previous.pid)) return previous
      if (previous) {
        const moved = `${path}.${randomUUID()}`
        await rename(path, moved)
        if ((await readOwner(moved))?.pid !== previous.pid)
          throw new Error('Lock changed during stale takeover')
        await unlink(moved)
        stale = true
      }
      const file = await open(path, 'wx')
      try {
        await file.writeFile(JSON.stringify(value))
      } finally {
        await file.close()
      }
      return undefined
    })
    if (!owner)
      return {
        stale,
        async close() {
          await guarded(path, async () => {
            if ((await readOwner(path))?.pid === value.pid) await unlink(path)
          })
        },
        async update(next: typeof value) {
          await guarded(path, async () => {
            const file = await open(path, 'w')
            try {
              await file.writeFile(JSON.stringify(next))
            } finally {
              await file.close()
            }
          })
        },
      }
    if (Date.now() >= deadline)
      throw new Error(
        path.endsWith('/ultimate.lock')
          ? `Ultimate is already running (pid ${owner.pid}) at http://127.0.0.1:${owner.port}`
          : `Ultimate core already owns this storage (pid ${owner.pid})`,
      )
    await pause(50)
  }
}
