import { removeTemp } from './helpers.ts'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { fauxServer, sourceCopy, temp, until, attach } from './helpers.ts'
import { context } from '../server/harness.ts'
import { compareExtensions, discoverExtensions } from '../server/discovery.ts'
import { createRegistry, toolRenderers } from '../web/src/sdk/registry.ts'

const homes: string[] = []
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
// Tests run concurrently, each on its own server; close them all once the file is done.
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const home of homes.splice(0)) await removeTemp(home)
})
async function fixture(settings?: string) {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  if (settings !== undefined) {
    await mkdir(join(home, '.ultimate'))
    await writeFile(join(home, '.ultimate/settings.json'), settings)
  }
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  return { home, projectRoot, server }
}
it.concurrent('orders facets by source so a project bash tool and renderer win regardless of folder name', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  for (const [name, root] of [
    ['zzz-bash', home],
    ['aaa-bash', projectRoot],
  ]) {
    const folder = join(root, '.ultimate/extensions', name)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'web.tsx'), 'export default { tools: { bash: () => null } }')
    await writeFile(
      join(folder, 'server.ts'),
      `
      import { Type } from '@earendil-works/pi-ai'
      import { defineExtension, defineTool } from '@earendil-works/pi-durable'
      export default defineExtension({ name: '${name}', tools: [defineTool({
        name: 'bash', description: '${name}', parameters: Type.Object({}),
        execute: async () => ({})
      })] })
    `,
    )
  }
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  expect(
    server.extensions
      .info()
      .filter((e) => ['coding-tools', 'zzz-bash', 'aaa-bash'].includes(e.name))
      .map((e) => e.name),
  ).toEqual(['coding-tools', 'zzz-bash', 'aaa-bash'])
  expect(
    (await server.root.agent(context)).tools.find((tool) => tool.name === 'bash')?.description,
  ).toBe('aaa-bash')
  const paths = (await web(server)).filter((path) =>
    ['coding-tools', 'zzz-bash', 'aaa-bash'].some((name) => path.includes(`/${name}/`)),
  )
  const registry = createRegistry()
  await registry.setLoaders(
    Object.fromEntries(
      paths.map((path) => [
        path,
        () =>
          // The built-in UI needs browser globals; only its registry position matters here.
          path.includes('/coding-tools/')
            ? Promise.resolve({ default: { tools: { bash: () => null } } })
            : server.vite.ssrLoadModule(path),
      ]),
    ),
  )
  expect(registry.getSnapshot().every((record) => !record.error)).toBe(true)
  expect(toolRenderers(registry.getSnapshot(), 'bash').at(-1)?.extension).toBe('aaa-bash')
  // An explicit server order still takes precedence over source layering.
  expect(
    [
      { name: 'coding-tools', source: 'builtin' as const },
      { name: 'aaa-bash', source: 'project' as const, order: -100 },
    ]
      .toSorted(compareExtensions)
      .map((e) => e.name),
  ).toEqual(['aaa-bash', 'coding-tools'])
})

const serviceFacet = (detail: string, fail = false) => `
import { defineExtension } from '@earendil-works/pi-durable'
export const actions = { lookup: async (_args, { host }) => host.use('service-test'), stale: async (_args, { host }) => {
  const saved = host.resource('service-test:handles', () => [])
  saved[0].update({ state: 'error', detail: 'stale update' })
  saved[0].dispose()
} }
export default (host) => {
  host.provide('service-test', { detail: '${detail}' })
  const status = host.service('worker', { state: 'starting', detail: '${detail}' })
  host.resource('service-test:handles', () => []).push(status)
  ${fail ? "throw new Error('failed service installation')" : ''}
  host.onOpen(async () => status.update({ state: 'ready', detail: '${detail}' }))
  return defineExtension({ name: 'service-test' })
}`
it.concurrent('stages service rows, preserves them on failed reload and removes stale handles on replacement and disable', async () => {
  const { home, projectRoot, server } = await fixture()
  const folder = join(projectRoot, '.ultimate/extensions/service-test')
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'server.ts')
  await writeFile(file, serviceFacet('first'))
  await until(() =>
    server.extensions.services().some((s) => s.detail === 'first' && s.state === 'ready'),
  )
  const lookup = () =>
    server.extensions.invoke('service-test', 'lookup', {}, new AbortController().signal)
  expect(await lookup()).toEqual({ detail: 'first' })
  await writeFile(file, serviceFacet('failed', true))
  server.vite.watcher.emit('change', file)
  await until(
    () =>
      server.extensions
        .info()
        .find((e) => e.name === 'service-test')
        ?.server?.error?.includes('failed service installation') === true,
  )
  expect(server.extensions.services().filter((s) => s.extension === 'service-test')).toEqual([
    { extension: 'service-test', name: 'worker', state: 'ready', detail: 'first' },
  ])
  expect(await lookup()).toEqual({ detail: 'first' })
  await writeFile(file, serviceFacet('replacement'))
  server.vite.watcher.emit('change', file)
  await until(() =>
    server.extensions.services().some((s) => s.detail === 'replacement' && s.state === 'ready'),
  )
  expect(await lookup()).toEqual({ detail: 'replacement' })
  await server.extensions.invoke('service-test', 'stale', {}, new AbortController().signal)
  expect(server.extensions.services().filter((s) => s.extension === 'service-test')).toEqual([
    { extension: 'service-test', name: 'worker', state: 'ready', detail: 'replacement' },
  ])
  const consumer = join(projectRoot, '.ultimate/extensions/service-consumer')
  await mkdir(consumer, { recursive: true })
  await writeFile(
    join(consumer, 'server.ts'),
    `
    import { defineExtension } from '@earendil-works/pi-durable'
    export const actions = { lookup: async (_args, { host }) => host.use('service-test') ?? null }
    export default defineExtension({ name: 'service-consumer' })
  `,
  )
  await until(() => !!server.extensions.action('service-consumer', 'lookup'))
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['service-test'] } }),
  )
  await until(
    () => server.extensions.info().find((e) => e.name === 'service-test')?.enabled === false,
  )
  expect(server.extensions.services().some((s) => s.extension === 'service-test')).toBe(false)
  expect(
    await server.extensions.invoke('service-consumer', 'lookup', {}, new AbortController().signal),
  ).toBeNull()
})

