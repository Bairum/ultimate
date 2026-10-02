import { join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import type { Plugin } from 'vite-plus'
import { discoverExtensions } from './discovery.ts'
import { discoveryRoots } from './project.ts'

const virtual = 'virtual:ultimate/web-facets'
const resolved = '\0' + virtual
export function extensionModules(
  ultimateRoot: string,
  projectRoot: string,
  userHome: string,
): Plugin {
  const roots = discoveryRoots(ultimateRoot, projectRoot, userHome).map((root) =>
    join(root.path, 'extensions'),
  )
  return {
    name: 'ultimate:extension-modules',
    enforce: 'pre',
    async config() {
      const modules = join(ultimateRoot, 'node_modules')
      const entries = await readdir(modules)
      const packages = (
        await Promise.all(
          entries
            .filter((name) => !name.startsWith('.'))
            .map(async (name) =>
              name.startsWith('@')
                ? (await readdir(join(modules, name))).map((child) => `${name}/${child}`)
                : [name],
            ),
        )
      ).flat()
      return { resolve: { dedupe: packages } }
    },
    async resolveId(id, importer, options) {
      if (id === virtual) return resolved
      if (
        !importer ||
        options.ssr ||
        !roots.slice(1).some((root) => importer.startsWith(root + '/')) ||
        id.startsWith('.') ||
        id.startsWith('/') ||
        id.startsWith('\0')
      )
        return undefined
      if (id.startsWith('@/'))
        return this.resolve(join(ultimateRoot, 'web/src', id.slice(2)), importer, {
          ...options,
          skipSelf: true,
        })
      if (id.startsWith('node:')) return undefined
      const dependency = await this.resolve(id, join(ultimateRoot, 'package.json'), {
        ...options,
        skipSelf: true,
      })
      return dependency
    },
    async load(id) {
      if (id.split('?')[0] === join(ultimateRoot, 'web/src/index.css'))
        return (
          (await readFile(join(ultimateRoot, 'web/src/index.css'), 'utf8')) +
          '\n' +
          roots.map((root) => `@source ${JSON.stringify(root)};`).join('\n')
        )
      if (id !== resolved) return undefined
      const facets = (await discoverExtensions(ultimateRoot, projectRoot, userHome)).filter(
        (entry) => entry.files.includes('web.tsx'),
      )
      const entries = facets.map(
        (entry) =>
          `${JSON.stringify(join(entry.path, 'web.tsx'))}: () => import(${JSON.stringify('/@fs/' + join(entry.path, 'web.tsx'))})`,
      )
      const sources = Object.fromEntries(
        facets.map((entry) => [entry.name, { source: entry.source, path: entry.path }]),
      )
      return `export const loaders = {${entries.join(',')}}; export const sources = ${JSON.stringify(sources)};`
    },
    hotUpdate({ file, modules, type }) {
      if (
        this.environment.name !== 'client' ||
        type !== 'create' ||
        !roots.some((root) => file.startsWith(root + '/'))
      )
        return undefined
      const styles = this.environment.moduleGraph.getModuleById(
        join(ultimateRoot, 'web/src/index.css'),
      )
      return styles && !modules.includes(styles) ? [...modules, styles] : undefined
    },
    configureServer(server) {
      server.watcher.add(roots)
      const structure = (file: string) => {
        if (!roots.some((root) => file === root || file.startsWith(root + '/'))) return
        const module = server.moduleGraph.getModuleById(resolved)
        if (module) {
          server.moduleGraph.invalidateModule(module)
          void server.reloadModule(module)
        }
      }
      for (const event of ['add', 'unlink', 'addDir', 'unlinkDir'] as const)
        server.watcher.on(event, structure)
      server.httpServer?.once('close', () => {
        for (const event of ['add', 'unlink', 'addDir', 'unlinkDir'] as const)
          server.watcher.off(event, structure)
      })
    },
  }
}
