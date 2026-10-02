import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxServer, sourceCopy, temp, until, attach } from './helpers.ts'
import { context } from '../server/harness.ts'
import { DEFAULT_EXTENSIONS } from '../server/extension-settings.ts'
import { discoverExtensions } from '../server/discovery.ts'

const homes: string[] = []
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
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
const tools = async (server: Awaited<ReturnType<typeof fauxServer>>) =>
  (await server.root.agent(context)).tools.map((tool) => tool.name).toSorted()
const web = async (server: Awaited<ReturnType<typeof fauxServer>>) =>
  Object.keys((await server.vite.ssrLoadModule('virtual:ultimate/web-facets')).loaders)

it('starts bare with exactly the default extensions and tools, and exposes off building blocks', async () => {
  const { server } = await fixture()
  expect(
    server.extensions
      .info()
      .filter((entry) => entry.enabled)
      .map((entry) => entry.name)
      .toSorted(),
  ).toEqual([...DEFAULT_EXTENSIONS].toSorted())
  expect(
    server.host.registry
      .snapshot()
      .installed()
      .map((entry) => entry.name)
      .toSorted(),
  ).toEqual(
    server.extensions
      .info()
      .filter((entry) => entry.enabled && entry.facets.server)
      .map((entry) => entry.name)
      .toSorted(),
  )
  expect(await tools(server)).toEqual(
    ['read', 'write', 'edit', 'bash', 'codemode', 'screenshot', 'browser'].toSorted(),
  )
  const info = server.system.current().extensions
  expect(info.filter((entry) => !entry.enabled).map((entry) => entry.name)).toEqual([
    'clock',
    'documents',
    'exclusive-commands',
    'info',
    'instance',
    'plan',
    'self',
    'subagents',
    'surfaces',
    'tasks',
  ])
  expect((await web(server)).some((path) => path.includes('/subagents/'))).toBe(false)
})

it('layers settings live, installs and uninstalls tools and web facets, and notices unknown names once', async () => {
  const { home, projectRoot, server } = await fixture()
  const config = join(projectRoot, '.ultimate')
  const settings = join(config, 'settings.json')
  const initialBuild = server.host.build().id
  const promptLoaded = server.extensions.info().find((entry) => entry.name === 'prompt')
    ?.server?.loadedAt
  expect(server.host.build().extensions.subagents).toBeUndefined()
  await mkdir(config)
  await writeFile(settings, JSON.stringify({ extensions: { enable: ['subagents'] } }))
  await until(async () => (await tools(server)).includes('subagent'))
  expect((await web(server)).some((path) => path.includes('/subagents/'))).toBe(true)
  expect(server.host.build().id).not.toBe(initialBuild)
  expect(server.host.build().extensions.subagents).toBeDefined()
  expect(server.extensions.info().find((entry) => entry.name === 'prompt')?.server?.loadedAt).toBe(
    promptLoaded,
  )
  await rm(settings)
  await until(async () => !(await tools(server)).includes('subagent'))
  expect((await web(server)).some((path) => path.includes('/subagents/'))).toBe(false)
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

it('retains valid enablement through invalid edits and delivers startup diagnostics to later clients', async () => {
  const valid = { extensions: { enable: ['subagents', 'unknown-startup'] } }
  const { home, server } = await fixture(JSON.stringify(valid))
  const settings = join(home, '.ultimate/settings.json')
  const connection = await attach(server)
  try {
    expect(connection.system().extensionDiagnostics).toEqual(['Unknown extension: unknown-startup'])
    expect(await tools(server)).toContain('subagent')
    const build = server.host.build().id
    const loadedAt = server.extensions.info().find((entry) => entry.name === 'subagents')
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
      expect(await tools(server)).toContain('subagent')
      expect((await web(server)).some((path) => path.includes('/subagents/'))).toBe(true)
      expect(server.host.build().id).toBe(build)
      expect(
        server.extensions.info().find((entry) => entry.name === 'subagents')?.server?.loadedAt,
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
    await writeFile(settings, JSON.stringify({ extensions: { enable: ['plan'] } }))
    server.vite.watcher.emit('change', settings)
    await until(
      async () =>
        !(await tools(server)).includes('subagent') && (await tools(server)).includes('plan'),
    )
    expect(server.system.current().extensionDiagnostics).toEqual([])
  } finally {
    await connection.close()
  }
})

it('enables the full repository set including github-triage', async () => {
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
  expect(
    server.host.registry
      .snapshot()
      .installed()
      .some((entry) => entry.name === 'github-triage'),
  ).toBe(true)
  expect(discovered.every((entry) => entry.enabled)).toBe(true)
  expect(discovered.map((entry) => entry.name)).toEqual(
    [
      ...DEFAULT_EXTENSIONS,
      'clock',
      'documents',
      'exclusive-commands',
      'info',
      'instance',
      'plan',
      'self',
      'subagents',
      'surfaces',
      'tasks',
      'github-triage',
    ].toSorted(),
  )
})
