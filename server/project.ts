import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, realpath, rename, writeFile, unlink } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { acquireLock, retireStorageOwner } from './lock.ts'

export type Source = 'builtin' | 'user' | 'project'
export function discoveryRoots(ultimateRoot: string, projectRoot: string, userHome = homedir()) {
  return [
    { source: 'builtin' as const, path: ultimateRoot },
    { source: 'user' as const, path: join(userHome, '.ultimate') },
    { source: 'project' as const, path: join(projectRoot, '.ultimate') },
  ]
}
export function projectHome(projectRoot: string, userHome = homedir()) {
  const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 8)
  return join(userHome, '.ultimate', 'projects', `${basename(projectRoot)}-${hash}`)
}
export async function resolveProject(directory: string) {
  return realpath(directory)
}
export async function migrateProject(
  ultimateRoot: string,
  projectRoot: string,
  userHome = homedir(),
) {
  const legacy = join(userHome, '.ultimate')
  const home = projectHome(projectRoot, userHome)
  const pending = join(home, 'migration.pending')
  if (
    projectRoot !== ultimateRoot ||
    (!existsSync(join(legacy, 'state.sqlite')) && !existsSync(pending))
  )
    return false
  const supervisor = await acquireLock(join(legacy, 'ultimate.lock'), { pid: process.pid })
  try {
    await retireStorageOwner(join(legacy, 'storage.lock'))
    const storage = await acquireLock(join(legacy, 'storage.lock'), { pid: process.pid })
    try {
      if (!existsSync(pending) && existsSync(join(home, 'state.sqlite'))) return false
      await mkdir(home, { recursive: true })
      if (existsSync(join(legacy, 'state.sqlite'))) {
        const database = new DatabaseSync(join(legacy, 'state.sqlite'))
        try {
          const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!
          if (checkpoint.busy !== 0) throw new Error('Legacy database checkpoint is busy')
        } finally {
          database.close()
        }
        await writeFile(pending, '')
        await rename(join(legacy, 'state.sqlite'), join(home, 'state.sqlite'))
      }
      if (existsSync(join(legacy, 'screenshots')))
        await rename(join(legacy, 'screenshots'), join(home, 'screenshots'))
      await unlink(pending)
      return true
    } finally {
      await storage.close()
    }
  } finally {
    await supervisor.close()
  }
}
