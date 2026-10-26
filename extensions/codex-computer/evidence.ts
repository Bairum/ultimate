import { randomUUID } from 'node:crypto'
import { mkdir, lstat, readdir, realpath, rm, chmod, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

const unavailable = (error: NodeJS.ErrnoException) =>
  ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code ?? '')

/** Canonical paths only: a replaced root or parent symlink must not redirect evidence operations. */
async function confinedDirectory(root: string, directory: string) {
  try {
    if (!(await lstat(directory)).isDirectory()) return undefined
    const actual = await realpath(directory)
    if (actual !== directory || (actual !== root && !actual.startsWith(root + sep)))
      return undefined
    return actual
  } catch (error) {
    // Missing or swapped directories are skipped, never traversed through their replacement.
    if (unavailable(error as NodeJS.ErrnoException)) return undefined
    throw error
  }
}
async function entries(root: string, directory: string) {
  const path = await confinedDirectory(root, directory)
  if (!path) return []
  return readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (unavailable(error)) return []
    throw error
  })
}
async function privateDirectory(root: string, path: string) {
  if (path !== root && !(await confinedDirectory(root, dirname(path))))
    throw new Error('Unsafe evidence parent')
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await confinedDirectory(root, path))) throw new Error('Unsafe evidence directory')
  await chmod(path, 0o700)
}
export async function resultsDirectory(home: string, conversation: number) {
  if (!Number.isSafeInteger(conversation) || conversation < 1)
    throw new Error('Invalid conversation')
  const root = join(await realpath(home), 'codex-computer')
  await privateDirectory(root, root)
  const directory = join(root, String(conversation))
  await privateDirectory(root, directory)
  return directory
}

/** Re-resolve the parent immediately before unlinking; skip anything no longer confined to the root. */
async function removeEvidence(root: string, path: string) {
  const directory = await confinedDirectory(root, dirname(path))
  if (!directory) return false
  await rm(join(directory, basename(path)), { force: true })
  return true
}

/** Only numeric conversation directories and regular PNG files; never traverse symlinks. */
export async function pruneEvidence(
  home: string,
  now = Date.now(),
  limit = 200 * 1024 * 1024,
  globalLimit = 1024 * 1024 * 1024,
) {
  // Anchor to the canonical home, not a root symlink that may have replaced the evidence directory.
  const root = join(await realpath(home), 'codex-computer')
  const all: { path: string; size: number; at: number }[] = []
  for (const folder of await entries(root, root)) {
    if (!folder.isDirectory() || !/^\d+$/.test(folder.name)) continue
    const directory = join(root, folder.name)
    const files: typeof all = []
    for (const file of await entries(root, directory)) {
      if (!file.isFile() || !file.name.endsWith('.png')) continue
      if (!(await confinedDirectory(root, directory))) break
      const path = join(directory, file.name)
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (unavailable(error)) return undefined
        throw error
      })
      if (info?.isFile()) files.push({ path, size: info.size, at: info.mtimeMs })
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files.toSorted((a, b) => a.at - b.at)) {
      if (now - file.at <= 30 * 24 * 60 * 60 * 1000 && total <= limit) all.push(file)
      else if (await removeEvidence(root, file.path)) total -= file.size
    }
  }
  let total = all.reduce((sum, file) => sum + file.size, 0)
  for (const file of all.toSorted((a, b) => a.at - b.at)) {
    if (total <= globalLimit) break
    if (await removeEvidence(root, file.path)) total -= file.size
  }
}
export async function saveImage(home: string, conversation: number, data: string) {
  const png = Buffer.from(data, 'base64')
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Computer Use returned a non-PNG image')
  const directory = await resultsDirectory(home, conversation)
  const root = join(await realpath(home), 'codex-computer')
  const confined = await confinedDirectory(root, directory)
  if (!confined) throw new Error('Unsafe evidence directory')
  const path = join(confined, `${Date.now()}-${randomUUID()}.png`)
  await writeFile(path, png, { flag: 'wx', mode: 0o600 })
  await pruneEvidence(home)
  return path
}
