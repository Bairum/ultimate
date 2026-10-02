import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, realpath, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { acquireLock } from './lock.ts'

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
  if (
    projectRoot !== ultimateRoot ||
    existsSync(join(home, 'state.sqlite')) ||
    !existsSync(join(legacy, 'state.sqlite'))
  )
    return false
  const supervisor = await acquireLock(join(legacy, 'ultimate.lock'), { pid: process.pid })
  try {
    const storage = await acquireLock(join(legacy, 'storage.lock'), { pid: process.pid })
    try {
      if (existsSync(join(home, 'state.sqlite')) || !existsSync(join(legacy, 'state.sqlite')))
        return false
      await mkdir(home, { recursive: true })
      for (const file of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'screenshots']) {
        if (existsSync(join(legacy, file))) await rename(join(legacy, file), join(home, file))
      }
      return true
    } finally {
      await storage.close()
    }
  } finally {
    await supervisor.close()
  }
}
