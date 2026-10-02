import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, realpath, readFile, rm, writeFile, rename, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  fauxServer as createServer,
  temp as tempDirectory,
  until,
  post as requestPost,
  sourceCopy,
  cleanEnv,
} from './helpers.ts'
import { context } from '../server/harness.ts'
import { projectHome } from '../server/project.ts'
import { actionExec } from '../server/actions.ts'
import type { SystemInfo } from '../shared/protocol.ts'
import { defineExtension } from '@earendil-works/pi-durable'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'

const directories: string[] = []
const servers: Awaited<ReturnType<typeof createServer>>[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true, maxRetries: 5 })
})
async function temp() {
  const path = await tempDirectory('ultimate-project-')
  directories.push(path)
  return path
}
async function post(url: string, path: string, args: unknown = null) {
  return requestPost(url, path, { args })
}
const source = (name: string) => `import { defineExtension } from '@earendil-works/pi-durable'
import { value } from './value.ts'
export default defineExtension({ name: ${JSON.stringify(name)} })
export const dependency = defineExtension
export const actions = {
  hello: async (args, ctx) => ({ args, value, cwd: (await ctx.exec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout }),
  fail: async () => { throw new Error('deliberate failure') },
  timeout: async (_args, ctx) => ctx.exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 20 })
}`
async function extension(root: string, name: string, value: string) {
  const path = join(root, 'extensions', name)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'value.ts'), `export const value = ${JSON.stringify(value)}`)
  await writeFile(join(path, 'server.ts'), source(name))
  await writeFile(
    join(path, 'web.tsx'),
    "import { defineWebExtension } from '@/sdk'; export default defineWebExtension({ name: 'hello' })",
  )
  return path
}

it('prints a single-line error for a missing project', async () => {
  const userHome = await temp()
  const ultimateRoot = await sourceCopy(userHome)
  const missing = join(userHome, 'missing')
  const child = spawn(
    process.execPath,
    [join(ultimateRoot, 'bin/ultimate.ts'), missing, '--no-open'],
    {
      cwd: ultimateRoot,
      env: cleanEnv({ HOME: userHome, ULTIMATE_HOME: join(userHome, 'state') }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  let error = ''
  child.stderr.on('data', (chunk) => {
    error += chunk
  })
  const [code] = await once(child, 'exit')
  expect(code).toBe(1)
  expect(error.trim().split('\n')).toEqual([`Cannot open project ${missing}: ENOENT`])
})

it('derives project storage from canonical roots and an injected user home', async () => {
  const home = await temp()
  const project = await realpath(await temp())
  const expected = join(
    home,
    '.ultimate/projects',
    project.split('/').at(-1)! +
      '-' +
      (await import('node:crypto')).createHash('sha256').update(project).digest('hex').slice(0, 8),
  )
  expect(projectHome(project, home)).toBe(expected)
  expect(projectHome(project + '/other', home)).not.toBe(expected)
})

it('survives invalid settings at boot and mid-run and clears errors after repair', async () => {
  const projectRoot = await temp()
  const userHome = await temp()
  const config = join(projectRoot, '.ultimate')
  await mkdir(config)
  const file = join(config, 'settings.json')
  await writeFile(file, '{bad')
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: true,
    port: 0,
  })
  servers.push(server)
  expect(server.system.current().project.settings).toEqual({})
  expect(server.system.current().project.settingsError).toContain('SyntaxError')
  await writeFile(file, '{"custom":1}')
  await until(() => server.system.current().project.settings.custom === 1)
  expect(server.system.current().project.settingsError).toBeUndefined()
  const notices: string[] = []
  server.events.listeners.add((name, data) => {
    if (name === 'notice') notices.push(JSON.stringify(data))
  })
  for (const invalid of ['[]', 'null', '42', '{bad']) {
    await writeFile(file, invalid)
    await server.system.changed()
    expect(server.system.current().project.settings).toEqual({})
    expect(server.system.current().project.settingsError).toBeTruthy()
  }
  expect(notices.length).toBeGreaterThan(0)
  await writeFile(file, '{}')
  await until(() => !server.system.current().project.settingsError)
})

it('discovers late project and user roots and follows extension symlinks with broken-link diagnostics', async () => {
  const projectRoot = await temp()
  const userHome = await temp()
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: true,
    port: 0,
  })
  servers.push(server)
  await server.vite.ssrLoadModule('virtual:ultimate/web-facets')
  for (const [root, name] of [
    [join(projectRoot, '.ultimate'), 'late-project'],
    [join(userHome, '.ultimate'), 'late-user'],
  ]) {
    const path = await extension(root, name, 'late')
    await until(
      () => !!server.extensions.info().find((entry) => entry.name === name)?.server?.loadedAt,
    )
    await until(
      async () =>
        !!(await server.vite.ssrLoadModule('virtual:ultimate/web-facets')).loaders[
          join(path, 'web.tsx')
        ],
    )
  }
  const external = await temp()
  const target = await extension(external, 'linked', 'linked')
  const link = join(projectRoot, '.ultimate/extensions/linked')
  await symlink(target, link)
  await until(
    () => !!server.extensions.info().find((entry) => entry.name === 'linked')?.server?.loadedAt,
  )
  expect((await post(server.url, '/api/extensions/linked/actions/hello')).data.result.value).toBe(
    'linked',
  )
  await symlink(join(external, 'missing'), join(projectRoot, '.ultimate/extensions/broken'))
  // Reload discovery even on watcher platforms that do not emit add for a dangling link.
  await rename(
    join(projectRoot, '.ultimate/extensions/broken'),
    join(projectRoot, '.ultimate/extensions/broken-link'),
  )
  await mkdir(join(projectRoot, '.ultimate/extensions/trigger'))
  await until(
    () => !!server.extensions.info().find((entry) => entry.name === 'broken-link')?.server?.error,
  )
})

