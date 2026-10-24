import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** A JSON file's value, `fallback` when the file is missing; other read and parse errors throw. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return fallback
  }
}

/**
 * Write two-space JSON with a trailing newline through a same-directory temporary file, synced to disk, and an atomic
 * rename; `mode` sets the new file's permissions, such as 0o600 for a file only its owner may read.
 */
export async function writeJson(path: string, value: unknown, { mode }: { mode?: number } = {}) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', mode)
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

const writes = new Map<string, Promise<void>>()
/** Read (`read` validates), change and write a JSON file, one change at a time per path. */
export async function updateJson<T>(
  path: string,
  read: (path: string) => Promise<T>,
  modify: (value: T) => void,
) {
  const operation = (writes.get(path) ?? Promise.resolve())
    .catch(() => {
      // The previous caller receives its failure; later writes must still run.
    })
    .then(async () => {
      const value = await read(path)
      modify(value)
      await writeJson(path, value)
    })
  writes.set(path, operation)
  try {
    await operation
  } finally {
    if (writes.get(path) === operation) writes.delete(path)
  }
}
