import { randomUUID } from 'node:crypto'
import { mkdir, lstat, readdir, rm, chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const missing = (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
async function entries(path: string) {
  return readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (missing(error)) return []
    throw error
  })
}
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory()) throw new Error('Unsafe evidence directory')
  await chmod(path, 0o700)
}
export async function resultsDirectory(home: string, conversation: number) {
  if (!Number.isSafeInteger(conversation) || conversation < 1)
    throw new Error('Invalid conversation')
  const root = join(home, 'codex-computer')
  await privateDirectory(root)
  const directory = join(root, String(conversation))
  await privateDirectory(directory)
  return directory
}

// Codex can plant entries inside its conversation folder, not replace that folder or its parents.
// Parent swaps require the user's own privileges. Never descend into planted directories or symlinks.
/** Only numeric conversation directories and regular image files; never traverse symlinks. */
export async function pruneEvidence(
  home: string,
  now = Date.now(),
  limit = 200 * 1024 * 1024,
  globalLimit = 1024 * 1024 * 1024,
) {
  const root = join(home, 'codex-computer')
  if (!(await lstat(root)).isDirectory()) throw new Error('Unsafe evidence root')
  const all: { path: string; size: number; at: number }[] = []
  for (const folder of await entries(root)) {
    if (!folder.isDirectory() || !/^\d+$/.test(folder.name)) continue
    const directory = join(root, folder.name)
    if (!(await lstat(directory)).isDirectory()) continue
    const files: typeof all = []
    for (const file of await entries(directory)) {
      if (!file.isFile() || !/\.(png|jpe?g|webp)$/.test(file.name)) continue
      const path = join(directory, file.name)
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (missing(error)) return undefined
        throw error
      })
      if (info?.isFile()) files.push({ path, size: info.size, at: info.mtimeMs })
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files.toSorted((a, b) => a.at - b.at)) {
      if (now - file.at <= 30 * 24 * 60 * 60 * 1000 && total <= limit) all.push(file)
      else {
        // Non-recursive rm removes a replacement link itself, never its target.
        await rm(file.path, { force: true })
        total -= file.size
      }
    }
  }
  let total = all.reduce((sum, file) => sum + file.size, 0)
  for (const file of all.toSorted((a, b) => a.at - b.at)) {
    if (total <= globalLimit) break
    await rm(file.path, { force: true })
    total -= file.size
  }
}
/** The image type its bytes prove, whatever the payload declares. */
export function imageType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { mimeType: 'image/png', extension: 'png' }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return { mimeType: 'image/jpeg', extension: 'jpeg' }
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return { mimeType: 'image/webp', extension: 'webp' }
  return undefined
}
/** Saves PNG, JPEG or WebP evidence; returns undefined for any other bytes, so the run carries on. */
export async function saveImage(home: string, conversation: number, data: string) {
  const bytes = Buffer.from(data, 'base64')
  const type = imageType(bytes)
  if (!type) return undefined
  const directory = await resultsDirectory(home, conversation)
  const path = join(directory, `${Date.now()}-${randomUUID()}.${type.extension}`)
  // Exclusive creation refuses any planted destination, including symlinks.
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  await pruneEvidence(home)
  return { path, mimeType: type.mimeType }
}
