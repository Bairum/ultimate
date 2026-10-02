import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { discoverExtensions } from './discovery.ts'
import { projectSetup, projectSettings, projectDiagnostics } from './project-setup.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { discoveryRoots } from './project.ts'
import { extensionSettingsFiles } from './extension-settings.ts'
import { watchRoots } from './watch-roots.ts'
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
import { Metadata } from './metadata.ts'

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
  | 'faux'
  | 'models'
  | 'skills'
  | 'restart'
> & {
  resource<T>(key: string, create: () => T): T
  /** Run `callback` each time the harness opens, at once when it is open; the server serves once it settles. */
  onOpen(callback: () => Promise<void>): void
  onClose(cleanup: () => Promise<void>): void
  harness(): Harness
  system(): SystemInfo
  /** Discovered extensions, including disabled project folders, with effective deciding layers. */
  extensions(): ExtensionInfo[]
  /** Project setup availability, exact-root decision, and capped README. */
  projectSetup(): ReturnType<typeof projectSetup>
  /** Parsed project settings only after a local decision; otherwise empty. Invalid JSON reports a notice and returns empty. */
  projectSettings(): Promise<JsonObject>
  /** Read-only inventory of project folders, including replacements of active extensions. */
  projectExtensions(): Promise<ExtensionInfo[]>
  /** Remember the local/global choice and apply it through the live settings reload path. */
  setProjectDecision(local: boolean): Promise<void>
  /** Apply settings writes to the registry, browser facets, and styles before returning. */
  reloadExtensions(): Promise<void>
  doc(kind: string): ConversationDocToken<JsonObject> | undefined
  metadata: typeof Metadata
}
const runOpener = (callback: () => Promise<void>) =>
  callback().catch((error: unknown) => console.error('Extension onOpen:', error))
