import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { fauxServer, post, temp } from './helpers.ts'
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
      adds: { agents: ['y'], skills: ['local-skill'] },
    })
    expect(server.system.current().project).toMatchObject({
      config: true,
      decision: null,
      settings: { defaultSurface: 'workbench' },
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
    await action('setExtension', { name: 'theme', enabled: false, scope: 'user' })
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toEqual({
      extensions: { disable: ['theme'] },
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
    await action('adoptProjectSetup')
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
    await rm(home, { recursive: true, force: true })
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
    await rm(home, { recursive: true, force: true })
  }
})
