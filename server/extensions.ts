import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  ConversationDocToken,
  Extension,
  Harness,
  JsonObject,
} from '@earendil-works/pi-durable'
import type { ViteDevServer } from 'vite-plus'
import type { ExtensionInfo, SystemInfo } from '../shared/protocol.ts'
import type { PreparedHost } from './harness.ts'

export type ExtensionHost = Pick<
  PreparedHost,
  'repoRoot' | 'modelRuntime' | 'settings' | 'build' | 'uiState'
> & {
  harness(): Harness
  system(): SystemInfo
  extensions(): ExtensionInfo[]
  doc(kind: string): ConversationDocToken<JsonObject> | undefined
}
export async function loadExtensions(
  vite: ViteDevServer,
  host: PreparedHost,
  changed: () => void,
  runtime: Pick<ExtensionHost, 'harness' | 'system'>,
) {
  const directory = join(host.repoRoot, 'extensions')
  const records = new Map<string, ExtensionInfo>()
  const documents = new Map<string, ConversationDocToken<JsonObject>[]>()
  const extensionHost: ExtensionHost = {
    ...host,
    ...runtime,
    extensions: () => [...records.values()],
    doc: (kind) => [...documents.values()].flat().find((doc) => doc.definition.kind === kind),
  }
  const installed = new Set<string>()
  let chain = Promise.resolve()
  let closed = false
  async function reload(selected?: Set<string>, servers = selected) {
    const folders = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted()
    for (const name of folders) {
      if (selected && !selected.has(name)) continue
      const files = await readdir(join(directory, name))
      const previous = records.get(name)
      let readme: string | undefined
      if (files.includes('README.md'))
        readme = (await readFile(join(directory, name, 'README.md'), 'utf8'))
          .trim()
          .split(/\n\s*\n/)[0]
      const record: ExtensionInfo = {
        name,
        readme,
        facets: { server: files.includes('server.ts'), web: files.includes('web.tsx') },
        ...(previous?.server ? { server: previous.server } : {}),
      }
      if (record.facets.server && (!servers || servers.has(name))) {
        try {
          const module = await vite.ssrLoadModule(join(directory, name, 'server.ts'))
          const extension: Extension =
            typeof module.default === 'function'
              ? await module.default(extensionHost)
              : module.default
          if (!extension || extension.name !== name)
            throw new Error('Extension name must match its folder')
          const docs: ConversationDocToken<JsonObject>[] = module.docs ?? []
          if (!Array.isArray(docs) || docs.some((doc) => doc.definition.scope !== 'conversation'))
            throw new Error('docs must contain conversation document tokens')
          host.registry.install(extension)
          installed.add(name)
          documents.set(name, docs)
          record.server = {
            loadedAt: new Date().toISOString(),
            tools: extension.tools?.map((tool) => tool.name) ?? [],
            sections: extension.sections?.map((section) => section.key) ?? [],
            hooks: extension.hooks?.length ?? 0,
            docs: docs.map((doc) => doc.definition.kind),
          }
        } catch (error) {
          record.server = {
            ...(previous?.server ?? { tools: [], sections: [], hooks: 0, docs: [] }),
            error: String(error),
          }
        }
      } else if (!record.facets.server) {
        if (installed.delete(name)) host.registry.uninstall({ name })
        documents.delete(name)
        delete record.server
      }
      if (!record.server?.error) host.builds.extension(name)
      records.set(name, record)
    }
    for (const name of records.keys()) {
      if (!folders.includes(name)) {
        if (installed.delete(name)) host.registry.uninstall({ name })
        records.delete(name)
        host.builds.remove(name)
        documents.delete(name)
      }
    }
    host.builds.refresh()
    changed()
  }
  await reload()
  // Vite owns the transitive local module graph; query-string imports do not.
  const onChange = (file: string) => {
    if (closed || !resolve(file).startsWith(host.repoRoot + '/') || file.includes('/node_modules/'))
      return
    if (
      file.startsWith(join(host.repoRoot, 'agents') + '/') ||
      file === join(host.repoRoot, 'agents')
    ) {
      chain = chain.then(() => {
        host.builds.refresh()
        changed()
      })
      return
    }
    if (!file.startsWith(directory + '/') && !/\.[cm]?[jt]s$/.test(file)) return
    chain = chain
      .then(async () => {
        const selected = new Set<string>()
        const modules = vite.moduleGraph.getModulesByFile(file)
        const visited = new Set<import('vite-plus').ModuleNode>()
        const visit = (module: import('vite-plus').ModuleNode) => {
          if (visited.has(module)) return
          visited.add(module)
          for (const name of records.keys())
            if (module.file === join(directory, name, 'server.ts')) selected.add(name)
          for (const importer of module.importers) visit(importer)
        }
        for (const module of modules ?? []) visit(module)
        for (const module of visited) vite.moduleGraph.invalidateModule(module)
        const name = file.startsWith(directory + '/')
          ? file.slice(directory.length + 1).split('/')[0]
          : undefined
        const servers = new Set(selected)
        if (name) {
          selected.add(name)
          if (file === join(directory, name, 'server.ts')) servers.add(name)
        }
        await reload(selected, servers)
      })
      .catch((error) => {
        for (const record of records.values())
          if (record.server) record.server.error = String(error)
        changed()
      })
  }
  const onStructure = (file: string) => {
    if (!file.startsWith(directory + '/')) return onChange(file)
    chain = chain.then(() => reload()).catch(() => changed())
  }
  vite.watcher.add([directory, join(host.repoRoot, 'agents')])
  vite.watcher
    .on('change', onChange)
    .on('add', onStructure)
    .on('unlink', onStructure)
    .on('addDir', onStructure)
    .on('unlinkDir', onStructure)
  return {
    info: () => [...records.values()],
    doc: (kind: string) =>
      [...documents.values()].flat().find((doc) => doc.definition.kind === kind),
    async close() {
      closed = true
      vite.watcher.off('change', onChange)
      for (const event of ['add', 'unlink', 'addDir', 'unlinkDir'])
        vite.watcher.off(event, onStructure)
      await chain
    },
  }
}
export type Extensions = Awaited<ReturnType<typeof loadExtensions>>
