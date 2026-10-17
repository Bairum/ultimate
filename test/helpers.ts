import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import type { ConversationId, ConversationView, Harness } from '@earendil-works/pi-durable'
import { afterAll, vi } from 'vitest'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { Tally } from '../extensions/lineage/server.ts'
import { context } from '../server/harness.ts'
import { createServer, prepareServer } from '../server/main.ts'
import type { ServerOptions } from '../server/main.ts'
import type { ServerEvents, SystemInfo } from '../shared/protocol.ts'

vi.mock('@earendil-works/pi-ai/providers/faux', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-ai/providers/faux')>()
  return {
    ...original,
    fauxProvider: (options: Parameters<typeof original.fauxProvider>[0]) =>
      original.fauxProvider({ ...options, tokensPerSecond: 0 }),
  }
})

export function cleanEnv(extra: NodeJS.ProcessEnv = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('ULTIMATE_')),
    ),
    ...extra,
  }
}
// Tests run without the supervisor's ULTIMATE_* variables: removed once, not stubbed per test, so concurrent tests never
// see them come back. Stubs a test leaves behind end with its file; stubbing restores to unset.
for (const key of Object.keys(process.env)) if (key.startsWith('ULTIMATE_')) delete process.env[key]
afterAll(() => vi.unstubAllEnvs())

// Every temp() directory is removed once the test file finishes, so runs do not fill the tmpfs.
const temps = new Set<string>()
afterAll(removeTemps, 60_000)
export async function removeTemps() {
  // Delete disjoint roots only: source copies are registered inside their fixture homes.
  const paths = [...temps]
  const roots = paths.filter((path) => !paths.some((parent) => path.startsWith(parent + sep)))
  await Promise.all(roots.map(removeTemp))
}
export async function removeTemp(path: string) {
  for (const registered of temps)
    if (registered === path || registered.startsWith(path + sep)) temps.delete(registered)
  // Best effort: a closing Vite optimizer can still be writing deps_temp, and cleanup must not fail a test.
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {})
}
export async function temp(prefix = 'ultimate-test-', parent = tmpdir()) {
  const path = await mkdtemp(join(parent, prefix))
  temps.add(path)
  return path
}
export async function linkDependencies(root: string) {
  const target = join(root, 'node_modules')
  await mkdir(target)
  for (const name of await readdir(resolve('node_modules'))) {
    if (name.startsWith('.vite')) continue
    await symlink(resolve('node_modules', name), join(target, name))
  }
}
export async function sourceCopy(parent: string) {
  await mkdir(parent, { recursive: true })
  const root = await temp('source-', parent)
  await cp(resolve('.'), root, {
    recursive: true,
    filter: (path) =>
      !['.git', 'node_modules'].includes(path.slice(resolve('.').length + 1).split('/')[0]),
  })
  await linkDependencies(root)
  const config = join(root, 'vite.config.ts')
  // Optimize on page requests, not fixture boot; React's plugin otherwise eagerly includes deps.
  await writeFile(
    config,
    (await readFile(config, 'utf8'))
      .replace(
        'export default defineConfig({',
        "export default defineConfig({ cacheDir: '.vite-cache', optimizeDeps: { entries: [] },",
      )
      .replace(
        'plugins: [react(), tailwindcss()],',
        "plugins: [react(), tailwindcss(), { name: 'test:lazy-deps', configResolved(config) { config.optimizeDeps.include = [] } }],",
      ),
  )
  new ProjectTrustStore(join(parent, '.ultimate')).set(root, true)
  return root
}
type FixtureOptions = ServerOptions & {
  home: string
  userHome: string
  localSetup?: boolean
  /** Keep the first-run welcome; by default it is marked done so it does not cover the UI under test. */
  firstRun?: boolean
}
async function isolated(options: FixtureOptions) {
  const { home, userHome } = options
  const ultimateRoot =
    options.ultimateRoot === resolve('.') ? await sourceCopy(home) : options.ultimateRoot
  const projectRoot =
    !options.projectRoot || options.projectRoot === resolve('.')
      ? ultimateRoot
      : options.projectRoot
  if (options.localSetup !== false)
    new ProjectTrustStore(join(userHome, '.ultimate')).set(projectRoot, true)
  if (!options.firstRun) {
    await mkdir(join(userHome, '.ultimate'), { recursive: true })
    await writeFile(join(userHome, '.ultimate/onboarding.json'), '{"firstRunDone":true}\n')
  }
  const { firstRun: _firstRun, ...server } = options
  return {
    ...server,
    ultimateRoot,
    projectRoot,
    userHome,
    home,
    faux: true,
    port: options.port ?? 0,
  }
}
export async function fauxServer(options: FixtureOptions) {
  const server = await createServer(await isolated(options))
  const close = server.close.bind(server)
  server.close = async () => {
    await server.vite.watcher.close()
    await close()
  }
  return server
}
export async function prepareFauxServer(options: FixtureOptions) {
  return prepareServer(await isolated(options))
}
/**
 * Make the empty root `id` (default the project's first conversation) a tally from an empty head, as if it had read
 * nothing yet, so tests can branch from it. Does nothing when it already has entries.
 */
export async function seedTally(harness: Harness, id = 1) {
  await harness.commit(async (tx) => {
    const root = id as ConversationId
    if ((await tx.scanEntries({ conversationId: root }, 1)).items.length) return
    const entry = await tx.appendEntry(root, { kind: 'pi.reset', head: 'self' })
    ;(await tx.doc(Tally, root)).since = entry.id
  }, context)
}
export async function until(test: () => boolean | Promise<boolean>, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await new Promise((done) => setTimeout(done, 30))
  }
}
export async function post(server: string | { url: string }, path: string, data: unknown = {}) {
  const url = typeof server === 'string' ? server : server.url
  const response = await fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify(data),
  })
  return { status: response.status, data: await response.json() }
}
export async function attach(server: string | { url: string }, query = '') {
  const url = typeof server === 'string' ? server : server.url
  const controller = new AbortController()
  const events: { name: keyof ServerEvents; data: unknown }[] = []
  let system: SystemInfo | undefined
  let view: ConversationView | undefined
  let connections = 0
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(url + '/api/events' + query, { signal: controller.signal })
        if (response.status !== 200) throw new Error(`SSE status ${response.status}`)
        connections++
        const reader = response.body!.getReader()
        let wire = ''
        while (!controller.signal.aborted) {
          const result = await reader.read()
          if (result.done) break
          wire += new TextDecoder().decode(result.value)
          let index: number
          while ((index = wire.indexOf('\n\n')) !== -1) {
            const block = wire.slice(0, index)
            wire = wire.slice(index + 2)
            const name = /^event: (.+)$/m.exec(block)?.[1] as keyof ServerEvents | undefined
            const data = /^data: (.+)$/m.exec(block)?.[1]
            if (!name || !data) continue
            const parsed: unknown = JSON.parse(data)
            events.push({ name, data: parsed })
            if (name === 'system') system = parsed as SystemInfo
            if (name === 'view') view = parsed as ConversationView
            if (name === 'ops' && view) view = applyImmutable(view, parsed as Op[])
          }
        }
      } catch (error) {
        if (controller.signal.aborted) break
        if (!String(error).includes('fetch failed') && !String(error).includes('terminated'))
          throw error
      }
      await new Promise((done) => setTimeout(done, 50))
    }
  })()
  await until(() => !!view)
  return {
    events,
    system: () => system!,
    view: () => view!,
    connections: () => connections,
    async close() {
      controller.abort()
      await task
    },
  }
}
