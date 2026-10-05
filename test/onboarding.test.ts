import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { fauxServer, post, temp, removeTemp } from './helpers.ts'
import { context } from '../server/harness.ts'
import { projectDecision } from '../server/project-setup.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'

it('gates project resources, remembers choices, and applies onboarding settings actions live', async () => {
  const home = await temp('ultimate-onboarding-')
  const project = join(home, 'project')
  const config = join(project, '.ultimate')
  const userFile = join(home, '.ultimate/settings.json')
  const projectFile = join(config, 'settings.json')
  await mkdir(join(config, 'extensions/x'), { recursive: true })
  await mkdir(join(config, 'agents'), { recursive: true })
  await mkdir(join(config, 'skills/local-skill'), { recursive: true })
  await writeFile(
    join(config, 'extensions/x/server.ts'),
    "import { defineExtension } from '@earendil-works/pi-durable'; export default defineExtension({ name: 'x' })",
  )
  await writeFile(join(config, 'extensions/x/web.tsx'), 'export default {}')
  await writeFile(
    join(config, 'extensions/x/README.md'),
    '# X\n\nA local extension. Another sentence.',
  )
  await writeFile(
    join(config, 'agents/y.md'),
    '---\nname: y\ndescription: Project agent\n---\nInspect the project.',
  )
  await writeFile(
    join(config, 'skills/local-skill/SKILL.md'),
    '---\nname: local-skill\ndescription: Project skill\n---\nInspect.',
  )
  await writeFile(join(config, 'README.md'), 'Project setup.\n' + 'x'.repeat(20000))
  await writeFile(
    projectFile,
    JSON.stringify({
      defaultSurface: 'workbench',
      custom: { keep: 1 },
      extensions: { enable: ['subagents'], extra: 'keep' },
    }),
  )
  const options = {
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
    firstRun: true,
  }
  let server: Awaited<ReturnType<typeof fauxServer>> | undefined
  const watchers: FSWatcher[] = []
  const snapshots: Promise<unknown>[] = []
  try {
    server = await fauxServer(options)
    for (const directory of [config, join(home, '.ultimate')]) {
      watchers.push(
        watch(directory, (_event, file) => {
          if (file === 'settings.json' || file === 'onboarding.json')
            snapshots.push(readFile(join(directory, file), 'utf8').then((text) => JSON.parse(text)))
        }),
      )
    }
    const action = async (name: string, args: unknown = {}) => {
      const response = await post(server!, `/api/extensions/onboarding/actions/${name}`, { args })
      expect(response.status).toBe(200)
      return response.data.result
    }
    const enabled = (name: string) =>
      server!.extensions.info().find((entry) => entry.name === name)?.enabled
    const web = async () =>
      Object.keys((await server!.vite.ssrLoadModule('virtual:ultimate/web-facets')).loaders)
    const tools = async () => (await server!.root.agent(context)).tools.map((tool) => tool.name)
    expect(await action('status')).toMatchObject({
      firstRun: true,
      // Undecided: the project's settings are not applied, but the page shows what they would enable.
      adds: {
        agents: ['y'],
        skills: ['local-skill'],
        extensions: ['x'],
        replaces: [],
        enable: ['subagents'],
        disable: [],
      },
    })
    expect(server.system.current().project).toMatchObject({
      config: true,
      decision: null,
      settings: {},
    })
    expect(Buffer.byteLength(server.system.current().project.readme!)).toBe(16384)
    expect(enabled('x')).toBe(false)
    expect(enabled('subagents')).toBe(false)
    expect(await tools()).not.toContain('subagent')
    expect(server.system.current().skills.some((skill) => skill.name === 'local-skill')).toBe(false)
    expect(
      (await action('extensions')).find((entry: { name: string }) => entry.name === 'x'),
    ).toMatchObject({
      source: 'project',
      enabled: false,
      layer: 'folder',
      readme: 'A local extension.',
    })
    const denied = await post(server, '/api/extensions/onboarding/actions/setExtension', {
      args: { name: 'clock', enabled: true, scope: 'project' },
    })
    expect(denied.status).toBe(500)
    expect(denied.data.error).toContain('local setup')
    await action('decide', { local: true })
    expect(enabled('x')).toBe(true)
    expect(enabled('subagents')).toBe(true)
    expect(await tools()).toContain('subagent')
    expect((await web()).some((path) => path.endsWith('/x/web.tsx'))).toBe(true)
    expect(server.system.current().skills.some((skill) => skill.name === 'local-skill')).toBe(true)
    const agents = await post(server, '/api/extensions/subagents/actions/definitions', { args: {} })
    expect(
      agents.data.result.definitions.some((agent: { name: string }) => agent.name === 'y'),
    ).toBe(true)
    expect(projectDecision(project, home)).toBe(true)
    await server.close()
    server = await fauxServer(options)
    expect(server.system.current().project.decision).toBe(true)
    expect(enabled('x')).toBe(true)
    await action('setExtension', { name: 'clock', enabled: true, scope: 'project' })
    expect(enabled('clock')).toBe(true)
    expect((await web()).some((path) => path.endsWith('/clock/web.tsx'))).toBe(true)
    await action('setExtension', { name: 'clock', enabled: false, scope: 'project' })
    expect(enabled('clock')).toBe(false)
    expect((await web()).some((path) => path.endsWith('/clock/web.tsx'))).toBe(false)
    const projectSettings = JSON.parse(await readFile(projectFile, 'utf8'))
    expect(projectSettings).toMatchObject({
      custom: { keep: 1 },
      defaultSurface: 'workbench',
      extensions: { extra: 'keep', enable: ['subagents'], disable: ['clock'] },
    })
    expect((await readFile(projectFile, 'utf8')).endsWith('\n')).toBe(true)
    await Promise.all(
      ['info', 'documents'].map((name) =>
        action('setExtension', { name, enabled: true, scope: 'user' }),
      ),
    )
    expect(JSON.parse(await readFile(userFile, 'utf8')).extensions.enable).toEqual(
      expect.arrayContaining(['info', 'documents']),
    )
    await action('setExtension', { name: 'theme', enabled: false, scope: 'user' })
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toEqual({
      extensions: { enable: expect.arrayContaining(['info', 'documents']), disable: ['theme'] },
    })
    await writeFile(
      userFile + '.tmp',
      JSON.stringify({ custom: 'user', extensions: { disable: ['theme'], extra: 2 } }),
    )
    await rename(userFile + '.tmp', userFile)
    await action('setExtension', { name: 'theme', enabled: true, scope: 'user' })
    expect(enabled('theme')).toBe(true)
    expect((await web()).some((path) => path.endsWith('/theme/web.tsx'))).toBe(true)
    await action('setExtension', { name: 'theme', enabled: false, scope: 'user' })
    expect(enabled('theme')).toBe(false)
    expect((await web()).some((path) => path.endsWith('/theme/web.tsx'))).toBe(false)
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toMatchObject({
      custom: 'user',
      extensions: { extra: 2, enable: [], disable: ['theme'] },
    })
    expect(
      (await action('extensions')).find((entry: { name: string }) => entry.name === 'clock').layer,
    ).toBe('project')
    expect(
      (await action('extensions')).find((entry: { name: string }) => entry.name === 'theme').layer,
    ).toBe('user')
    await action('decide', { local: false })
    expect(enabled('x')).toBe(false)
    expect(enabled('subagents')).toBe(false)
    expect(await tools()).not.toContain('subagent')
    expect((await web()).some((path) => path.endsWith('/x/web.tsx'))).toBe(false)
    expect(server.system.current().skills.some((skill) => skill.name === 'local-skill')).toBe(false)
    const adoptDenied = await post(server, '/api/extensions/onboarding/actions/adoptProjectSetup', {
      args: {},
    })
    expect(adoptDenied.status).toBe(500)
    await action('decide', { local: true })
    await action('adoptProjectSetup')
    await action('decide', { local: false })
    expect(enabled('subagents')).toBe(true)
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toMatchObject({
      custom: 'user',
      extensions: { extra: 2, enable: ['subagents'], disable: ['theme', 'clock'] },
    })
    const globalAgents = await post(server, '/api/extensions/subagents/actions/definitions', {
      args: {},
    })
    expect(
      globalAgents.data.result.definitions.some((agent: { name: string }) => agent.name === 'y'),
    ).toBe(false)
    await action('firstRunDone')
    expect((await action('status')).firstRun).toBe(false)
    expect(snapshots.length).toBeGreaterThan(0)
    await Promise.all(snapshots)
    for (const directory of [config, join(home, '.ultimate')])
      expect((await readdir(directory)).some((file) => file.endsWith('.tmp'))).toBe(false)
    await server.close()
    server = await fauxServer(options)
    expect(server.system.current().project.decision).toBe(false)
    expect(enabled('x')).toBe(false)
    expect((await action('status')).firstRun).toBe(false)
  } finally {
    for (const watcher of watchers) watcher.close()
    await server?.close()
    await removeTemp(home)
  }
}, 60000)

