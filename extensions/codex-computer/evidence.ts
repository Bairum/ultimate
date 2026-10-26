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

/** Only numeric conversation directories and regular PNG files; never traverse symlinks. */
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
      if (!file.isFile() || !file.name.endsWith('.png')) continue
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
export async function saveImage(home: string, conversation: number, data: string) {
  const png = Buffer.from(data, 'base64')
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Computer Use returned a non-PNG image')
  const directory = await resultsDirectory(home, conversation)
  const path = join(directory, `${Date.now()}-${randomUUID()}.png`)
  await writeFile(path, png, { flag: 'wx', mode: 0o600 })
  await pruneEvidence(home)
  return path
}
