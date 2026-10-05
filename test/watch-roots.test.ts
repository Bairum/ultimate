import { expect, it, vi } from 'vitest'
import { watchRoots } from '../server/watch-roots.ts'

const fs = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  watch: vi.fn<(path: string, callback: () => void) => { close: () => void }>(),
}))
vi.mock('node:fs', () => fs)

it.each([false, true])('discovers a root created while attaching (reattach: %s)', (reattach) => {
  let present = false
  let change!: () => void
  const close = vi.fn<() => void>()
  let parentPresent = !reattach
  fs.existsSync.mockImplementation((path: string) =>
    path === '/project/extensions' ? present : path === '/project' ? parentPresent : true,
  )
  fs.watch.mockImplementation((_path: string, callback: () => void) => {
    change = callback
    if (!reattach || fs.watch.mock.calls.length === 2) present = true
    return { close }
  })
  const appeared = vi.fn<(root: string) => void>()
  const stop = watchRoots(['/project/extensions'], appeared)
  if (reattach) {
    parentPresent = true
    change()
  }
  expect(appeared).toHaveBeenCalledExactlyOnceWith('/project/extensions')
  stop()
  expect(close).toHaveBeenCalledTimes(reattach ? 2 : 1)
  vi.clearAllMocks()
})

it('keeps the same watcher for sibling activity while detecting root appearance', () => {
  let present = false
  let change!: () => void
  const close = vi.fn<() => void>()
  fs.existsSync.mockImplementation((path) => path !== '/project/extensions' || present)
  fs.watch.mockImplementation((_path, callback) => {
    change = callback
    return { close }
  })
  const appeared = vi.fn<(root: string) => void>()
  const stop = watchRoots(['/project/extensions'], appeared)
  for (let i = 0; i < 2000; i++) change()
  expect(fs.watch).toHaveBeenCalledTimes(1)
  expect(close).not.toHaveBeenCalled()
  expect(appeared).not.toHaveBeenCalled()
  present = true
  change()
  change()
  expect(appeared).toHaveBeenCalledExactlyOnceWith('/project/extensions')
  stop()
  expect(close).toHaveBeenCalledTimes(1)
  vi.clearAllMocks()
})
