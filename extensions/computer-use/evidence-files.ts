import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Evidence has the same 30-day lifetime as uploads; each conversation is also bounded to 200 MB. */
export async function pruneEvidence(home: string, now = Date.now(), limit = 200 * 1024 * 1024) {
  const root = join(home, 'computer-use')
  await mkdir(root, { recursive: true })
  for (const folder of await readdir(root, { withFileTypes: true })) {
    if (!folder.isDirectory() || !/^\d+$/.test(folder.name)) continue
    const directory = join(root, folder.name)
    const files = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith('.png'))
        .map(async (name) => {
          const path = join(directory, name)
          const info = await stat(path)
          return { path, size: info.size, at: info.mtimeMs }
        }),
    )
    let total = files.reduce((n, file) => n + file.size, 0)
    for (const file of files.toSorted((a, b) => a.at - b.at)) {
      if (now - file.at <= 30 * 24 * 60 * 60 * 1000 && total <= limit) continue
      await unlink(file.path)
      total -= file.size
    }
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
