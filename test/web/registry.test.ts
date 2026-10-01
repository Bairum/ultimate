import { describe, expect, it, vi } from 'vitest'
import {
  commandItems,
  createRegistry,
  extensionName,
  panelItems,
  rendererFor,
  slotItems,
  viewItems,
} from '../../web/src/sdk/registry.ts'
import type { ExtensionLoader } from '../../web/src/sdk/registry.ts'
import type { WebExtension } from '../../web/src/sdk/types.ts'

const path = (name: string) => `../../extensions/${name}/web.tsx`
const component = (label: string) => Object.assign(() => null, { displayName: label })
const module = (extension: WebExtension) => ({ default: extension })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('web extension registry', () => {
  it('names facets by folder', () => {
    expect(extensionName('/@fs/repo/extensions/status-line/web.tsx?t=1')).toBe('status-line')
    expect(extensionName(path('hello'))).toBe('hello')
    expect(extensionName('/repo/web/src/main.tsx')).toBeUndefined()
  })

  it('loads each facet lazily and on its own, isolating a broken one', async () => {
    const slow = deferred<unknown>()
    const Late = component('late')
    const Early = component('early')
    const loaders: Record<string, ExtensionLoader> = {
      [path('beta')]: vi.fn<ExtensionLoader>(() => slow.promise),
      [path('alpha')]: vi.fn<ExtensionLoader>(async () =>
        module({
          slots: { 'statusline.left': [Early] },
          commands: [{ id: 'a', title: 'A', run() {} }],
        }),
      ),
      [path('broken')]: vi.fn<ExtensionLoader>(async () => {
        throw new SyntaxError('Unexpected token (3:14)')
      }),
    }
    const registry = createRegistry()
    for (const loader of Object.values(loaders)) expect(loader).not.toHaveBeenCalled()

    const settled = registry.setLoaders(loaders)
    expect(registry.getSnapshot().map((record) => [record.name, record.loading])).toEqual([
      ['alpha', true],
      ['beta', true],
      ['broken', true],
    ])
    await vi.waitFor(() => {
      expect(
        registry.getSnapshot().find((record) => record.name === 'alpha')?.extension,
      ).toBeDefined()
    })
    // alpha and broken settled while beta is still loading.
    const early = registry.getSnapshot()
    expect(early.find((record) => record.name === 'beta')?.loading).toBe(true)
    expect(early.find((record) => record.name === 'broken')?.error).toBe('Unexpected token (3:14)')
    expect(slotItems(early, 'statusline.left').map((item) => item.component)).toEqual([Early])

    slow.resolve(module({ slots: { 'statusline.left': { component: Late, order: -1 } } }))
    await settled
    const records = registry.getSnapshot()
    expect(records.map((record) => [record.name, !!record.extension, record.error])).toEqual([
      ['alpha', true, undefined],
      ['beta', true, undefined],
      ['broken', false, 'Unexpected token (3:14)'],
    ])
    // `order` first, then folder name.
    expect(slotItems(records, 'statusline.left').map((item) => item.extension)).toEqual([
      'beta',
      'alpha',
    ])
    expect(commandItems(records).map((command) => `${command.extension}:${command.id}`)).toEqual([
      'alpha:a',
    ])
    for (const loader of Object.values(loaders)) expect(loader).toHaveBeenCalledOnce()
  })

  it('keeps the previous version of a facet whose reload fails, and recovers', async () => {
    const First = component('first')
    const Second = component('second')
    const registry = createRegistry()
    const listener = vi.fn<() => void>()
    registry.subscribe(listener)
    await registry.setLoaders({
      [path('hello')]: async () => module({ slots: { overlay: First } }),
    })
    const installed = registry.getSnapshot()[0]
    expect(installed.version).toBe(1)

    registry.fail('hello', new Error('Transform failed'))
    const failed = registry.getSnapshot()[0]
    expect(failed.error).toBe('Transform failed')
    expect(slotItems(registry.getSnapshot(), 'overlay').map((item) => item.component)).toEqual([
      First,
    ])

    registry.replace('hello', module({ slots: { overlay: Second } }))
    const recovered = registry.getSnapshot()[0]
    expect(recovered.error).toBeUndefined()
    expect(recovered.version).toBe(2)
    expect(slotItems(registry.getSnapshot(), 'overlay').map((item) => item.component)).toEqual([
      Second,
    ])
    expect(listener).toHaveBeenCalled()
  })

  it('rejects a facet without a default export and drops removed folders', async () => {
    const registry = createRegistry()
    await registry.setLoaders({
      [path('empty')]: async () => ({}),
      [path('kept')]: async () => module({}),
    })
    expect(registry.getSnapshot().find((record) => record.name === 'empty')?.error).toMatch(
      /default-export defineWebExtension/,
    )
    await registry.setLoaders({ [path('kept')]: async () => module({}) })
    expect(registry.getSnapshot().map((record) => record.name)).toEqual(['kept'])
  })

  it('reloads only facets whose module changed', async () => {
    const extension: WebExtension = { slots: { sidebar: component('side') } }
    const registry = createRegistry()
    await registry.setLoaders({ [path('same')]: async () => module(extension) })
    const before = registry.getSnapshot()[0]
    await registry.setLoaders({ [path('same')]: async () => module(extension) })
    expect(registry.getSnapshot()[0]).toBe(before)
  })

  it('resolves renderers, panels, and views across facets', async () => {
    const First = component('first')
    const Second = component('second')
    const registry = createRegistry()
    await registry.setLoaders({
      [path('a')]: async () =>
        module({
          tools: { bash: First },
          panels: [{ id: 'info', title: 'Info', component: First, order: 2 }],
        }),
      [path('b')]: async () =>
        module({
          tools: { bash: Second },
          entries: { 'pi.compaction': Second },
          panels: [{ id: 'tasks', title: 'Tasks', component: Second, order: 1 }],
          views: [{ id: 'board', title: 'Board', component: Second }],
        }),
    })
    const records = registry.getSnapshot()
    expect(rendererFor(records, 'tools', 'bash')?.extension).toBe('b')
    expect(rendererFor(records, 'entries', 'pi.compaction')?.component).toBe(Second)
    expect(rendererFor(records, 'tools', 'read')).toBeUndefined()
    expect(panelItems(records).map((panel) => panel.id)).toEqual(['tasks', 'info'])
    expect(viewItems(records).map((view) => `${view.extension}:${view.id}`)).toEqual(['b:board'])
  })
})
