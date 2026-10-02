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
  fs.existsSync.mockImplementation((path: string) => path !== '/project/extensions' || present)
  fs.watch.mockImplementation((_path: string, callback: () => void) => {
    change = callback
    if (!reattach || fs.watch.mock.calls.length === 2) present = true
    return { close }
  })
  const appeared = vi.fn<(root: string) => void>()
  const stop = watchRoots(['/project/extensions'], appeared)
  if (reattach) change()
  expect(appeared).toHaveBeenCalledExactlyOnceWith('/project/extensions')
  stop()
  expect(close).toHaveBeenCalledTimes(reattach ? 2 : 1)
  vi.clearAllMocks()
})