it.concurrent('keeps the replacement provider available while the old cleanup is pending', async () => {
  const { projectRoot, server } = await fixture()
  const folder = join(projectRoot, '.ultimate/extensions/service-test')
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'server.ts')
  await writeFile(
    file,
    serviceFacet('first')
      .replace(
        'lookup: async',
        "gate: async (_args, { host }) => host.resource('service-test:cleanup', () => null), lookup: async",
      )
      .replace(
        'host.onOpen(async',
        "const gate = host.resource('service-test:cleanup', () => ({ started: Promise.withResolvers(), cleanup: Promise.withResolvers() })); host.onClose(async () => { gate.started.resolve(); await gate.cleanup.promise }); host.onOpen(async",
      ),
  )
  await until(() => !!server.extensions.action('service-test', 'lookup'))
  const lookup = () =>
    server.extensions.invoke('service-test', 'lookup', {}, new AbortController().signal)
  expect(await lookup()).toEqual({ detail: 'first' })
  const { started, cleanup } = (await server.extensions.invoke(
    'service-test',
    'gate',
    {},
    new AbortController().signal,
  )) as unknown as { started: PromiseWithResolvers<void>; cleanup: PromiseWithResolvers<void> }
  try {
    await writeFile(file, serviceFacet('replacement'))
    server.vite.watcher.emit('change', file)
    await started.promise
    expect(await lookup()).toEqual({ detail: 'replacement' })
  } finally {
    cleanup.resolve()
  }
  await until(() =>
    server.extensions.services().some((s) => s.detail === 'replacement' && s.state === 'ready'),
  )
  expect(await lookup()).toEqual({ detail: 'replacement' })
})

const tools = async (server: Awaited<ReturnType<typeof fauxServer>>) =>
  (await server.root.agent(context)).tools.map((tool) => tool.name).toSorted()
const web = async (server: Awaited<ReturnType<typeof fauxServer>>) =>
  Object.keys((await server.vite.ssrLoadModule('virtual:ultimate/web-facets')).loaders)

