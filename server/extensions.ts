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
  let chain = Promise.resolve()
  let closed = false
  async function reload() {
    const folders = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted()
    for (const name of folders) {
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
      if (record.facets.server) {
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
      } else {
        host.registry.uninstall({ name })
        documents.delete(name)
        delete record.server
      }
      if (!record.server?.error) host.builds.extension(name)
      records.set(name, record)
    }
    for (const name of records.keys()) {
      if (!folders.includes(name)) {
        host.registry.uninstall({ name })
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
        vite.moduleGraph.invalidateAll()
        await reload()
      })
      .catch((error) => {
        for (const record of records.values())
          if (record.server) record.server.error = String(error)
        changed()
      })
  }
  vite.watcher.add([directory, join(host.repoRoot, 'agents')])
  vite.watcher
    .on('change', onChange)
    .on('add', onChange)
    .on('unlink', onChange)
    .on('addDir', onChange)
    .on('unlinkDir', onChange)
  return {
    info: () => [...records.values()],
    doc: (kind: string) =>
      [...documents.values()].flat().find((doc) => doc.definition.kind === kind),
    async close() {
      closed = true
      for (const event of ['change', 'add', 'unlink', 'addDir', 'unlinkDir'])
        vite.watcher.off(event, onChange)
      await chain
    },
  }
}
export type Extensions = Awaited<ReturnType<typeof loadExtensions>>