it('loads external project facets over user and built-in names, actions and transitive reloads', async () => {
  const projectRoot = await temp()
  const userHome = await temp()
  await extension(join(userHome, '.ultimate'), 'coding-tools', 'user')
  const path = await extension(join(projectRoot, '.ultimate'), 'coding-tools', 'project')
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ defaultSurface: 'workbench', custom: 1 }),
  )
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: true,
    port: 0,
  })
  servers.push(server)
  expect(server.system.current().project).toEqual({
    root: projectRoot,
    name: projectRoot.split('/').at(-1),
    hasConfig: true,
    config: true,
    decision: true,
    settings: { defaultSurface: 'workbench', custom: 1 },
  })
  expect((await server.root.agent(context)).cwd).toBe(projectRoot)
  const record = () => server.extensions.info().find((entry) => entry.name === 'coding-tools')!
  expect(record()).toMatchObject({
    source: 'project',
    path,
    actions: ['hello', 'fail', 'timeout'],
    server: { tools: [] },
  })
  expect(record().server?.error).toBeUndefined()
  expect((await server.vite.ssrLoadModule(join(path, 'server.ts'))).dependency).toBe(
    defineExtension,
  )
  const virtual = await server.vite.ssrLoadModule('virtual:ultimate/web-facets')
  expect(typeof virtual.loaders[join(path, 'web.tsx')]).toBe('function')
  expect(
    typeof virtual.loaders[join(server.host.ultimateRoot, 'extensions/status-line/web.tsx')],
  ).toBe('function')
  const added = join(projectRoot, '.ultimate/extensions/added')
  await mkdir(added, { recursive: true })
  await writeFile(join(added, 'web.tsx'), 'export default {}')
  await until(
    async () =>
      !!(await server.vite.ssrLoadModule('virtual:ultimate/web-facets')).loaders[
        join(added, 'web.tsx')
      ],
  )
  await rm(added, { recursive: true })
  await until(
    async () =>
      !(await server.vite.ssrLoadModule('virtual:ultimate/web-facets')).loaders[
        join(added, 'web.tsx')
      ],
  )
  const browser = await fetch(server.url + '/@fs/' + join(path, 'web.tsx'))
  expect(browser.status).toBe(200)
  expect(await browser.text()).toContain('defineWebExtension')
  expect(
    await post(server.url, '/api/extensions/coding-tools/actions/hello', { ok: true }),
  ).toEqual({
    status: 200,
    data: { result: { args: { ok: true }, value: 'project', cwd: projectRoot } },
  })
  expect((await post(server.url, '/api/extensions/coding-tools/actions/unknown')).status).toBe(404)
  expect(await post(server.url, '/api/extensions/coding-tools/actions/fail')).toEqual({
    status: 500,
    data: { error: 'deliberate failure' },
  })
  expect((await post(server.url, '/api/extensions/coding-tools/actions/timeout')).status).toBe(500)
  expect(
    (
      await fetch(server.url + '/api/extensions/coding-tools/actions/hello', {
        method: 'POST',
        body: '{bad',
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await fetch(server.url + '/api/extensions/coding-tools/actions/hello', {
        method: 'POST',
        headers: { Origin: 'https://example.com' },
        body: '{}',
      })
    ).status,
  ).toBe(403)
  const loaded = record().server!.loadedAt
  await writeFile(join(path, 'value.ts'), "export const value = 'edited'")
  await until(
    async () =>
      record().server!.loadedAt !== loaded &&
      (await post(server.url, '/api/extensions/coding-tools/actions/hello')).data.result.value ===
        'edited',
  )
  expect(
    (await post(server.url, '/api/extensions/coding-tools/actions/hello')).data.result.value,
  ).toBe('edited')
  await rm(path, { recursive: true })
  await until(() => record().source === 'user')
  expect(
    (await post(server.url, '/api/extensions/coding-tools/actions/hello')).data.result.value,
  ).toBe('user')
})