it('applies the first run in one action: the checked extensions, the project choice, and completion', async () => {
  const home = await temp('ultimate-first-run-')
  const project = join(home, 'project')
  const userFile = join(home, '.ultimate/settings.json')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(join(project, '.ultimate/settings.json'), '{"extensions":{"enable":["clock"]}}')
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    userFile,
    JSON.stringify({ custom: 1, extensions: { enable: ['info', 'theme'], disable: ['plan'] } }),
  )
  let server: Awaited<ReturnType<typeof fauxServer>> | undefined
  try {
    server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot: project,
      userHome: home,
      home: join(home, 'state'),
      localSetup: false,
      firstRun: true,
    })
    const enabled = (name: string) =>
      server!.extensions.info().find((entry) => entry.name === name)?.enabled
    const apply = (args: unknown) =>
      post(server!, '/api/extensions/onboarding/actions/applyFirstRun', { args })
    expect(
      (await post(server, '/api/extensions/onboarding/actions/status', { args: {} })).data.result
        .user,
    ).toEqual({ enable: ['info', 'theme'], disable: ['plan'] })
    for (const args of [
      {},
      { extensions: { plan: 'yes' } },
      { extensions: {}, local: 1 },
      { extensions: { '': true } },
      { extensions: { ' ': false } },
    ])
      expect((await apply(args)).status).toBe(500)
    expect(enabled('plan')).toBe(false)
    expect(enabled('info')).toBe(true)
    expect(enabled('clock')).toBe(false)

    const applied = await apply({
      extensions: { plan: true, tasks: true, info: false },
      local: true,
    })
    expect(applied).toEqual({ status: 200, data: { result: { firstRun: false } } })
    // Checked names join enable and leave disable; unchecked ones leave enable; other keys stay.
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toEqual({
      custom: 1,
      extensions: { enable: ['theme', 'plan', 'tasks'], disable: [] },
    })
    expect(projectDecision(project, home)).toBe(true)
    // Live, without a restart: the user's choices and the project's setup.
    expect(enabled('plan')).toBe(true)
    expect(enabled('tasks')).toBe(true)
    expect(enabled('info')).toBe(false)
    expect(enabled('clock')).toBe(true)
    const status = await post(server, '/api/extensions/onboarding/actions/status', { args: {} })
    expect(status.data.result.firstRun).toBe(false)
  } finally {
    await server?.close()
    await removeTemp(home)
  }
}, 60000)

