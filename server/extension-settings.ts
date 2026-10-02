import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_EXTENSIONS = [
  'agent',
  'coding-tools',
  'prompt',
  'models',
  'status-line',
  'notices',
  'theme',
  'faux',
  'codemode',
  'browser',
] as const

export function extensionSettingsFiles(projectRoot: string, userHome = homedir()) {
  return [join(userHome, '.ultimate/settings.json'), join(projectRoot, '.ultimate/settings.json')]
}

export async function extensionSettings(projectRoot: string, userHome?: string) {
  const overrides = new Map<string, boolean>()
  const contents: (string | null)[] = []
  const notices: string[] = []
  for (const path of extensionSettingsFiles(projectRoot, userHome)) {
    let content: string | null = null
    try {
      content = await readFile(path, 'utf8')
      const settings = JSON.parse(content)
      if (!settings || typeof settings !== 'object' || Array.isArray(settings))
        throw new Error('Settings must be a JSON object')
      for (const [key, enabled] of [
        ['enable', true],
        ['disable', false],
      ] as const) {
        const names = settings.extensions?.[key]
        if (names === undefined) continue
        if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
          throw new Error(`extensions.${key} must be an array of names`)
        for (const name of names) overrides.set(name, enabled)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        notices.push(`${path}: ${String(error)}`)
    }
    contents.push(content)
  }
  return { overrides, contents, notices }
}
