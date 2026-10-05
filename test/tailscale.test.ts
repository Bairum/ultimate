import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import tailscale, { actions } from '../extensions/tailscale/server.ts'
import type { Status } from '../extensions/tailscale/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { createAccess } from '../server/request-security.ts'
import { fauxServer, linkDependencies, post, temp, until } from './helpers.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0)) await close()
  vi.unstubAllEnvs()
})
const node = {
  BackendState: 'Running',
  Self: { DNSName: 'rog.example.ts.net.', UserID: 7 },
  User: { '7': { LoginName: 'owner@example.com' } },
  CertDomains: ['rog.example.ts.net'],
}
async function fixture(
  settings: unknown = { extensions: { enable: ['tailscale'] } },
  scenario: Record<string, unknown> = {},
) {
  const home = await temp()
  await mkdir(join(home, '.ultimate'))
  await writeFile(join(home, '.ultimate/settings.json'), JSON.stringify(settings))
  const config = join(home, 'config.json')
  const log = join(home, 'argv.jsonl')
  await writeFile(config, JSON.stringify({ node, serve: {}, ...scenario }))
  const script = join(home, 'tailscale')
  await writeFile(
    script,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const config = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
if (config.error && (!config.errorOn || args.join(' ') === config.errorOn)) { console.error(config.error); process.exit(1); }
if (args[0] === 'status') console.log(JSON.stringify(config.node));
else if (args.join(' ') === 'serve status --json') console.log(JSON.stringify(config.serve));
else if (args[0] === 'serve') {
  const port = args.find(arg => arg.startsWith('--https=')).split('=')[1];
  const authority = 'rog.example.ts.net:' + port;
  config.serve.Web ??= {}; config.serve.TCP ??= {};
  if (args.includes('off')) { delete config.serve.Web[authority]; delete config.serve.TCP[port]; }
  else { config.serve.Web[authority] = { Handlers: { '/': { Proxy: args.at(-1) } } }; config.serve.TCP[port] = { HTTPS: true }; }
  fs.writeFileSync(${JSON.stringify(config)}, JSON.stringify(config));
}
`,
  )
  await chmod(script, 0o755)
  vi.stubEnv('PATH', home)
  const invocations = async () => {
    try {
      return (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    } catch {
      return []
    }
  }
  const live = new Set<string>()
  async function instance(projectRoot = '/project/a', localPort = 4747) {
    const url = `http://127.0.0.1:${localPort}`
    live.add(url)
    const openers: (() => Promise<void>)[] = []
    const cleanups: (() => Promise<void>)[] = []
    const notices: string[] = []
    const access = createAccess()
    const host = {
      userHome: home,
      projectRoot,
      projects: async () => [...live].map((liveUrl) => ({ running: { url: liveUrl } })),
      access,
      notice: (message: string) => notices.push(message),
      system: () => ({ process: { url: `http://127.0.0.1:${localPort}` } }),
      onOpen: (fn: () => Promise<void>) => openers.push(fn),
      onClose: (fn: () => Promise<void>) => cleanups.push(fn),
    } as unknown as ExtensionHost
    tailscale(host)
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      for (const fn of cleanups) await fn()
      live.delete(url)
    }
    closes.push(close)
    await Promise.all(openers.map((fn) => fn()))
    return {
      host,
      notices,
      access,
      close,
      status: async () =>
        (await actions.status(null, { host } as Parameters<typeof actions.status>[1])) as Status,
    }
  }
  return { home, config, invocations, instance }
}

it('applies user-only settings through the real loader and tears down on live settings reload', async () => {
  const f = await fixture()
  const repo = join(f.home, 'repo')
  await mkdir(join(repo, 'web'), { recursive: true })
  await mkdir(join(repo, '.ultimate'), { recursive: true })
  await cp(resolve('extensions/tailscale'), join(repo, 'extensions/tailscale'), { recursive: true })
  await mkdir(join(repo, 'server'))
  await cp(resolve('server/lock.ts'), join(repo, 'server/lock.ts'))
  await linkDependencies(repo)
  await writeFile(
    join(repo, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true } }",
  )
  await writeFile(join(repo, 'web/index.html'), '<html>Preview</html>')
  await writeFile(
    join(repo, '.ultimate/settings.json'),
    '{"extensions":{"enable":["tailscale"]},"tailscale":{"allow":["project-attacker"]}}',
  )
  const server = await fauxServer({
    ultimateRoot: repo,
    projectRoot: repo,
    userHome: f.home,
    home: join(f.home, 'state'),
    port: 0,
  })
  closes.push(() => server.close())
  const status = async () =>
    (await post(server, '/api/extensions/tailscale/actions/status', { args: null })).data
      .result as Status
  expect(await status()).toMatchObject({ state: 'ready', allow: ['owner@example.com'] })
  expect(server.system.current().access.origins).toHaveLength(1)
  await writeFile(
    join(f.home, '.ultimate/settings.json'),
    '{"extensions":{"enable":["tailscale"]},"tailscale":{"allow":["changed@example.com"]}}',
  )
  await until(async () => (await status()).allow.includes('changed@example.com'))
  expect((await f.invocations()).filter((args) => args.includes('off'))).toHaveLength(1)
  await writeFile(join(f.home, '.ultimate/settings.json'), '{}')
  await until(async () => (await status()).state === 'disabled')
  expect((await f.invocations()).filter((args) => args.includes('off'))).toHaveLength(2)
  await until(() => server.system.current().access.origins.length === 0)
  expect(
    server.system
      .current()
      .extensionDiagnostics.some((message) =>
        message.includes('project settings cannot enable remote access'),
      ),
  ).toBe(true)
})

