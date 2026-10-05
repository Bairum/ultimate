import { EventEmitter } from 'node:events'
import type { ViteDevServer } from 'vite-plus'
import { expect, it, vi } from 'vitest'
import { extensionModules } from '../server/vite-extensions.ts'

const roots = vi.hoisted(() => ({ stop: [] as ReturnType<typeof vi.fn>[] }))
vi.mock('../server/watch-roots.ts', () => ({
  watchRoots: () => {
    const stop = vi.fn<() => void>()
    roots.stop.push(stop)
    return stop
  },
}))

function server() {
  return {
    watcher: Object.assign(new EventEmitter(), { add: vi.fn<() => void>() }),
    environments: { client: {} },
  }
}

it('closes the old environment watchers, not the replacement watchers, during restart', async () => {
  const plugin = extensionModules('/ultimate', '/project', '/user')
  const configure = plugin.configureServer
  const close = plugin.closeBundle
  if (typeof configure !== 'function' || typeof close !== 'function')
    throw new Error('Expected function hooks')
  const old = server()
  const next = server()
  await configure.call({} as never, old as unknown as ViteDevServer)
  await configure.call({} as never, next as unknown as ViteDevServer)
  await close.call({ environment: old.environments.client } as never)
  expect(roots.stop[0]).toHaveBeenCalledOnce()
  expect(roots.stop[1]).not.toHaveBeenCalled()
  expect(old.watcher.listenerCount('change')).toBe(0)
  expect(next.watcher.listenerCount('change')).toBe(1)
  await close.call({ environment: next.environments.client } as never)
  expect(roots.stop[1]).toHaveBeenCalledOnce()
  expect(next.watcher.listenerCount('change')).toBe(0)
})
