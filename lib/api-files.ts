import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** An extension folder as discovery reports it (`host.extensions()`). */
type Folder = { name: string; path: string; enabled: boolean }

/** The first sentence of the doc comment that opens an `api.ts`, or '' without one. */
export function apiSummary(text: string) {
  const header = /^\/\*\*([\s\S]*?)\*\//
    .exec(text.trimStart())?.[1]
    .replace(/^\s*\*\s?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!header) return ''
  return /^.*?[.!?](?=\s|$)/.exec(header)?.[0] ?? header
}

async function read(folder: Folder) {
  try {
    return await readFile(join(folder.path, 'api.ts'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

/** Each enabled extension with an `api.ts`, by name, with the summary of its contract. */
export async function apiSummaries(folders: readonly Folder[]) {
  const found = await Promise.all(
    folders
      .filter((folder) => folder.enabled)
      .map(async (folder) => {
        const text = await read(folder)
        return text === undefined ? [] : [{ name: folder.name, summary: apiSummary(text) }]
      }),
  )
  return found.flat().toSorted((a, b) => a.name.localeCompare(b.name))
}

/** The `api.ts` source of enabled extension `name`; throws naming the ones that have one. */
export async function apiSource(folders: readonly Folder[], name: string) {
  const folder = folders.find((candidate) => candidate.enabled && candidate.name === name)
  const text = folder && (await read(folder))
  if (text !== undefined) return text
  const known = (await apiSummaries(folders)).map((api) => api.name)
  throw new Error(
    `No enabled extension "${name}" with an api.ts; known: ${known.join(', ') || 'none'}`,
  )
}
