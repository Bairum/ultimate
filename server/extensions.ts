import { readFile } from 'node:fs/promises'
import { discoverExtensions } from './discovery.ts'
import { discoveryRoots } from './project.ts'
import { actionExec } from './actions.ts'
import type { ExtensionAction } from './actions.ts'
import type { JsonValue } from '@earendil-works/chord'
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
  | 'ultimateRoot'
  | 'projectRoot'
  | 'userHome'
  | 'home'
  | 'modelRuntime'
  | 'settings'
  | 'build'
  | 'uiState'
> & {
  resource<T>(key: string, create: () => T): T
  onClose(cleanup: () => Promise<void>): void
  harness(): Harness
  system(): SystemInfo
  extensions(): ExtensionInfo[]
  doc(kind: string): ConversationDocToken<JsonObject> | undefined
}
/** Attach listeners to Vite's current watcher and to each replacement; `attach` returns their removal. */
export type Watch = (attach: (watcher: ViteDevServer['watcher']) => () => void) => () => void
export async function loadExtensions(
  vite: ViteDevServer,
  host: PreparedHost,
  changed: () => void,
  runtime: Pick<ExtensionHost, 'harness' | 'system'>,
  watch: Watch,
) {
  const roots = discoveryRoots(host.ultimateRoot, host.projectRoot, host.userHome)
  const directories = roots.map((root) => join(root.path, 'extensions'))
  const agentDirectories = roots.map((root) => join(root.path, 'agents'))
  const actions = new Map<string, Record<string, ExtensionAction>>()
  const records = new Map<string, ExtensionInfo>()
  const documents = new Map<string, ConversationDocToken<JsonObject>[]>()
  const cleanups = new Set<() => Promise<void>>()
  const resources = new Map<string, unknown>()
  const extensionHost: ExtensionHost = {
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onClose: (cleanup) => cleanups.add(cleanup),
    ...host,
    ...runtime,
    extensions: () => [...records.values()],
    doc: (kind) => [...documents.values()].flat().find((doc) => doc.definition.kind === kind),
  }
  const installed = host.extensionOrders
  let chain = Promise.resolve()
  let closed = false
  async function reload(selected?: Set<string>, servers = selected) {
    const winners = await discoverExtensions(host.ultimateRoot, host.projectRoot, host.userHome)
    const folders = winners.map((winner) => winner.name)
    for (const { name, path, source, files } of winners) {
      if (selected && !selected.has(name)) continue
      const previous = records.get(name)
      let readme: string | undefined
      if (files.includes('README.md'))
        readme = (await readFile(join(path, 'README.md'), 'utf8')).trim().split(/\n\s*\n/)[0]
      const record: ExtensionInfo = {
        name,
        path,
        source,
        actions: Object.keys(actions.get(name) ?? {}),
        readme,
        facets: { server: files.includes('server.ts'), web: files.includes('web.tsx') },
        ...(previous?.server ? { server: previous.server } : {}),
      }
      if (record.facets.server && (!servers || servers.has(name))) {
        try {
          const module = await vite.ssrLoadModule(join(path, 'server.ts'))
          const extension: Extension =
            typeof module.default === 'function'
              ? await module.default(extensionHost)
              : module.default
          if (!extension || extension.name !== name)
            throw new Error('Extension name must match its folder')
          const docs: ConversationDocToken<JsonObject>[] = module.docs ?? []
          if (!Array.isArray(docs) || docs.some((doc) => doc.definition.scope !== 'conversation'))
            throw new Error('docs must contain conversation document tokens')
          const exportedActions: Record<string, ExtensionAction> = module.actions ?? {}
          if (Object.values(exportedActions).some((action) => typeof action !== 'function'))
            throw new Error('actions must contain functions')
          host.registry.install(extension)
          actions.set(name, exportedActions)
          record.actions = Object.keys(exportedActions)
          installed.set(name, module.order ?? 0)
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
        actions.delete(name)
        record.actions = []
        delete record.server
      }
      if (!record.server?.error) host.builds.extension(name, path)
      records.set(name, record)
    }
    for (const name of records.keys()) {
      if (!folders.includes(name)) {
        if (installed.delete(name)) host.registry.uninstall({ name })
        records.delete(name)
        actions.delete(name)
        host.builds.remove(name)
        documents.delete(name)
      }
    }
    host.builds.refresh()
    changed()
  }
  await reload()
  // A restarted Vite starts with an empty module graph, so the next change reloads every extension.
  let graphLost = false
  // Vite owns the transitive local module graph; query-string imports do not.
  const onChange = (file: string) => {
    if (
      closed ||
      ![host.ultimateRoot, host.projectRoot, ...roots.slice(1).map((root) => root.path)].some(
        (root) => resolve(file).startsWith(root + '/'),
      ) ||
      file.includes('/node_modules/')
    )
      return
    if (
      agentDirectories.some((directory) => file.startsWith(directory + '/') || file === directory)
    ) {
      chain = chain.then(() => {
        host.builds.refresh()
        changed()
      })
      return
    }
    const directory = directories.find((root) => file.startsWith(root + '/'))
    if (!directory && !/\.[cm]?[jt]s$/.test(file)) return
    if (graphLost) {
      graphLost = false
      chain = chain.then(() => reload()).catch(() => changed())
      return
    }
    chain = chain
      .then(async () => {
        const selected = new Set<string>()
        const modules = vite.moduleGraph.getModulesByFile(file)
        const visited = new Set<import('vite-plus').ModuleNode>()
        const visit = (module: import('vite-plus').ModuleNode) => {
          if (visited.has(module)) return
          visited.add(module)
          for (const name of records.keys())
            if (module.file === join(records.get(name)!.path, 'server.ts')) selected.add(name)
          for (const importer of module.importers) visit(importer)
        }
        for (const module of modules ?? []) visit(module)
        for (const module of visited) vite.moduleGraph.invalidateModule(module)
        const name = directory ? file.slice(directory.length + 1).split('/')[0] : undefined
        const servers = new Set(selected)
        if (name) {
          selected.add(name)
          if (directory && file === join(directory, name, 'server.ts')) servers.add(name)
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
    if (!directories.some((directory) => file.startsWith(directory + '/'))) return onChange(file)
    chain = chain.then(() => reload()).catch(() => changed())
  }
  const structure = ['add', 'unlink', 'addDir', 'unlinkDir'] as const
  let attached = false
  const unwatch = watch((watcher) => {
    graphLost = attached
    attached = true
    watcher.add([
      ...directories,
      ...agentDirectories,
      ...roots.slice(1).map((root) => join(root.path, 'skills')),
    ])
    watcher.on('change', onChange)
    for (const event of structure) watcher.on(event, onStructure)
    return () => {
      watcher.off('change', onChange)
      for (const event of structure) watcher.off(event, onStructure)
    }
  })
  return {
    info: () => [...records.values()],
    action(name: string, action: string) {
      const table = actions.get(name)
      return table && Object.hasOwn(table, action) ? table[action] : undefined
    },
    async invoke(
      name: string,
      action: string,
      args: JsonValue,
      signal: AbortSignal,
      conversationId?: number,
    ) {
      const fn = actions.get(name)![action]
      return fn(args, {
        host: extensionHost,
        conversationId,
        signal,
        exec: actionExec(host.projectRoot, signal),
      })
    },
    doc: (kind: string) =>
      [...documents.values()].flat().find((doc) => doc.definition.kind === kind),
    async close() {
      closed = true
      unwatch()
      await chain
      await Promise.all([...cleanups].map((cleanup) => cleanup()))
    },
  }
}
export type Extensions = Awaited<ReturnType<typeof loadExtensions>>
