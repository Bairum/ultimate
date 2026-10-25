import { randomUUID } from 'node:crypto'
import { mkdir, readdir, lstat, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const missing = (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
export const teachDirectory = (home: string, conversation: number, segment: string) => {
  if (!/^[a-zA-Z0-9-]+$/.test(segment)) throw new Error('Invalid segment id')
  return join(home, 'computer-use', String(conversation), 'teach', segment)
}
// Review protection is rebuilt from computer.teach on open; it contains no authority or screen data.
const reviews = new Set<string>()
export function protectTeachReview(
  home: string,
  conversation: number,
  segment: string,
  review: boolean,
) {
  const path = teachDirectory(home, conversation, segment)
  if (review) reviews.add(path)
  else reviews.delete(path)
}
async function directories(path: string) {
  return readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (missing(error)) return []
    throw error
  })
}
const PRUNE_INTERVAL_MS = 10 * 60 * 1000
const lastPrune = new Map<string, number>()
/** Thirty days; ordinary evidence 200 MB/conversation, teaching 300 MB/segment, 1 GB globally.
 * Only explicit directory entries are traversed; symlinks are never followed.
 */
export async function pruneEvidence(
  home: string,
  now = Date.now(),
  limit = 200 * 1024 * 1024,
  globalLimit = 1024 * 1024 * 1024,
  { force = false }: { force?: boolean } = {},
) {
  // The scan walks every conversation's evidence: once per interval per home unless a caller needs the caps now.
  const previous = lastPrune.get(home)
  if (!force && previous !== undefined && now - previous < PRUNE_INTERVAL_MS) return
  lastPrune.set(home, now)
  const root = join(home, 'computer-use')
  await mkdir(root, { recursive: true })
  const all: { path: string; size: number; at: number; review?: boolean }[] = []
  for (const folder of await directories(root)) {
    if (!folder.isDirectory() || !/^\d+$/.test(folder.name)) continue
    const directory = join(root, folder.name)
    const groups = [{ path: directory, limit }]
    const teach = (await directories(directory)).find((d) => d.name === 'teach' && d.isDirectory())
    if (teach)
      for (const segment of await directories(join(directory, 'teach'))) {
        if (segment.isDirectory())
          groups.push({ path: join(directory, 'teach', segment.name), limit: 300 * 1024 * 1024 })
      }
    for (const group of groups) {
      const files: typeof all = []
      for (const file of await directories(group.path)) {
        if (!file.isFile() || !file.name.endsWith('.png')) continue
        const path = join(group.path, file.name)
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (missing(error)) return undefined
          throw error
        })
        if (info?.isFile()) files.push({ path, size: info.size, at: info.mtimeMs })
      }
      let total = files.reduce((n, f) => n + f.size, 0)
      for (const file of files.toSorted((a, b) => a.at - b.at)) {
        if (now - file.at <= 30 * 24 * 60 * 60 * 1000 && total <= group.limit) {
          all.push({ ...file, review: reviews.has(group.path) })
          continue
        }
        await rm(file.path, { force: true })
        total -= file.size
      }
    }
  }
  let total = all.reduce((n, file) => n + file.size, 0)
  for (const file of all.toSorted((a, b) => a.at - b.at)) {
    if (file.review) continue
    if (total <= globalLimit) break
    await rm(file.path, { force: true })
    total -= file.size
  }
}
export async function saveEvidence(
  home: string,
  conversation: number,
  png: Buffer,
  segment?: string,
) {
  const directory = segment
    ? teachDirectory(home, conversation, segment)
    : join(home, 'computer-use', String(conversation))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${Date.now()}-${randomUUID()}.png`)
  await writeFile(path, png, { flag: 'wx', mode: 0o600 })
  await pruneEvidence(home, undefined, undefined, undefined, { force: true })
  return path
}
