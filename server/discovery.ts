import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { discoveryRoots } from './project.ts'
import type { Source } from './project.ts'

export async function discoverExtensions(
  ultimateRoot: string,
  projectRoot: string,
  userHome?: string,
) {
  const winners = new Map<
    string,
    { name: string; path: string; source: Source; files: string[]; error?: string }
  >()
  for (const root of discoveryRoots(ultimateRoot, projectRoot, userHome)) {
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
  return [...winners.values()].toSorted((a, b) => a.name.localeCompare(b.name))
}