/** Attach listeners to Vite's current watcher and to each replacement; `attach` returns their removal. */
export type Watch = (attach: (watcher: ViteDevServer['watcher']) => () => void) => () => void
export async function loadExtensions(
  vite: ViteDevServer,
  host: PreparedHost,
  changed: () => void | Promise<void>,
  runtime: Pick<ExtensionHost, 'harness' | 'system'>,
  watch: Watch,
  notice: (message: string) => void = () => {},
) {
  const roots = discoveryRoots(host.ultimateRoot, host.projectRoot, host.userHome)
  const directories = roots.map((root) => join(root.path, 'extensions'))
  const actions = new Map<string, Record<string, ExtensionAction>>()
  const records = new Map<string, ExtensionInfo>()
  const documents = new Map<string, ConversationDocToken<JsonObject>[]>()
  const findDoc = (kind: string) =>
    [...documents.values()].flat().find((doc) => doc.definition.kind === kind)
  const openers = new Set<() => Promise<void>>()
  let open = false
  const cleanups = new Set<() => Promise<void>>()
  const resources = new Map<string, unknown>()
  const extensionHost: ExtensionHost = {
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onOpen: (callback) => {
      openers.add(callback)
      if (open) void runOpener(callback)
    },
    onClose: (cleanup) => cleanups.add(cleanup),
    ultimateRoot: host.ultimateRoot,
    projectRoot: host.projectRoot,
    userHome: host.userHome,
    home: host.home,
    modelRuntime: host.modelRuntime,
    settings: host.settings,
    build: host.build,
    uiState: (caller) => host.uiState(caller),
    faux: host.faux,
    models: () => host.models(),
    skills: (cwd) => host.skills(cwd),
    restart: (approved) => host.restart(approved),
    harness: runtime.harness,
    system: runtime.system,
    extensions: () => [...records.values()],
    projectSetup: () => projectSetup(host.projectRoot, host.userHome),
    projectSettings: () => projectSettings(host.projectRoot, host.userHome, notice),
    projectExtensions: async () => {
      const available = await discoverExtensions(
        host.ultimateRoot,
        host.projectRoot,
        host.userHome,
        true,
      )
      return available
        .filter((entry) => entry.source === 'project')
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          source: entry.source,
          enabled: records.get(entry.name)?.path === entry.path && records.get(entry.name)!.enabled,
          layer: available.settings.layers.get(entry.name) ?? 'folder',
          actions: [],
          facets: {
            server: entry.files.includes('server.ts'),
            web: entry.files.includes('web.tsx'),
          },
          ...(existsSync(join(host.ultimateRoot, 'extensions', entry.name))
            ? { replaces: 'builtin' as const }
            : {}),
        }))
    },
    setProjectDecision: async (local) => {
      new ProjectTrustStore(join(host.userHome, '.ultimate')).set(host.projectRoot, local)
      await extensionHost.reloadExtensions()
    },
    reloadExtensions: async () => {
      chain = chain.then(() => reloadSettings())
      await chain
      for (const id of [
        '\0virtual:ultimate/web-facets',
        join(host.ultimateRoot, 'web/src/index.css'),
      ]) {
        const module = vite.moduleGraph.getModuleById(id)
        if (module) {
          vite.moduleGraph.invalidateModule(module)
          await vite.reloadModule(module)
        }
      }
    },
    doc: findDoc,
    metadata: Metadata,
  }
  const installed = host.extensionOrders
  let chain = Promise.resolve()
  let closed = false
  const settingsFiles = [
    ...extensionSettingsFiles(host.projectRoot, host.userHome),
    join(host.userHome, '.ultimate/trust.json'),
  ]
  let previousSettings: string | undefined
  let diagnostics: string[] = []
  async function discover() {
    const active = await discoverExtensions(host.ultimateRoot, host.projectRoot, host.userHome)
    const available = await discoverExtensions(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      true,
      active.settings,
    )
    const winners = [
      ...active,
      ...available
        .filter((entry) => !active.some((current) => current.name === entry.name))
        .map((entry) => ({ ...entry, enabled: false })),
    ].toSorted((a, b) => a.name.localeCompare(b.name))
    return Object.assign(winners, { settings: active.settings })
  }
  async function reload(
    selected?: Set<string>,
    servers = selected,
    winners?: Awaited<ReturnType<typeof discover>>,
  ) {
    winners ??= await discover()
    const folders = winners.map((winner) => winner.name)
    const settings = winners.settings
    diagnostics = [
      ...settings.notices,
      ...projectDiagnostics(host.projectRoot, host.userHome),
      ...[...settings.overrides.keys()]
        .filter((name) => !folders.includes(name))
        .map((name) => `Unknown extension: ${name}`),
    ]
    const signature = JSON.stringify([settings.contents, folders, diagnostics])
    if (signature !== previousSettings) {
      for (const message of diagnostics) notice(message)
      previousSettings = signature
    }
    for (const { name, path, source, enabled, files, error: discoveryError } of winners) {
      const previous = records.get(name)
      const layer = settings.layers.get(name) ?? (source === 'builtin' ? 'default' : 'folder')
      if (selected && !selected.has(name)) {
        if (previous) previous.layer = layer
        continue
      }
      let readme: string | undefined
      if (files.includes('README.md'))
        readme = (await readFile(join(path, 'README.md'), 'utf8')).trim().split(/\n\s*\n/)[0]
      const record: ExtensionInfo = {
        name,
        path,
        source,
        enabled,
        layer,
        actions: Object.keys(actions.get(name) ?? {}),
        readme,
        facets: { server: files.includes('server.ts'), web: files.includes('web.tsx') },
        ...(previous?.server ? { server: previous.server } : {}),
      }
      if (enabled && record.facets.server && (!servers || servers.has(name))) {
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
      } else if (!enabled || !record.facets.server) {
        if (installed.delete(name)) host.registry.uninstall({ name })
        documents.delete(name)
        actions.delete(name)
        record.actions = []
        delete record.server
      }
      if (enabled && discoveryError)
        record.server = { tools: [], sections: [], hooks: 0, docs: [], error: discoveryError }
      if (enabled && !record.server?.error) host.builds.extension(name, path)
      if (!enabled) host.builds.remove(name)
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
    host.builds.refresh(winners.map(({ name, enabled }) => [name, enabled]))
    await changed()
  }
  async function reloadSettings() {
    const winners = await discover()
    await reload(
      new Set(
        winners
          .filter((entry) => {
            const previous = records.get(entry.name)
            return !previous || previous.enabled !== entry.enabled || previous.path !== entry.path
          })
          .map((entry) => entry.name),
      ),
      undefined,
      winners,
    )
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
    if (settingsFiles.includes(resolve(file))) {
      chain = chain.then(() => reloadSettings()).catch(() => changed())
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
        return changed()
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
    const watchedRoots = [
      ...directories,
      ...settingsFiles,
      ...roots.slice(1).map((root) => join(root.path, 'skills')),
    ]
    watcher.add(watchedRoots)
    const stopRoots = watchRoots(watchedRoots, (root) => {
      watcher.add(root)
      chain = chain
        .then(() => (settingsFiles.includes(root) ? reloadSettings() : reload()))
        .catch(() => changed())
    })
    watcher.on('change', onChange)
    for (const event of structure) watcher.on(event, onStructure)
    return () => {
      stopRoots()
      watcher.off('change', onChange)
      for (const event of structure) watcher.off(event, onStructure)
    }
  })
  return {
    info: Object.assign(() => [...records.values()], {
      diagnostics: () => [
        ...new Set([...diagnostics, ...projectDiagnostics(host.projectRoot, host.userHome)]),
      ],
    }),
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
    doc: findDoc,
    /** The harness is open: run the `onOpen` callbacks. */
    async opened() {
      open = true
      await Promise.all([...openers].map(runOpener))
    },
    released() {
      open = false
    },
    async close() {
      closed = true
      unwatch()
      await chain
      await Promise.all([...cleanups].map((cleanup) => cleanup()))
    },
  }
}
export type Extensions = Awaited<ReturnType<typeof loadExtensions>>
