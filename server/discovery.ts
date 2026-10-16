import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { discoveryRoots } from './project.ts'
import type { Source } from './project.ts'
import { useProjectSetup } from './project-setup.ts'
import { extensionSettings } from './extension-settings.ts'

const sourceOrder = { builtin: 0, user: 1, project: 2 }

export function compareExtensions(
  a: { name: string; source: Source; order?: number },
  b: { name: string; source: Source; order?: number },
) {
  return (
    (a.order ?? 0) - (b.order ?? 0) ||
    sourceOrder[a.source] - sourceOrder[b.source] ||
    a.name.localeCompare(b.name)
  )
}

export async function discoverExtensions(
  ultimateRoot: string,
  projectRoot: string,
  userHome?: string,
  includeProject = false,
  settings?: Awaited<ReturnType<typeof extensionSettings>>,
) {
  const winners = new Map<
    string,
    { name: string; path: string; source: Source; files: string[]; error?: string }
  >()
  for (const root of discoveryRoots(ultimateRoot, projectRoot, userHome)) {
    if (root.source === 'project' && !includeProject && !useProjectSetup(projectRoot, userHome))
      continue
    const directory = join(root.path, 'extensions')
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return []
      },
    )
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      try {
        if (!(await stat(path)).isDirectory()) continue
        winners.set(entry.name, {
          name: entry.name,
          path,
          source: root.source,
          files: await readdir(path),
        })
      } catch (error) {
        winners.set(entry.name, {
          name: entry.name,
          path,
          source: root.source,
          files: [],
          error: String(error),
        })
      }
    }
  }
  settings ??= await extensionSettings(projectRoot, userHome)
  const { overrides } = settings
  const entries = [...winners.values()]
    .map((entry) => ({
      ...entry,
      enabled: overrides.get(entry.name) ?? true,
    }))
    .toSorted(compareExtensions)
  return Object.assign(entries, { settings })
}
