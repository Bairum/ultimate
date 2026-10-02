import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { discoveryRoots } from './project.ts'
import type { Source } from './project.ts'
import { useProjectSetup } from './project-setup.ts'
import { DEFAULT_EXTENSIONS, extensionSettings } from './extension-settings.ts'

export async function discoverExtensions(
  ultimateRoot: string,
  projectRoot: string,
  userHome?: string,
  includeProject = false,
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
  const { overrides } = await extensionSettings(projectRoot, userHome)
  return [...winners.values()]
    .map((entry) => ({
      ...entry,
      enabled:
        overrides.get(entry.name) ??
        (entry.source !== 'builtin' || DEFAULT_EXTENSIONS.some((name) => name === entry.name)),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}