it('discovers user/project agents and skills with provenance and hot config changes', async () => {
  const projectRoot = await temp()
  const userHome = await temp()
  const user = join(userHome, '.ultimate')
  const project = join(projectRoot, '.ultimate')
  for (const root of [user, project]) {
    await mkdir(join(root, 'agents'), { recursive: true })
    await mkdir(join(root, 'skills/ult25-inspect'), { recursive: true })
    await writeFile(
      join(root, 'agents/scout.md'),
      `---\nname: scout\ndescription: ${root === user ? 'User' : 'Project'} scout\n---\nInspect.`,
    )
    await writeFile(
      join(root, 'skills/ult25-inspect/SKILL.md'),
      `---\nname: ult25-inspect\ndescription: ${root === user ? 'User' : 'Project'} skill\n---\nInspect.`,
    )
  }
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: true,
    port: 0,
  })
  servers.push(server)
  await writeFile(
    join(project, 'settings.json'),
    JSON.stringify({ extensions: { enable: ['subagents'] } }),
  )
  await until(
    () => !!server.extensions.info().find((entry) => entry.name === 'subagents')?.server?.loadedAt,
  )
  // The subagents extension rereads definitions on every call; skills come with system info.
  const agent = async () =>
    (
      await post(server.url, '/api/extensions/subagents/actions/definitions')
    ).data.result.definitions.find((entry: { name: string }) => entry.name === 'scout')
  const skill = () =>
    server.system.current().skills.find((entry) => entry.name === 'ult25-inspect')!
  expect(await agent()).toMatchObject({
    source: 'project',
    description: 'Project scout',
    path: join(project, 'agents/scout.md'),
  })
  expect(skill()).toMatchObject({
    description: 'Project skill',
    path: join(project, 'skills/ult25-inspect/SKILL.md'),
  })
  await writeFile(
    join(project, 'agents/scout.md'),
    '---\nname: scout\ndescription: Edited scout\n---\nInspect.',
  )
  expect(await agent()).toMatchObject({ description: 'Edited scout' })
  await rm(join(project, 'agents/scout.md'))
  await rm(join(project, 'skills/ult25-inspect'), { recursive: true })
  expect(await agent()).toMatchObject({ source: 'user', description: 'User scout' })
  await until(() => skill().description === 'User skill')
})

it('exec times out, caps output and defaults to the project without a shell', async () => {
  const root = await temp()
  const exec = actionExec(root, new AbortController().signal)
  expect((await exec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout).toBe(
    root,
  )
  await expect(
    exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 20 }),
  ).rejects.toThrow('Command failed')
  await expect(
    exec(process.execPath, ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]),
  ).rejects.toThrow('maxBuffer')
})

it('starts two project supervisors concurrently on distinct free ports and storage, serving hello live', async () => {
  const userHome = await temp()
  const ultimateRoot = await sourceCopy(userHome)
  const projects = [await temp(), await temp()]
  await extension(join(projects[0], '.ultimate'), 'hello', 'live')
  const launch = (project: string) => {
    const home = projectHome(project, userHome)
    new ProjectTrustStore(join(userHome, '.ultimate')).set(project, true)
    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(),
      HOME: userHome,
      ULTIMATE_HOME: home,
      ULTIMATE_FAUX: '1',
    }
    delete env.ULTIMATE_PORT
    const child = spawn(
      process.execPath,
      [join(ultimateRoot, 'bin/ultimate.ts'), project, '--no-open', '--port', '0'],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.push(child)
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
    })
    child.stderr.on('data', (data) => {
      output += data
    })
    return { home, output: () => output }
  }
  const runs = projects.map(launch)
  await until(() => runs.every((run) => run.output().includes('Ultimate: http://')))
  const urls = runs.map((run) => /Ultimate: (http:\/\/[^\s]+)/.exec(run.output())![1])
  expect(urls[0]).not.toBe(urls[1])
  expect(runs[0].home).not.toBe(runs[1].home)
  for (const [index, run] of runs.entries()) {
    const owner = JSON.parse(await readFile(join(run.home, 'ultimate.lock'), 'utf8'))
    expect(owner).toMatchObject({
      project: projects[index],
      port: Number(new URL(urls[index]).port),
    })
    expect(owner.port).toBeGreaterThan(0)
    expect(existsSync(join(run.home, 'state.sqlite'))).toBe(true)
    const controller = new AbortController()
    const response = await fetch(urls[index] + '/api/events', { signal: controller.signal })
    const reader = response.body!.getReader()
    let wire = ''
    while (!wire.includes('event: system\n'))
      wire += new TextDecoder().decode((await reader.read()).value)
    const system = JSON.parse(/event: system\ndata: (.+)/.exec(wire)![1]) as SystemInfo
    controller.abort()
    expect(system.project.root).toBe(projects[index])
    expect(system.persistence.path).toBe(join(run.home, 'state.sqlite'))
  }
  expect(await post(urls[0], '/api/extensions/hello/actions/hello', 'hi')).toEqual({
    status: 200,
    data: { result: { args: 'hi', value: 'live', cwd: projects[0] } },
  })
}, 60000)
