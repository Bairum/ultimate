import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readStore, validateName, validateValue } from '../../lib/secrets.ts'
// oxlint-disable-next-line no-restricted-imports -- secret writes use the shared cross-process file lock
import { acquireLock } from '../../server/lock.ts'

/** Set or (without `value`) remove a secret under the shared file lock, writing the store atomically with mode 600. */
export async function writeSecret(userHome: string, name: string, value?: string) {
  validateName(name)
  if (value !== undefined) validateValue(value)
  const directory = join(userHome, '.ultimate')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const path = join(directory, 'secrets.json')
  const lock = await acquireLock(path + '.lock', { pid: process.pid }, 120000)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const store = await readStore(userHome)
    const updatedAt = new Date().toISOString()
    if (value === undefined) delete store.secrets[name]
    else store.secrets[name] = { value, updatedAt }
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(store))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    return { name, set: value !== undefined, ...(value === undefined ? {} : { updatedAt }) }
  } finally {
    await rm(temporary, { force: true })
    await lock.close()
  }
}
