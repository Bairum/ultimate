import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const maxUploadBytes = 50 * 1024 * 1024
const keepMs = 30 * 24 * 60 * 60 * 1000

/** A file name safe to write and to paste into a prompt: plain spaces, no separators, no leading dots. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, ' ')
    .replace(/[/\\:\p{Cc}"'`$]/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim()
  const points = Array.from(cleaned)
  if (points.length <= 120) return cleaned || 'file'
  const extension = /\.[^.]{1,15}$/u.exec(cleaned)?.[0] ?? ''
  const suffix = Array.from(extension)
  return points.slice(0, 120 - suffix.length).join('') + extension
}

/** Streams `source` into `<home>/uploads/<conversation>/<stamp>-<name>`, rejecting it past `limit` bytes. */
export async function saveUpload(
  home: string,
  conversation: number,
  name: string,
  source: AsyncIterable<Buffer> & NodeJS.ReadableStream,
  limit = maxUploadBytes,
): Promise<string> {
  const folder = join(home, 'uploads', String(conversation))
  await mkdir(folder, { recursive: true })
  const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  const path = join(folder, `${stamp}-${safeFileName(name)}`)
  let size = 0
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length
      done(size > limit ? new UploadTooLarge() : undefined, chunk)
    },
  })
  const destination = createWriteStream(path, { flags: 'wx' })
  let created = false
  destination.once('open', () => {
    created = true
  })
  try {
    await pipeline(source, cap, destination)
  } catch (failure) {
    if (created) await rm(path, { force: true })
    throw failure
  }
  return path
}

export class UploadTooLarge extends Error {
  constructor() {
    super('File exceeds 50 MiB')
  }
}

/** Deletes uploads older than 30 days and the conversation folders they leave empty. */
export async function pruneUploads(home: string, now = Date.now()) {
  const root = join(home, 'uploads')
  const folders = await readdir(root).catch(() => [] as string[]) // no uploads yet
  for (const folder of folders) {
    const dir = join(root, folder)
    const files = await readdir(dir).catch(() => [] as string[]) // a stray file, not a folder
    let left = files.length
    for (const file of files) {
      const path = join(dir, file)
      // A file removed between the listing and the stat has nothing left to prune.
      const info = await stat(path).catch(() => undefined)
      if (info && now - info.mtimeMs > keepMs) {
        await rm(path, { force: true })
        left--
      }
    }
    if (left === 0)
      await rmdir(dir).catch(() => {
        // A fresh upload may have arrived, or another prune already removed the folder.
      })
  }
}
