import { afterEach, expect, it, vi } from 'vitest'
import { open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { copyTeachingImage } from '../extensions/computer-use/evidence-files.ts'
import { removeTemps, temp } from './helpers.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn<typeof fs.open>(fs.open) }
})
afterEach(removeTemps)
async function files() {
  const home = await temp()
  const source = join(home, 'frame.png')
  const destination = join(home, 'copy.png')
  const privateFile = join(home, 'private.txt')
  await writeFile(source, 'approved frame')
  await writeFile(privateFile, 'private contents')
  return { source, destination, privateFile }
}

it('copies the regular source image privately without modifying its source', async () => {
  const { source, destination } = await files()
  await copyTeachingImage(source, destination)
  expect(await readFile(destination, 'utf8')).toBe('approved frame')
  expect(await readFile(source, 'utf8')).toBe('approved frame')
  expect((await stat(destination)).mode & 0o777).toBe(0o600)
})
it('does not follow a source symlink swapped in between lstat and open', async () => {
  const { source, destination, privateFile } = await files()
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    await rm(source)
    await symlink(privateFile, source)
    return fs.open(...args)
  })
  await expect(copyTeachingImage(source, destination)).rejects.toMatchObject({ code: 'ELOOP' })
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(privateFile, 'utf8')).toBe('private contents')
})
it('fstat refuses a different regular inode swapped in after lstat', async () => {
  const { source, destination, privateFile } = await files()
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    await rename(privateFile, source)
    return fs.open(...args)
  })
  await expect(copyTeachingImage(source, destination)).rejects.toThrow('changed before copying')
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})
