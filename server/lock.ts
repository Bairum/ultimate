import { readFile, writeFile, unlink, rename } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
export async function retireStorageOwner(path: string) {
  try {
    const probe = await acquireLock(path, { pid: process.pid })
    await probe.close()
    return
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Ultimate core already owns'))
      throw error
  }
  const owner = await readOwner(path)
  if (!owner || !alive(owner.pid)) return
  let command: string
  try {
    command = await readFile(`/proc/${owner.pid}/cmdline`, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !alive(owner.pid)) return
    throw new Error(`Cannot verify storage owner pid ${owner.pid}; refusing to signal it`, {
      cause: error,
    })
  }
  if (!command.split('\0').some((arg) => /(?:^|\/)server\/main\.ts$/.test(arg)))
    throw new Error(`Storage owner pid ${owner.pid} is not an Ultimate core; refusing to signal it`)
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(owner.pid, name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        throw new Error(`Cannot signal Ultimate core pid ${owner.pid}`, { cause: error })
    }
  }
  signal('SIGTERM')
  const deadline = Date.now() + 10000
  while (alive(owner.pid) && Date.now() < deadline) await pause(50)
  if (alive(owner.pid)) signal('SIGKILL')
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
export async function acquireLock(path: string, value: { pid: number; port?: number }, waitMs = 0) {
  const deadline = Date.now() + waitMs
  const database = new DatabaseSync(path + '.db')
  database.exec('PRAGMA busy_timeout = 0')
  async function update(next: typeof value) {
    const temporary = `${path}.${value.pid}`
    try {
      await writeFile(temporary, JSON.stringify(next))
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  try {
    for (;;) {
      try {
        database.exec('BEGIN EXCLUSIVE')
        break
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error
        let owner = await readOwner(path)
        if (!owner) {
          await pause(50)
          owner = await readOwner(path)
        }
        if (Date.now() >= deadline)
          throw new Error(
            path.endsWith('/ultimate.lock')
              ? `Ultimate is already running (pid ${owner?.pid ?? 'unknown'}) at http://127.0.0.1:${owner?.port ?? 'unknown'}`
              : `Ultimate core already owns this storage (pid ${owner?.pid ?? 'unknown'})`,
            { cause: error },
          )
        await pause(50)
      }
    }
    const stale = Boolean(await readOwner(path))
    await update(value)
    return {
      stale,
      update,
      async close() {
        try {
          // Remove our sidecar before releasing the transaction, never a successor's.
          if ((await readOwner(path))?.pid === value.pid) await unlink(path)
        } finally {
          database.exec('ROLLBACK')
          database.close()
        }
      },
    }
  } catch (error) {
    database.close()
    throw error
  }
}
