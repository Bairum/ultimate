import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const missing = (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
/** Thirty days, 200 MB per conversation and 1 GB globally, always oldest first. */
export async function pruneEvidence(
  home: string,
  now = Date.now(),
  limit = 200 * 1024 * 1024,
  globalLimit = 1024 * 1024 * 1024,
) {
  const root = join(home, 'computer-use')
  await mkdir(root, { recursive: true })
  const all: { path: string; size: number; at: number }[] = []
  const folders = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (missing(error)) return []
      throw error
    },
  )
  for (const folder of folders) {
    if (!folder.isDirectory() || !/^\d+$/.test(folder.name)) continue
    const directory = join(root, folder.name)
    // Another prune or user cleanup may remove an entry between listing and stat/unlink.
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (missing(error)) return []
      throw error
    })
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith('.png'))
        .map(async (name) => {
          const path = join(directory, name)
          const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
            if (missing(error)) return undefined
            throw error
          })
          return info ? { path, size: info.size, at: info.mtimeMs } : undefined
        }),
    )
    const files = entries.filter((entry) => entry !== undefined).toSorted((a, b) => a.at - b.at)
    let total = files.reduce((n, file) => n + file.size, 0)
    for (const file of files) {
      if (now - file.at <= 30 * 24 * 60 * 60 * 1000 && total <= limit) {
        all.push(file)
        continue
      }
      await rm(file.path, { force: true })
      total -= file.size
    }
  }
  let total = all.reduce((n, file) => n + file.size, 0)
  for (const file of all.toSorted((a, b) => a.at - b.at)) {
    if (total <= globalLimit) break
    await rm(file.path, { force: true })
    total -= file.size
  }
}
export async function saveEvidence(home: string, conversation: number, png: Buffer) {
  const directory = join(home, 'computer-use', String(conversation))
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${Date.now()}-${randomUUID()}.png`)
  await writeFile(path, png, { flag: 'wx', mode: 0o600 })
  await pruneEvidence(home)
  return path
}
