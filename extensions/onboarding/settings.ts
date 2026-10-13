import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { JsonObject } from '@earendil-works/pi-durable'

/** A settings file's JSON object; a missing file is empty. */
export async function readSettings(path: string): Promise<JsonObject> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return '{}'
  })
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Settings must be a JSON object')
  return value
}

/** Write two-space JSON with a trailing newline through a same-directory temporary file and an atomic rename. */
export async function save(path: string, value: JsonObject) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

const writes = new Map<string, Promise<void>>()
/** Read, change and save a settings file, one change at a time per path, preserving other keys. */
export async function updateSettings(path: string, modify: (value: JsonObject) => void) {
  const operation = (writes.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const value = await readSettings(path)
      modify(value)
      await save(path, value)
    })
  writes.set(path, operation)
  try {
    await operation
  } finally {
    if (writes.get(path) === operation) writes.delete(path)
  }
}
