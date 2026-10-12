import { expect, it } from 'vitest'
import { serviceRegistry } from '../server/services.ts'
import type { ServiceInfo } from '../server/services.ts'
import { isCoreReport } from '../server/supervisor-protocol.ts'

it('stages services and isolates registration, updates, disposal and stale replacement handles', () => {
  const reports: ServiceInfo[][] = []
  const registry = serviceRegistry((services) => reports.push(services))
  registry.visible(true)
  const old = registry.scope('test')
  const stale = old.service('worker', { state: 'starting' })
  expect(registry.snapshot()).toEqual([])
  old.activate()
  stale.update({ state: 'ready', detail: 'durable scheduler' })
  expect(reports.at(-1)).toEqual([
    { extension: 'test', name: 'worker', state: 'ready', detail: 'durable scheduler' },
  ])
  const failed = registry.scope('test')
  failed.service('worker', { state: 'error' })
  failed.dispose()
  expect(registry.snapshot()[0].state).toBe('ready')
  const next = registry.scope('test')
  const handle = next.service('worker', { state: 'busy' })
  old.dispose()
  next.activate()
  stale.update({ state: 'error' })
  stale.dispose()
  expect(registry.snapshot()[0].state).toBe('busy')
  handle.dispose()
  const replacement = next.service('worker', { state: 'ready' })
  handle.dispose()
  expect(registry.snapshot()[0].state).toBe('ready')
  registry.visible(false)
  expect(reports.at(-1)).toEqual([])
  registry.visible(true)
  expect(reports.at(-1)).toHaveLength(1)
  next.dispose()
  replacement.update({ state: 'error' })
  expect(registry.snapshot()).toEqual([])
  expect(() => next.service('new', { state: 'ready' })).toThrow('disposed')
})

it('keeps high-frequency presentation out of lifecycle acknowledgement queues', () => {
  for (let i = 0; i < 10000; i++) {
    expect(isCoreReport({ type: 'log', level: 'info', source: 'web', text: `hmr ${i}` })).toBe(true)
    expect(isCoreReport({ type: 'services', services: [] })).toBe(true)
    expect(isCoreReport({ type: 'web', state: 'ready' })).toBe(true)
  }
  expect(isCoreReport({ type: 'ready' })).toBe(false)
})
