import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
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
    .slice(0, 120)
  return cleaned || 'file'
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
  const path = join(folder, `${Date.now().toString(36)}-${safeFileName(name)}`)
  let size = 0
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length
      done(size > limit ? new UploadTooLarge() : undefined, chunk)
    },
  })
  try {
    await pipeline(source, cap, createWriteStream(path, { flags: 'wx' }))
  } catch (failure) {
    await rm(path, { force: true })
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
    if (left === 0) await rm(dir, { recursive: true, force: true })
  }
}
