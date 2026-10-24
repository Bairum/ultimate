import { mkdtemp, readFile, readdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { pruneUploads, safeFileName, saveUpload, UploadTooLarge } from '../server/uploads.ts'
import { insertAt, quotePath } from '../web/src/components/insert-path.ts'

const home = () => mkdtemp(join(tmpdir(), 'uploads-'))

it('makes macOS screenshot names and traversal attempts safe', () => {
  expect(safeFileName('Screenshot 2026-01-01 at 9.41.12\u202fAM.png')).toBe(
    'Screenshot 2026-01-01 at 9.41.12 AM.png',
  )
  expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd')
  expect(safeFileName('...')).toBe('file')
})

it('saves a file under its conversation and rejects one past the limit', async () => {
  const root = await home()
  const path = await saveUpload(root, 7, 'a b.txt', Readable.from([Buffer.from('hello')]))
  expect(dirname(path)).toBe(join(root, 'uploads', '7'))
  expect(basename(path)).toMatch(/-a b\.txt$/)
  expect(await readFile(path, 'utf8')).toBe('hello')
  await expect(
    saveUpload(root, 8, 'big', Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 10),
  ).rejects.toBeInstanceOf(UploadTooLarge)
  expect(await readdir(join(root, 'uploads', '8'))).toEqual([])
})

it('prunes uploads older than 30 days and their empty folders', async () => {
  const root = await home()
  const old = await saveUpload(root, 1, 'old', Readable.from([Buffer.from('x')]))
  const fresh = await saveUpload(root, 2, 'fresh', Readable.from([Buffer.from('x')]))
  const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  await utimes(old, past, past)
  await pruneUploads(root)
  expect(await readdir(join(root, 'uploads'))).toEqual(['2'])
  expect(await readdir(dirname(fresh))).toEqual([basename(fresh)])
})

it('quotes paths with spaces and inserts them at the cursor', () => {
  expect(quotePath('/tmp/a.png')).toBe('/tmp/a.png')
  expect(quotePath('/tmp/a b.png')).toBe("'/tmp/a b.png'")
  expect(insertAt('look at', 7, 7, '/x')).toEqual({ text: 'look at /x', cursor: 10 })
  expect(insertAt('ab', 1, 1, '/x')).toEqual({ text: 'a /x b', cursor: 4 })
})
