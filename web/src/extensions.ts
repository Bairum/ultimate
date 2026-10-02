// Discovers and hot-reloads the web facets of extensions/*. The registry (sdk/registry.ts) does the bookkeeping.
import { registry } from './sdk/client.ts'
import { loaders as facets } from 'virtual:ultimate/web-facets'
import { extensionName } from './sdk/registry.ts'
import type { ExtensionLoader } from './sdk/registry.ts'

declare global {
  interface Window {
    __getReactRefreshIgnoredExports?: (context: { id: string }) => string[]
  }
}

/** Every extensions/<name>/web.tsx, imported lazily. Vite regenerates this map when a folder appears or goes. */
export const loaders: Record<string, ExtensionLoader> = facets

/** Errors Vite reported for a facet, which say more than a failed dynamic import. */
const viteErrors = new Map<string, string>()

/** Load the facets; each settles on its own. */
export function loadExtensions(map: Record<string, ExtensionLoader> = loaders) {
  return registry.setLoaders(
    Object.fromEntries(
      Object.entries(map).map(([path, loader]) => [
        path,
        async () => {
          const name = extensionName(path) ?? path
          try {
            const module = await loader()
            viteErrors.delete(name)
            return module
          } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            throw new Error(viteErrors.get(name) ?? String(error), { cause: error })
          }
        },
      ]),
    ),
  )
}

// A web.tsx default-exports its contribution object, not a component. Keeping that export out of React Fast
// Refresh's check lets an edited web.tsx refresh in place: components keep their state, the page stays.
// oxlint-disable-next-line no-underscore-dangle -- the hook's name in @vitejs/plugin-react
window.__getReactRefreshIgnoredExports = ({ id }) => (extensionName(id) ? ['default'] : [])

if (import.meta.hot) {
  import.meta.hot.accept('virtual:ultimate/web-facets', (next) => {
    if (next) void loadExtensions(next.loaders)
  })
  // A folder was added or removed, or a facet could not refresh in place: load the new map.
  import.meta.hot.accept((next) => {
    if (next) void loadExtensions(next.loaders as Record<string, ExtensionLoader>)
  })
  // A facet refreshed in place: install its new contributions (commands, slots, renderers) too.
  import.meta.hot.on('vite:afterUpdate', ({ updates }) => {
    for (const update of updates) {
      const name = extensionName(update.path)
      if (!name || update.type !== 'js-update' || update.path !== update.acceptedPath) continue
      const [path, query] = update.acceptedPath.split('?')
      import(/* @vite-ignore */ `${path}?t=${update.timestamp}${query ? `&${query}` : ''}`).then(
        (module: unknown) => {
          viteErrors.delete(name)
          registry.replace(name, module)
        },
        (error: unknown) => registry.fail(name, viteErrors.get(name) ?? error),
      )
    }
  })
  // A facet failed to compile: show it on that extension's card. Vite's overlay stays for core errors.
  import.meta.hot.on('vite:error', ({ err }) => {
    const name = extensionName(err.id ?? err.loc?.file ?? '')
    if (!name) return
    viteErrors.set(name, err.message)
    registry.fail(name, err.message)
    requestAnimationFrame(() => document.querySelector('vite-error-overlay')?.remove())
  })
}
