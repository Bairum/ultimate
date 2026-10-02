import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { JsonObject } from '@earendil-works/pi-durable'

const errors = new Map<string, string>()
export function projectDiagnostics(projectRoot: string, userHome = homedir()) {
  projectDecision(projectRoot, userHome)
  const error = errors.get(join(userHome, '.ultimate/trust.json'))
  return error ? [error] : []
}

export async function projectSettings(
  projectRoot: string,
  userHome: string,
  report: (message: string) => void = () => {},
): Promise<JsonObject> {
  if (!useProjectSetup(projectRoot, userHome)) return {}
  try {
    const value = JSON.parse(await readFile(join(projectRoot, '.ultimate/settings.json'), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Project settings must be a JSON object')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(String(error))
    return {}
  }
}

export function projectDecision(projectRoot: string, userHome = homedir()) {
  const root = realpathSync(resolve(projectRoot))
  const path = join(userHome, '.ultimate/trust.json')
  try {
    const entry = new ProjectTrustStore(join(userHome, '.ultimate')).getEntry(root)
    errors.delete(path)
    return entry?.path === root ? entry.decision : null
  } catch (error) {
    errors.set(path, String(error))
    return null
  }
}

export function useProjectSetup(projectRoot: string, userHome?: string) {
  return projectDecision(projectRoot, userHome) === true
}

export async function projectSetup(projectRoot: string, userHome?: string) {
  const root = join(projectRoot, '.ultimate')
  const config = ['extensions', 'agents', 'skills', 'settings.json'].some((name) =>
    existsSync(join(root, name)),
  )
  const readme = await readFile(join(root, 'README.md'), 'utf8').then(
    (text) =>
      Array.from(text)
        .slice(0, 16 * 1024)
        .join(''),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    },
  )
  return { config, decision: projectDecision(projectRoot, userHome), ...(readme ? { readme } : {}) }
}