it('requires user enablement and does not run the CLI for a project-only enable', async () => {
  const f = await fixture({})
  const app = await f.instance()
  expect(await app.status()).toMatchObject({
    state: 'disabled',
    hint: expect.stringContaining('project settings cannot'),
  })
  expect(app.notices).toHaveLength(1)
  expect(await f.invocations()).toEqual([])
})
it('serves, verifies the owner login by default, and tears down only its port', async () => {
  const f = await fixture()
  const app = await f.instance()
  expect(await app.status()).toEqual({
    state: 'ready',
    url: 'https://rog.example.ts.net:4747',
    allow: ['owner@example.com'],
  })
  const rule = [...app.access.rules][0]
  expect(await rule.verify({ headers: { 'tailscale-user-login': 'owner@example.com' } })).toEqual({
    login: 'owner@example.com',
  })
  expect(
    await rule.verify({ headers: { 'tailscale-user-login': 'shared@example.com' } }),
  ).toBeUndefined()
  expect(await rule.verify({ headers: {} })).toBeUndefined()
  expect(await f.invocations()).toContainEqual([
    'serve',
    '--bg',
    '--yes',
    '--https=4747',
    'http://127.0.0.1:4747',
  ])
  await app.close()
  expect(app.access.origins()).toEqual([])
  expect(await f.invocations()).toContainEqual(['serve', '--https=4747', 'off'])
  expect(
    JSON.parse(await readFile(join(f.home, '.ultimate/tailscale.json'), 'utf8')).ports,
  ).toEqual({ '/project/a': { port: 4747, owner: expect.stringMatching(/^\d+:/) } })
})
it('assigns distinct stable ports to two projects even when local ports change', async () => {
  const f = await fixture()
  const first = await f.instance('/project/a', 4747)
  const second = await f.instance('/project/b', 4747)
  expect((await first.status()).url).toBe('https://rog.example.ts.net:4747')
  expect((await second.status()).url).toBe('https://rog.example.ts.net:4748')
  await first.close()
  await second.close()
  const restarted = await f.instance('/project/a', 4750)
  const restartedB = await f.instance('/project/b', 4751)
  expect((await restarted.status()).url).toBe('https://rog.example.ts.net:4747')
  expect((await restartedB.status()).url).toBe('https://rog.example.ts.net:4748')
  expect(await f.invocations()).toContainEqual([
    'serve',
    '--bg',
    '--yes',
    '--https=4747',
    'http://127.0.0.1:4750',
  ])
})
it('replaces a stale own loopback mapping and leaves foreign mappings untouched', async () => {
  const serve = {
    TCP: { '443': { HTTPS: true }, '4747': { HTTPS: true } },
    Web: {
      'rog.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:38886' } } },
      'rog.example.ts.net:4747': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4790' } } },
    },
  }
  const f = await fixture(undefined, { serve })
  await writeFile(
    join(f.home, '.ultimate/tailscale.json'),
    JSON.stringify({ ports: { '/project/a': { port: 4747, owner: `${process.pid}:previous` } } }),
  )
  const app = await f.instance('/project/a', 4750)
  expect((await app.status()).state).toBe('ready')
  await app.close()
  expect((await f.invocations()).filter((args) => args.some((arg) => arg.includes('443')))).toEqual(
    [],
  )
})
it('skips foreign ports for new projects and refuses foreign targets on existing assignments', async () => {
  const serve = {
    TCP: { '4747': { HTTPS: true } },
    Web: {
      'rog.example.ts.net:4747': { Handlers: { '/': { Proxy: 'http://foreign.example:9000' } } },
    },
  }
  const f = await fixture(undefined, { serve })
  const newApp = await f.instance('/project/new')
  expect((await newApp.status()).url).toBe('https://rog.example.ts.net:4748')
  await newApp.close()
  await writeFile(
    join(f.home, '.ultimate/tailscale.json'),
    JSON.stringify({ ports: { '/project/a': { port: 4747, owner: `${process.pid}:previous` } } }),
  )
  const app = await f.instance()
  expect(await app.status()).toMatchObject({
    state: 'port-conflict',
    hint: expect.stringContaining('foreign mapping'),
  })
  await app.close()
  expect((await f.invocations()).filter((args) => args.includes('--https=4747'))).toEqual([])
})
it.each([
  [{ node: { ...node, BackendState: 'NeedsLogin' } }, 'not-running', 'tailscale up'],
  [{ node: { ...node, CertDomains: [] } }, 'https-disabled', 'admin console'],
  [
    {
      error: 'Access denied: not operator',
      errorOn: 'serve --bg --yes --https=4747 http://127.0.0.1:4747',
    },
    'not-operator',
    'sudo tailscale set --operator=$USER',
  ],
  [{ error: 'failed to connect to local tailscaled' }, 'not-running', 'tailscale up'],
  [{ error: 'unexpected CLI failure' }, 'error', 'unexpected CLI failure'],
])('reports actionable failure states (%s)', async (scenario, state, hint) => {
  const f = await fixture(undefined, scenario)
  const app = await f.instance()
  expect(await app.status()).toMatchObject({ state, hint: expect.stringContaining(hint) })
  expect(app.access.origins()).toEqual([])
  await app.close()
  expect((await f.invocations()).filter((args) => args.includes('off'))).toEqual([])
})
it('reports not installed without attempting Serve', async () => {
  const f = await fixture()
  vi.stubEnv('PATH', join(f.home, 'missing'))
  const app = await f.instance()
  expect(await app.status()).toMatchObject({
    state: 'not-installed',
    hint: expect.stringContaining('Install Tailscale'),
  })
  expect(await f.invocations()).toEqual([])
})
it('reads the explicit allowlist only from user settings', async () => {
  const f = await fixture({
    extensions: { enable: ['tailscale'] },
    tailscale: { allow: ['explicit@example.com'] },
  })
  const app = await f.instance()
  expect((await app.status()).allow).toEqual(['explicit@example.com'])
})
it('hands ownership to an overlapping successor and does not remove foreign replacements', async () => {
  const f = await fixture()
  const old = await f.instance('/project/a', 4747)
  const next = await f.instance('/project/a', 4750)
  await old.close()
  expect((await f.invocations()).filter((args) => args.includes('off'))).toHaveLength(0)
  const config = JSON.parse(await readFile(f.config, 'utf8'))
  expect(config.serve.Web['rog.example.ts.net:4747'].Handlers['/'].Proxy).toBe(
    'http://127.0.0.1:4750',
  )
  config.serve.Web['rog.example.ts.net:4747'].Handlers['/'].Proxy = 'http://foreign.example:9000'
  await writeFile(f.config, JSON.stringify(config))
  await next.close()
  expect((await f.invocations()).filter((args) => args.includes('off'))).toHaveLength(0)
})
it('recovers dead registry owners and leaves unowned mappings intact', async () => {
  const f = await fixture(undefined, {
    serve: {
      Web: {
        'rog.example.ts.net:4748': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4998' } } },
        'rog.example.ts.net:4749': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4999' } } },
      },
    },
  })
  await writeFile(
    join(f.home, '.ultimate/tailscale.json'),
    JSON.stringify({ ports: { '/dead': { port: 4748, owner: '2147483647:dead' } } }),
  )
  await writeFile(
    join(f.home, '.ultimate/tailscale.json.lock'),
    JSON.stringify({ pid: 2147483647 }),
  )
  const app = await f.instance()
  expect((await app.status()).state).toBe('ready')
  expect(await f.invocations()).toContainEqual(['serve', '--https=4748', 'off'])
  expect((await f.invocations()).filter((args) => args.includes('--https=4749'))).toEqual([])
})
it('reports failed teardown without throwing and classifies filesystem failures as errors', async () => {
  const f = await fixture()
  const app = await f.instance()
  const config = JSON.parse(await readFile(f.config, 'utf8'))
  config.error = 'off failed'
  config.errorOn = 'serve --https=4747 off'
  await writeFile(f.config, JSON.stringify(config))
  await expect(app.close()).resolves.toBeUndefined()
  expect(await app.status()).toMatchObject({
    state: 'error',
    hint: expect.stringContaining('Could not remove'),
  })
  await writeFile(join(f.home, '.ultimate/tailscale.json'), '{permission denied')
  const invalid = await f.instance('/new', 4751)
  expect((await invalid.status()).state).toBe('error')
})