it('does not inherit a parent project choice', async () => {
  const home = await temp('ultimate-trust-')
  try {
    const project = join(home, 'parent/child')
    await mkdir(project, { recursive: true })
    new ProjectTrustStore(join(home, '.ultimate')).set(join(home, 'parent'), true)
    expect(projectDecision(project, home)).toBe(null)
  } finally {
    await removeTemp(home)
  }
})

it('boots with corrupt trust, discloses project replacements, and recovers after repair', async () => {
  const home = await temp('ultimate-corrupt-trust-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate/extensions/codemode'), { recursive: true })
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(join(home, '.ultimate/trust.json'), '{bad')
  await writeFile(join(project, '.ultimate/README.md'), 'x'.repeat(16383) + '😀')
  let server: Awaited<ReturnType<typeof fauxServer>> | undefined
  try {
    server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot: project,
      userHome: home,
      home: join(home, 'state'),
      localSetup: false,
    })
    expect(server.system.current().project.decision).toBe(null)
    expect(server.system.current().extensionDiagnostics.join(' ')).toContain(
      'Failed to read trust store',
    )
    expect(server.system.current().project.readme).toBe('x'.repeat(16383) + '😀')
    const status = await post(server, '/api/extensions/onboarding/actions/status', { args: {} })
    expect(status.data.result.adds.replaces).toEqual(['codemode'])
    const rows = await post(server, '/api/extensions/onboarding/actions/extensions', { args: {} })
    expect(rows.data.result.find((row: { name: string }) => row.name === 'codemode')).toMatchObject(
      { source: 'project', replaces: 'builtin', enabled: false },
    )
    await writeFile(join(home, '.ultimate/trust.json'), '{}')
    const choice = await post(server, '/api/extensions/onboarding/actions/decide', {
      args: { local: true },
    })
    expect(choice.status).toBe(200)
    const userFile = join(home, '.ultimate/settings.json')
    await writeFile(userFile, '{"custom":1}')
    const adopted = await post(server, '/api/extensions/onboarding/actions/adoptProjectSetup', {
      args: {},
    })
    expect(adopted.status).toBe(200)
    expect(await readFile(userFile, 'utf8')).toBe('{"custom":1}')
    expect(server.system.current().extensionDiagnostics.join(' ')).not.toContain(
      'Failed to read trust store',
    )
  } finally {
    await server?.close()
    await removeTemp(home)
  }
}, 60000)
