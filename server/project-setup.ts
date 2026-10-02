import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'

export function projectDecision(projectRoot: string, userHome = homedir()) {
  const root = realpathSync(resolve(projectRoot))
  const entry = new ProjectTrustStore(join(userHome, '.ultimate')).getEntry(root)
  return entry?.path === root ? entry.decision : null
}

export function useProjectSetup(projectRoot: string, userHome?: string) {
  return projectDecision(projectRoot, userHome) === true
}

export async function projectSetup(projectRoot: string, userHome?: string) {
  const root = join(projectRoot, '.ultimate')
  const config = ['extensions', 'agents', 'skills', 'settings.json'].some((name) =>
    existsSync(join(root, name)),
  )
  const readme = await readFile(join(root, 'README.md')).then(
    (text) => text.subarray(0, 16 * 1024).toString('utf8'),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    },
  )
  return { config, decision: projectDecision(projectRoot, userHome), ...(readme ? { readme } : {}) }
}