it.concurrent('layers settings live, installs and uninstalls tools and web facets, and notices unknown names once', async () => {
  const { home, projectRoot, server } = await fixture()
  const config = join(projectRoot, '.ultimate')
  const settings = join(config, 'settings.json')
  const initialBuild = server.host.build().id
  const promptLoaded = server.extensions.info().find((entry) => entry.name === 'prompt')
    ?.server?.loadedAt
  expect(server.host.build().extensions.subagents).toBeDefined()
  await mkdir(config)
  await writeFile(settings, JSON.stringify({ extensions: { disable: ['subagents'] } }))
  await until(async () => !(await tools(server)).includes('subagent'))
  await until(async () => !(await web(server)).some((path) => path.includes('/subagents/')))
  expect(server.host.build().id).not.toBe(initialBuild)
  expect(server.host.build().extensions.subagents).toBeUndefined()
  expect(server.extensions.info().find((entry) => entry.name === 'prompt')?.server?.loadedAt).toBe(
    promptLoaded,
  )
  await rm(settings)
  await until(async () => (await tools(server)).includes('subagent'))
  await until(async () => (await web(server)).some((path) => path.includes('/subagents/')))
  expect(server.host.build().id).toBe(initialBuild)
  const folder = join(config, 'extensions/local')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'server.ts'),
    "import { defineExtension } from '@earendil-works/pi-durable'; export default defineExtension({ name: 'local' })",
  )
  await until(() => !!server.extensions.info().find((entry) => entry.name === 'local')?.server)
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['theme', 'subagents'] } }),
  )
  await until(
    () => server.extensions.info().find((entry) => entry.name === 'theme')?.enabled === false,
  )
  const connection = await attach(server)
  try {
    await writeFile(
      settings,
      JSON.stringify({ extensions: { enable: ['subagents', 'unknown'], disable: ['local'] } }),
    )
    await until(
      async () =>
        (await tools(server)).includes('subagent') &&
        !server.extensions.info().find((entry) => entry.name === 'local')?.enabled,
    )
    expect(server.extensions.info().find((entry) => entry.name === 'local')?.server).toBeUndefined()
    expect(
      server.host.registry
        .snapshot()
        .installed()
        .some((entry) => entry.name === 'theme' || entry.name === 'local'),
    ).toBe(false)
    await until(() =>
      connection.events.some(
        (entry) =>
          entry.name === 'notice' &&
          JSON.stringify(entry.data).includes('Unknown extension: unknown'),
      ),
    )
    await writeFile(join(folder, 'README.md'), 'Local extension.')
    await until(
      () =>
        server.extensions.info().find((entry) => entry.name === 'local')?.readme ===
        'Local extension.',
    )
    expect(
      connection.events.filter(
        (entry) =>
          entry.name === 'notice' &&
          JSON.stringify(entry.data).includes('Unknown extension: unknown'),
      ),
    ).toHaveLength(1)
  } finally {
    await connection.close()
  }
})

it.concurrent('retains valid enablement through invalid edits and delivers startup diagnostics to later clients', async () => {
  const valid = { extensions: { enable: ['unknown-startup'], disable: ['subagents'] } }
  const { home, server } = await fixture(JSON.stringify(valid))
  const settings = join(home, '.ultimate/settings.json')
  const connection = await attach(server)
  try {
    expect(connection.system().extensionDiagnostics).toEqual(['Unknown extension: unknown-startup'])
    expect(await tools(server)).not.toContain('subagent')
    const build = server.host.build().id
    const loadedAt = server.extensions.info().find((entry) => entry.name === 'plan')
      ?.server?.loadedAt
    for (const invalid of [
      '{"extensions":',
      '{"extensions":{"enable":"x"}}',
      '{"extensions":{"enable":["plan"],"disable":"x"}}',
    ]) {
      await writeFile(settings, invalid)
      server.vite.watcher.emit('change', settings)
      await until(() =>
        server.system
          .current()
          .extensionDiagnostics.some((message) => message.startsWith(settings + ':')),
      )
      expect(await tools(server)).not.toContain('subagent')
      expect((await web(server)).some((path) => path.includes('/subagents/'))).toBe(false)
      expect(server.host.build().id).toBe(build)
      expect(
        server.extensions.info().find((entry) => entry.name === 'plan')?.server?.loadedAt,
      ).toBe(loadedAt)
      await writeFile(settings, JSON.stringify(valid))
      server.vite.watcher.emit('change', settings)
      await until(() => server.system.current().extensionDiagnostics.length === 1)
    }
    const notices = () =>
      connection.events.filter(
        (event) =>
          event.name === 'notice' &&
          JSON.stringify(event.data).includes('Unknown extension: unknown-startup'),
      ).length
    const before = notices()
    await writeFile(settings, JSON.stringify({ ...valid, unrelated: 'ignored' }, null, 2))
    server.vite.watcher.emit('change', settings)
    await until(() => notices() > before)
    expect(server.host.build().id).toBe(build)
    await writeFile(settings, JSON.stringify({ extensions: { disable: ['plan'] } }))
    server.vite.watcher.emit('change', settings)
    await until(
      async () =>
        (await tools(server)).includes('subagent') && !(await tools(server)).includes('plan'),
    )
    // Registry changes happen before the refreshed system snapshot is published.
    await until(() => server.system.current().extensionDiagnostics.length === 0)
    expect(server.system.current().extensionDiagnostics).toEqual([])
  } finally {
    await connection.close()
  }
})

it.concurrent('enables every built-in by default', async () => {
  const home = await temp()
  homes.push(home)
  const root = await sourceCopy(home)
  const discovered = await discoverExtensions(root, root, home)
  const server = await fauxServer({
    ultimateRoot: root,
    projectRoot: root,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  expect(server.extensions.info().every((entry) => entry.enabled && !entry.server?.error)).toBe(
    true,
  )
  expect(discovered.every((entry) => entry.enabled)).toBe(true)
  expect(discovered.map((entry) => entry.name)).toContain('tailscale')
})
