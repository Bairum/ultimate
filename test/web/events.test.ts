import { afterEach, expect, it, vi } from 'vitest'
import { events } from '../../web/src/sdk/events.ts'
import { createRegistry } from '../../web/src/sdk/registry.ts'

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.restoreAllMocks()
})
const path = (name: string) => `/extensions/${name}/web.tsx`

it('delivers to independent subscribers, isolates sync and async errors, and unsubscribes', async () => {
  const error = new Error('broken handler')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const received = vi.fn<(data: unknown) => void>()
  stops.push(
    events.on('test:message', () => {
      throw error
    }),
  )
  stops.push(
    events.on('test:message', async () => {
      throw error
    }),
  )
  const stop = events.on('test:message', received)
  stops.push(stop)
  events.emit('test:message', { value: 1 })
  await Promise.resolve()
  expect(received).toHaveBeenCalledExactlyOnceWith({ value: 1 })
  expect(log).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenCalledWith('Event handler error (test:message):', error)
  stop()
  stop()
  events.emit('test:message', { value: 2 })
  await Promise.resolve()
  expect(received).toHaveBeenCalledTimes(1)
})

it.each(['system-first', 'facets-first'])(
  'emits ready once after both prerequisites: %s',
  async (order) => {
    const registry = createRegistry()
    const ready = vi.fn<(data: unknown) => void>()
    const loaded = vi.fn<(data: unknown) => void>()
    const failed = vi.fn<(data: unknown) => void>()
    stops.push(events.on('ultimate:ready', ready))
    stops.push(events.on('ultimate:extension-loaded', loaded))
    stops.push(events.on('ultimate:extension-failed', failed))
    let finish!: (module: unknown) => void
    const slow = new Promise((resolve) => {
      finish = resolve
    })
    if (order === 'system-first') registry.receiveSystem()
    const pending = registry.setLoaders({
      [path('slow')]: () => slow,
      [path('broken')]: async () => {
        throw new Error('bad facet')
      },
    })
    await vi.waitFor(() => expect(registry.getReady().failed).toEqual(['broken']))
    expect(failed).toHaveBeenCalledExactlyOnceWith({ name: 'broken', error: 'bad facet' })
    expect(registry.getReady().ready).toBe(false)
    expect(ready).not.toHaveBeenCalled()
    finish({ default: {} })
    await pending
    expect(loaded).toHaveBeenCalledExactlyOnceWith({ name: 'slow' })
    expect(ready).toHaveBeenCalledTimes(order === 'system-first' ? 1 : 0)
    registry.receiveSystem()
    expect(registry.getReady()).toEqual({ ready: true, failed: ['broken'] })
    expect(ready).toHaveBeenCalledExactlyOnceWith({ failed: ['broken'] })
    registry.receiveSystem()
    registry.replace('broken', { default: {} })
    registry.fail('slow', 'reload error')
    await registry.setLoaders({ [path('slow')]: async () => ({ default: {} }) })
    expect(registry.getReady()).toEqual({ ready: true, failed: [] })
    expect(ready).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenLastCalledWith({ name: 'slow', error: 'reload error' })
  },
)

it('settles an empty initial registry but still waits for system', async () => {
  const registry = createRegistry()
  await registry.setLoaders({})
  expect(registry.getReady().ready).toBe(false)
  registry.receiveSystem()
  expect(registry.getReady()).toEqual({ ready: true, failed: [] })
})
