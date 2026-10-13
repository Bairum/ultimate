import { access, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { removeTemp, removeTemps, temp } from './helpers.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rm: vi.fn<typeof fs.rm>(fs.rm) }
})

it('removes nested fixture directories through their roots without overlapping deletions', async () => {
  const parent = await temp('ultimate-cleanup-')
  const child = await temp('source-', parent)
  const grandchild = await temp('source-', child)
  const sibling = await temp('ultimate-cleanup-')
  await writeFile(join(grandchild, 'fixture'), 'fixture')
  await writeFile(join(sibling, 'fixture'), 'fixture')
  vi.mocked(rm).mockClear()

  await removeTemps()

  expect(vi.mocked(rm).mock.calls.map(([path]) => path)).toEqual([parent, sibling])
  await expect(access(parent)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(sibling)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not delete explicitly cleaned homes or their source copies again at file cleanup', async () => {
  const parent = await temp('ultimate-cleanup-')
  await temp('source-', parent)
  vi.mocked(rm).mockClear()

  await removeTemp(parent)
  await removeTemps()

  expect(rm).toHaveBeenCalledTimes(1)
  expect(vi.mocked(rm).mock.calls[0][0]).toBe(parent)
  await expect(access(parent)).rejects.toMatchObject({ code: 'ENOENT' })
})
