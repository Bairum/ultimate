import { request } from 'node:http'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import type { ConversationId, ConversationView } from '@earendil-works/pi-durable'
import { defineExtension, InboxDoc, LiveDoc } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fauxServer as createServer,
  prepareFauxServer as prepareServer,
  until,
  post,
  attach,
  temp,
  removeTemp,
  linkDependencies,
} from './helpers.ts'
import { context } from '../server/harness.ts'
import { UiState } from '../server/ui-state.ts'
import { Metadata } from '../server/metadata.ts'
import type { ConversationSummary, ServerEvents } from '../shared/protocol.ts'
import { Logins } from '../extensions/models/server.ts'

const servers: Awaited<ReturnType<typeof createServer>>[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    await server.vite.watcher.close()
    await server.close()
  }
  for (const directory of directories.splice(0)) await removeTemp(directory)
})
async function fixture(
  extra = false,
  agents = false,
  sources?: Record<string, string>,
  empty = false,
) {
  const directory = await temp()
  directories.push(directory)
  const ultimateRoot = join(directory, 'repo')
  await mkdir(join(ultimateRoot, 'extensions', 'prompt'), { recursive: true })
  await cp(resolvePath('extensions/coding-tools'), join(ultimateRoot, 'extensions/coding-tools'), {
    recursive: true,
  })
  await cp(resolvePath('extensions/faux'), join(ultimateRoot, 'extensions/faux'), {
    recursive: true,
  })
  await mkdir(join(ultimateRoot, 'web'), { recursive: true })
  await linkDependencies(ultimateRoot)
  await writeFile(
    join(ultimateRoot, 'vite.config.ts'),
    "import { defineConfig } from 'vite-plus'; export default defineConfig({ root: 'web', cacheDir: '.vite-cache', optimizeDeps: { noDiscovery: true } })",
  )
  await writeFile(
    join(ultimateRoot, 'web', 'index.html'),
    '<html><body>Ultimate server is running</body></html>',
  )
  await writeFile(
    join(ultimateRoot, 'extensions', 'prompt', 'server.ts'),
    await readFile(resolvePath('extensions/prompt/server.ts'), 'utf8'),
  )
  await cp(resolvePath('server'), join(ultimateRoot, 'server'), { recursive: true })
  await cp(resolvePath('shared'), join(ultimateRoot, 'shared'), { recursive: true })
  if (extra) {
    await mkdir(join(ultimateRoot, 'extensions', 'counter'), { recursive: true })
    await writeFile(
      join(ultimateRoot, 'extensions', 'counter', 'value.ts'),
      "export const value = 'one'",
    )
    await writeFile(join(ultimateRoot, 'extensions', 'counter', 'server.ts'), counterSource)
    await mkdir(join(ultimateRoot, 'extensions', 'web-only'), { recursive: true })
    await writeFile(
      join(ultimateRoot, 'extensions', 'web-only', 'web.tsx'),
      'export default () => null',
    )
    await writeFile(
      join(ultimateRoot, 'extensions', 'web-only', 'README.md'),
      'A browser-only extension.\n\nMore detail.',
    )
  }
  if (agents) {
    await cp(resolvePath('extensions/subagents'), join(ultimateRoot, 'extensions/subagents'), {
      recursive: true,
    })
    // Subagents can import the scheduler while the conversations facet stays uninstalled.
    await mkdir(join(ultimateRoot, 'extensions/conversations'))
    await mkdir(join(ultimateRoot, 'extensions/onboarding'))
    await mkdir(join(ultimateRoot, 'extensions/exclusive-commands'))
    for (const file of [
      'exclusive-commands/slot.ts',
      'conversations/summary.ts',
      'conversations/summary-model.ts',
      'conversations/summary-model-ref.ts',
      'onboarding/settings.ts',
    ])
      await cp(resolvePath('extensions', file), join(ultimateRoot, 'extensions', file))
    // Workspaces imports lineage, which notes landings in the root.
    for (const name of ['workspaces', 'lineage'])
      await cp(resolvePath('extensions', name), join(ultimateRoot, 'extensions', name), {
        recursive: true,
      })
    await cp(resolvePath('agents'), join(ultimateRoot, 'agents'), { recursive: true })
  }
  if (sources) {
    await rm(join(ultimateRoot, 'extensions/coding-tools'), { recursive: true })
    for (const [name, source] of Object.entries(sources)) {
      await mkdir(join(ultimateRoot, 'extensions', name), { recursive: true })
      await writeFile(join(ultimateRoot, 'extensions', name, 'server.ts'), source)
    }
  }
  if (empty) {
    await rm(join(ultimateRoot, 'extensions'), { recursive: true })
    await mkdir(join(ultimateRoot, 'extensions'))
  }
  await mkdir(join(ultimateRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({
      extensions: {
        enable: [
          'counter',
          'web-only',
          'subagents',
          'added',
          '0-new',
          ...Object.keys(sources ?? {}),
        ],
      },
    }),
  )
  const options = {
    ultimateRoot,
    // Explicit, so an inherited ULTIMATE_PROJECT (tests run from inside Ultimate) cannot add its project's extensions.
    projectRoot: ultimateRoot,
    userHome: directory,
    home: join(directory, 'home'),
    faux: true,
    port: 0,
  }
  const server = await createServer(options)
  servers.push(server)
  return { server, options }
}
const counterSource = `import { Type } from '@earendil-works/pi-ai'
import { defineDoc, defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { value } from './value.ts'
export const Counter = defineDoc({ kind: 'test.counter', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ count: 0 }) })
export const docs = [Counter]
export default defineExtension({ name: 'counter', sections: [section('counter', () => value)], tools: [defineTool({ name: 'increment', description: 'Increment', parameters: Type.Object({}), execute: async (_args, api, context) => { await api.commit(async tx => { (await tx.doc(Counter, api.conversationId)).count++ }, context); return {} } })] })`

const orderedSource = (name: string, order = 0) => `
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
export const order = ${order}
export default defineExtension({ name: '${name}', sections: [section('${name === '0-new' ? 'new' : name}', () => '${name}')], tools: [defineTool({ name: '${name === '0-new' ? 'new' : name}', description: '${name}', parameters: Type.Object({}), execute: async () => ({}) })] })`

describe('server', () => {
  it('admits registered identities for API, SSE, actions, assets and HMR, then revokes on disposal and unload', async () => {
    const origin = 'https://rog.example.ts.net:5799'
    const { server, options } = await fixture(false, false, {
      access: `import { defineExtension } from '@earendil-works/pi-durable'
let remove
export default host => {
  remove = host.access.allow({ origin: '${origin}', verify: async ({ headers }) => headers['tailscale-user-login'] === 'owner' ? { login: 'owner' } : undefined })
  return defineExtension({ name: 'access' })
}
export const actions = { ping: async () => 'pong', revoke: async () => { remove(); return true } }`,
    })
    const wire = (
      path: string,
      login: string | null = 'owner',
      extra: Record<string, string> = {},
      method = 'GET',
    ) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          server.url + path,
          {
            method,
            headers: {
              host: new URL(origin).host,
              origin,
              ...(login ? { 'tailscale-user-login': login } : {}),
              ...extra,
            },
          },
          (response) => {
            resolve(response.statusCode!)
            response.destroy()
          },
        )
        req.on('error', reject)
        req.on('upgrade', (_response, socket) => {
          resolve(101)
          socket.destroy()
        })
        req.end(method === 'POST' ? '{"args":null}' : undefined)
      })
    for (const path of ['/', '/api/models', '/api/events', '/api/extensions/access/actions/ping']) {
      const method = path.includes('actions') ? 'POST' : 'GET'
      expect(await wire(path, 'owner', {}, method)).toBe(200)
      expect(await wire(path, 'other', {}, method)).toBe(403)
      expect(await wire(path, null, {}, method)).toBe(403)
    }
    expect(await wire('/api/models', 'owner', { host: 'unknown.example:5799' })).toBe(403)
    expect(await wire('/api/models', 'owner', { origin: 'https://evil.example' })).toBe(403)
    expect((await fetch(server.url + '/api/models')).status).toBe(200)
    expect(
      await wire(
        '/api/extensions/access/actions/ping',
        'owner',
        { origin: '', 'sec-fetch-site': 'cross-site' },
        'POST',
      ),
    ).toBe(403)
    expect(
      await wire(
        '/api/extensions/access/actions/ping',
        'owner',
        { origin: '', 'sec-fetch-site': 'same-origin' },
        'POST',
      ),
    ).toBe(200)
    const upgrade = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-protocol': 'vite-hmr',
    }
    const wsPath = '/?token=' + server.vite.config.webSocketToken
    for (const forwarded of ['x-forwarded-for', 'x-forwarded-host', 'forwarded']) {
      for (const login of [null, 'other', 'owner']) {
        for (const originHeader of ['', server.url]) {
          const headers = { host: new URL(server.url).host, origin: originHeader, [forwarded]: '' }
          for (const path of ['/api/models', '/', '/api/extensions/access/actions/ping'])
            expect(
              await wire(path, login, headers, path.includes('actions') ? 'POST' : 'GET'),
            ).toBe(403)
          expect(await wire(wsPath, login, { ...upgrade, ...headers })).toBe(403)
        }
      }
    }
    for (const site of ['cross-site', 'same-site']) {
      expect(await wire('/@vite/client', 'owner', { 'sec-fetch-site': site })).toBe(403)
      expect(await wire(wsPath, 'owner', { ...upgrade, 'sec-fetch-site': site })).toBe(403)
    }
    expect(await wire('/api/models', 'owner', { 'sec-fetch-site': 'none' })).toBe(200)
    expect(await wire(wsPath, 'owner', upgrade)).toBe(101)
    expect(await wire(wsPath, 'other', upgrade)).toBe(403)
    expect(await wire(wsPath, null, upgrade)).toBe(403)
    expect(await wire(wsPath, 'owner', { ...upgrade, host: 'unknown.example:5799' })).toBe(403)
    expect(
      await wire(wsPath, null, { ...upgrade, host: new URL(server.url).host, origin: server.url }),
    ).toBe(101)
    await until(() => server.system.current().access.origins.includes(origin))
    expect(await wire('/api/extensions/access/actions/revoke', 'owner', {}, 'POST')).toBe(200)
    expect(await wire('/api/models')).toBe(403)
    expect(await wire(wsPath, 'owner', upgrade)).toBe(403)
    // Reload the facet to create a new registration, then disable it.
    await writeFile(
      join(options.ultimateRoot, 'extensions/access/server.ts'),
      (await readFile(join(options.ultimateRoot, 'extensions/access/server.ts'), 'utf8')) + '\n',
    )
    await until(async () => (await wire('/api/models')) === 200)
    await writeFile(
      join(options.ultimateRoot, '.ultimate/settings.json'),
      '{"extensions":{"disable":["access"]}}',
    )
    await until(async () => (await wire('/api/models')) === 403)
    expect(await wire(wsPath, 'owner', upgrade)).toBe(403)
  })
  it('revokes a deferred verifier in flight for HTTP and upgrades', async () => {
    const { server } = await fixture(false, false, {
      deferred: `import { defineExtension } from '@earendil-works/pi-durable'
let host, remove, resolve
export default h => { host=h; return defineExtension({ name: 'deferred' }) }
export const actions = {
arm: async () => { resolve=undefined; remove=host.access.allow({ origin:'https://remote.example:5799', verify: () => new Promise(r => { resolve=r }) }); return true },
waiting: async () => Boolean(resolve),
finish: async () => { remove(); resolve({login:'owner'}); return true }
}`,
    })
    for (const upgrade of [false, true]) {
      await post(server, '/api/extensions/deferred/actions/arm', { args: null })
      const pending = new Promise<number>((resolve, reject) => {
        const req = request(
          server.url + (upgrade ? '/?token=' + server.vite.config.webSocketToken : '/api/models'),
          {
            headers: {
              host: 'remote.example:5799',
              ...(upgrade
                ? {
                    connection: 'Upgrade',
                    upgrade: 'websocket',
                    'sec-websocket-version': '13',
                    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
                    'sec-websocket-protocol': 'vite-hmr',
                  }
                : {}),
            },
          },
          (res) => {
            resolve(res.statusCode!)
            res.destroy()
          },
        )
        req.on('error', reject)
        req.end()
      })
      await until(
        async () =>
          (await post(server, '/api/extensions/deferred/actions/waiting', { args: null })).data
            .result === true,
      )
      await post(server, '/api/extensions/deferred/actions/finish', { args: null })
      expect(await pending).toBe(403)
    }
  })

  it('cleans up facet lifecycles on reload but retains reload-stable resource lifecycles until shutdown', async () => {
    const source = `import { defineExtension } from '@earendil-works/pi-durable'
import { writeFile } from 'node:fs/promises'
export let state
export default host => {
  state = host.resource('lifecycle.state', () => {
    const value = { opens: 0, closes: 0, facetsClosed: 0 }
    host.onOpen(async () => { value.opens++ })
    host.onClose(async () => { value.closes++; await writeFile(host.userHome + '/closed.json', JSON.stringify(value)) })
    return value
  })
  host.onClose(async () => { state.facetsClosed++ })
  return defineExtension({ name: 'lifecycle' })
}
export const actions = { state: async () => state }`
    const { server, options } = await fixture(false, false, { lifecycle: source })
    const path = join(options.ultimateRoot, 'extensions/lifecycle/server.ts')
    const initial = server.extensions.info().find((entry) => entry.name === 'lifecycle')!
      .server!.loadedAt
    await writeFile(path, source + '\n')
    await until(
      () =>
        server.extensions.info().find((entry) => entry.name === 'lifecycle')!.server!.loadedAt !==
        initial,
    )
    expect(
      (await post(server, '/api/extensions/lifecycle/actions/state', { args: null })).data.result,
    ).toEqual({ opens: 1, closes: 0, facetsClosed: 1 })
    servers.splice(servers.indexOf(server), 1)
    await server.close()
    expect(JSON.parse(await readFile(join(options.userHome, 'closed.json'), 'utf8'))).toEqual({
      opens: 1,
      closes: 1,
      facetsClosed: 2,
    })
  })

  it('runs late facet openers immediately and continues after throwing cleanups', async () => {
    const { server } = await fixture(false, false, {
      cleanup: `import { defineExtension } from '@earendil-works/pi-durable'
import { writeFile } from 'node:fs/promises'
let host, opened=false
export default h => { host=h; h.onClose(async()=>{throw new Error('cleanup test failure')}); h.onClose(async()=>{await writeFile(h.userHome+'/cleanup-ok','yes')}); return defineExtension({name:'cleanup'}) }
export const actions={ late: async()=>{host.onOpen(async()=>{opened=true}); return true}, opened:async()=>opened }`,
    })
    const stream = await attach(server)
    await post(server, '/api/extensions/cleanup/actions/late', { args: null })
    await until(
      async () =>
        (await post(server, '/api/extensions/cleanup/actions/opened', { args: null })).data
          .result === true,
    )
    await server.extensions.close()
    expect(await readFile(join(server.host.userHome, 'cleanup-ok'), 'utf8')).toBe('yes')
    await until(() =>
      stream.events.some(
        (e) => e.name === 'notice' && JSON.stringify(e.data).includes('cleanup test failure'),
      ),
    )
    await stream.close()
  })

  it('settles failing process resource cleanups and still closes the server', async () => {
    const { server } = await fixture(false, false, {
      resourcecleanup: `import { defineExtension } from '@earendil-works/pi-durable'
import { writeFile } from 'node:fs/promises'
export default host => { host.resource('cleanup.process',()=>{
  host.onClose(()=>{throw new Error('sync process failure')})
  host.onClose(async()=>{throw new Error('async process failure')})
  host.onClose(async()=>{await writeFile(host.userHome+'/process-cleanup-ok','yes')})
  return {}
}); return defineExtension({name:'resourcecleanup'}) }`,
    })
    await expect(server.close()).resolves.toBeUndefined()
    servers.splice(servers.indexOf(server), 1)
    expect(server.http.listening).toBe(false)
    expect(await readFile(join(server.host.userHome, 'process-cleanup-ok'), 'utf8')).toBe('yes')
  })

  it('serves and completes a faux submit with an empty extensions directory', async () => {
    const { server } = await fixture(false, false, undefined, true)
    expect((await fetch(server.url)).status).toBe(200)
    expect(server.extensions.info()).toEqual([])
    server.host.faux!.setResponses([fauxAssistantMessage('Core-only response')])
    const submitted = await server.root.submit({ type: 'input', content: 'hello' }, context)
    await submitted.wait(context)
    await server.harness.waitForIdle(context)
    const view = await server.root.viewState(context)
    try {
      const messages = view.value.entries.flatMap((entry) => entry.model ?? [])
      expect(
        messages.some((message) => message.role === 'assistant' && message.stopReason === 'stop'),
      ).toBe(true)
      expect(messages.some((message) => message.role === 'toolResult')).toBe(false)
    } finally {
      view.dispose()
    }
    await expect(readFile(join(server.host.home, 'demo.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it('scans committed submissions newest first, filtered and paged', async () => {
    const { server } = await fixture(false, false, undefined, true)
    server.host.faux!.setResponses([fauxAssistantMessage('One'), fauxAssistantMessage('Two')])
    const ids = []
    for (const content of ['one', 'two']) {
      const submitted = await server.root.submit({ type: 'input', content }, context)
      await submitted.wait(context)
      ids.push(submitted.id)
    }
    const query = { conversationId: server.root.id, status: 'done', order: 'descending' } as const
    const first = await server.host.scanSubmissions(query, 1, undefined, context)
    expect(first.items.map((item) => item.id)).toEqual([ids[1]])
    const second = await server.host.scanSubmissions(query, 1, first.next, context)
    expect(second.items.map((item) => item.id)).toEqual([ids[0]])
    expect(second.next).toBeUndefined()
    expect(
      (await server.host.scanSubmissions({ ...query, status: 'queued' }, 10, undefined, context))
        .items,
    ).toEqual([])
    servers.splice(servers.indexOf(server), 1)
    await server.vite.watcher.close()
    await server.close()
    expect(() => server.host.scanSubmissions(query, 1, undefined, context)).toThrow(
      'Harness is not open',
    )
  })
  it('does not inherit the supervisor public URL in an embedded server', async () => {
    vi.stubEnv('ULTIMATE_PUBLIC_URL', 'http://127.0.0.1:1')
    try {
      const { server } = await fixture()
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
      expect((await fetch(server.url)).status).toBe(200)
      expect((await post(server, '/api/ui', { set: { 'test.isolated': true } })).status).toBe(200)
      expect(await server.host.uiState(context)).toEqual({ 'test.isolated': true })
      await (
        await server.root.submit({ type: 'input', content: 'self URL' }, context)
      ).wait(context)
      const view = await server.root.viewState(context)
      try {
        const system = view.value.entries.find((entry) => entry.kind === 'pi.system')?.model?.[0]
        expect(system?.role === 'system' ? system.sections?.environment : undefined).toContain(
          `UI: ${server.url}`,
        )
      } finally {
        view.dispose()
      }
      await server.root.abort(context)
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('withdraws one queued input without aborting the current run or another conversation', async () => {
    const { server } = await fixture()
    await post(server, '/api/conversations/1/submit', { text: 'start' })
    const run = (await server.harness.snapshot(LiveDoc, server.root.id, context))?.run?.taskId
    expect(run).toBeDefined()
    const queued = await post(server, '/api/conversations/1/submit', {
      text: 'queued input',
      whenBusy: 'followUp',
    })
    const submissionId = queued.data.submissionId
    if (typeof submissionId !== 'number') throw new Error('Expected submission id')
    const path = `/api/conversations/1/inbox/${submissionId}/cancel`
    expect((await post(server, `/api/conversations/999/inbox/${submissionId}/cancel`)).status).toBe(
      404,
    )
    expect((await post(server, path)).status).toBe(200)
    expect((await post(server, path)).status).toBe(200)
    expect((await server.harness.snapshot(InboxDoc, server.root.id, context))?.items).toEqual([])
    expect((await server.harness.snapshot(LiveDoc, server.root.id, context))?.run?.taskId).toBe(run)
    await server.root.abort(context)
    const completed = await server.root.submit({ type: 'input', content: 'complete' }, context)
    await completed.wait(context)
    expect((await post(server, `/api/conversations/1/inbox/${completed.id}/cancel`)).status).toBe(
      409,
    )
  })
  it('orders live-added sections and tools deterministically across reopen', async () => {
    const { server, options } = await fixture(false, false, {
      a: orderedSource('a'),
      prompt: orderedSource('prompt', -100),
    })
    // This demo finishes without requiring the fixture to expose coding tools.
    await post(server, '/api/conversations/1/submit', { text: 'Return the word SCOUT.' })
    await server.harness.waitForIdle(context)
    const folder = join(options.ultimateRoot, 'extensions/0-new')
    await mkdir(folder)
    await writeFile(join(folder, 'server.ts'), orderedSource('0-new'))
    await until(() => !!server.extensions.info().find((item) => item.name === '0-new')?.server)
    expect(
      server.extensions.info().find((item) => item.name === '0-new')?.server?.error,
    ).toBeUndefined()
    await post(server, '/api/conversations/1/submit', { text: 'Return the word SCOUT.' })
    await server.harness.waitForIdle(context)
    const view = await server.root.viewState(context)
    const systems = view.value.entries.filter((entry) => entry.kind === 'pi.system')
    const message = systems.at(-1)!.model![0]
    expect(message.role).toBe('system')
    if (message.role !== 'system') throw new Error('Expected system message')
    expect(Object.keys(message.sections!)).toEqual(['prompt', 'new', 'a'])
    expect(message.toolsAdded!.map((tool) => tool.name)).toEqual(['prompt', 'new', 'a'])
    const lastId = systems.at(-1)!.id
    view.dispose()
    await server.vite.watcher.close()
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const reopened = await createServer(options)
    servers.push(reopened)
    await post(reopened, '/api/conversations/1/submit', { text: 'Return the word SCOUT.' })
    await reopened.harness.waitForIdle(context)
    const next = await reopened.root.viewState(context)
    expect(
      next.value.entries.filter((entry) => entry.kind === 'pi.system' && entry.id > lastId),
    ).toEqual([])
    next.dispose()
  })

  it('shares root UI snapshots and set/delete deltas across conversations and reopen', async () => {
    const { server, options } = await fixture()
    const created = await post(server, '/api/conversations')
    const first = await attach(server)
    const second = await attach(server, `?conversation=${created.data.id as number}`)
    expect(
      await post(server, '/api/ui', { set: { 'shell.panel': 'tasks', 'app.count': 2 } }),
    ).toEqual({ status: 200, data: { ok: true } })
    await until(() => second.events.some((event) => event.name === 'uiOps'))
    let value = (second.events.find((event) => event.name === 'ui')!.data as ServerEvents['ui'])
      .value
    for (const event of second.events.filter((item) => item.name === 'uiOps'))
      value = applyImmutable(value, (event.data as ServerEvents['uiOps']).ops)
    expect(value).toEqual({ 'shell.panel': 'tasks', 'app.count': 2 })
    const count = second.events.filter((event) => event.name === 'uiOps').length
    await post(server, '/api/ui', { delete: ['app.count'] })
    await until(() => second.events.filter((event) => event.name === 'uiOps').length > count)
    const deletion = second.events.filter((event) => event.name === 'uiOps').at(-1)!
    expect(applyImmutable(value, (deletion.data as ServerEvents['uiOps']).ops)).toEqual({
      'shell.panel': 'tasks',
    })
    await until(() => first.events.filter((event) => event.name === 'uiOps').length === 2)
    expect(await server.host.uiState(context)).toEqual({ 'shell.panel': 'tasks' })
    const entry = await server.root.commit(
      async (tx) => tx.appendEntry(server.root.id, { kind: 'test.marker' }),
      context,
    )
    await post(server, '/api/ui', { set: { 'shell.panel': 'settings' } })
    const fork = await server.root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
    expect(await server.harness.snapshot(UiState, fork.id, context)).toEqual({
      'shell.panel': 'tasks',
    })
    expect(await server.host.uiState(context)).toEqual({ 'shell.panel': 'settings' })
    await post(server, '/api/ui', { set: { 'shell.panel': 'tasks' } })
    await first.close()
    await second.close()
    await server.vite.watcher.close()
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const reopened = await createServer(options)
    servers.push(reopened)
    const stream = await attach(reopened)
    expect(stream.events.find((event) => event.name === 'ui')!.data).toEqual({
      value: { 'shell.panel': 'tasks' },
    })
    await stream.close()
  })

  it('validates UI keys and the merged document size atomically', async () => {
    const { server } = await fixture()
    for (const key of ['', 'bad key', 'x'.repeat(201)])
      expect((await post(server, '/api/ui', { set: { [key]: true } })).status).toBe(400)
    expect((await post(server, '/api/ui', { delete: [4] })).status).toBe(400)
    expect((await post(server, '/api/ui', { set: [] })).status).toBe(400)
    await post(server, '/api/ui', { set: { large: 'x'.repeat(200000) } })
    expect((await post(server, '/api/ui', { set: { extra: 'é'.repeat(40000) } })).status).toBe(413)
    expect(await server.host.uiState(context)).toEqual({ large: 'x'.repeat(200000) })
    await post(server, '/api/ui', {
      set: JSON.parse('{"__proto__":{"safe":true}}'),
      delete: ['large'],
    })
    expect(await server.host.uiState(context)).toEqual(JSON.parse('{"__proto__":{"safe":true}}'))
  })

  it('runs the faux subagent demo and streams its labelled tree and child transcript', async () => {
    const { server } = await fixture(false, true)
    const stream = await attach(server)
    await post(server, '/api/conversations/1/submit', { text: 'delegate to scout' })
    await server.root.waitForIdle(context)
    let child: ServerEvents['conversations'][number] | undefined
    await until(() => {
      for (const event of stream.events) {
        if (event.name === 'conversations')
          child =
            (event.data as ServerEvents['conversations']).find((item) => item.label === 'scout') ??
            child
      }
      return child?.title === 'Return the word SCOUT.' && !child.busy && !!child.answerAt
    })
    const childStream = await attach(server, `?conversation=${child!.id}`)
    const view = childStream.events.find((event) => event.name === 'view')!.data as ConversationView
    expect(
      view.entries.some(
        (entry) =>
          entry.model?.[0]?.role === 'assistant' &&
          entry.model[0].content.some((part) => part.type === 'text' && part.text === 'SCOUT'),
      ),
    ).toBe(true)
    expect(
      (
        await post(server, `/api/conversations/${child!.id}/submit`, {
          text: 'Return the word SCOUT.',
          whenBusy: 'steer',
        })
      ).status,
    ).toBe(202)
    expect((await post(server, `/api/conversations/${child!.id}/abort`)).status).toBe(200)
    await childStream.close()
    await stream.close()
  })
  it('prepares the core and listener without opening SQLite until go', async () => {
    const { options } = await fixture()
    const prepared = await prepareServer({ ...options, home: join(options.home, 'candidate') })
    try {
      expect((await fetch(prepared.url)).status).toBe(503)
      await expect(readFile(prepared.host.database)).rejects.toMatchObject({ code: 'ENOENT' })
      const opened = await prepared.go()
      expect(opened.root.id).toBe(1)
      expect((await readFile(prepared.host.database)).length).toBeGreaterThan(0)
    } finally {
      await prepared.close()
    }
  })
  it('streams a SQLite tool turn as ops that exactly replicate the committed view', async () => {
    const { server } = await fixture()
    const stream = await attach(server)
    expect(stream.events.slice(0, 3).map((event) => event.name)).toEqual([
      'system',
      'conversations',
      'view',
    ])
    expect(await (await fetch(server.url)).text()).toContain('Ultimate server is running')
    const result = await post(server, '/api/conversations/1/submit', { text: 'demo' })
    expect(result.status).toBe(202)
    await server.harness.waitForIdle(context)
    const state = await server.root.viewState(context)
    let replica!: ConversationView
    await until(() => {
      replica = stream.events.find((event) => event.name === 'view')!.data as ConversationView
      for (const event of stream.events)
        if (event.name === 'ops') replica = applyImmutable(replica, event.data as Op[])
      return JSON.stringify(replica) === JSON.stringify(state.value)
    })
    expect(replica).toEqual(state.value)
    state.dispose()
    expect(replica.entries.filter((entry) => entry.kind === 'pi.tool-result')).toHaveLength(2)
    expect(await readFile(join(server.host.home, 'demo.txt'), 'utf8')).toBe('after\n')
    await stream.close()
  })
  it('persists image-only and mixed inputs and validates image requests', async () => {
    const { server, options } = await fixture()
    const image = { data: 'aGVsbG8=', mimeType: 'image/png' }
    server.host.faux!.setResponses([fauxAssistantMessage('Seen.')])
    expect(
      (await post(server, '/api/conversations/1/submit', { text: '', images: [image] })).status,
    ).toBe(202)
    await server.harness.waitForIdle(context)
    const entries = (await server.root.entries({}, 100, undefined, context)).items
    expect(entries.find((entry) => entry.kind === 'pi.user')?.model?.[0]).toMatchObject({
      content: [{ type: 'image', ...image }],
    })
    for (const images of [
      null,
      {},
      [{ ...image, mimeType: 'image/svg+xml' }],
      [{ ...image, data: 'not base64' }],
    ]) {
      expect((await post(server, '/api/conversations/1/submit', { text: '', images })).status).toBe(
        400,
      )
    }
    expect(
      (
        await post(server, '/api/conversations/1/submit', {
          text: '',
          images: Array.from({ length: 5 }, () => ({ ...image })),
        })
      ).status,
    ).toBe(413)
    expect(
      (
        await post(server, '/api/conversations/1/submit', {
          text: '',
          images: [{ ...image, data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }],
        })
      ).status,
    ).toBe(413)
    expect(
      (await post(server, '/api/conversations/1/submit', { text: '', images: [] })).status,
    ).toBe(400)
    server.host.faux!.setResponses([fauxAssistantMessage('Seen again.')])
    expect(
      (await post(server, '/api/conversations/1/submit', { text: 'Look', images: [image] })).status,
    ).toBe(202)
    await server.harness.waitForIdle(context)
    expect(
      (await server.root.entries({}, 100, undefined, context)).items
        .filter((entry) => entry.kind === 'pi.user')
        .at(0)?.model?.[0],
    ).toMatchObject({
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image', ...image },
      ],
    })
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const reopened = await createServer(options)
    servers.push(reopened)
    expect(
      (await reopened.root.entries({}, 100, undefined, context)).items.filter(
        (entry) => entry.kind === 'pi.user',
      ),
    ).toHaveLength(2)
    expect(
      (await reopened.root.entries({}, 100, undefined, context)).items.find(
        (entry) => entry.kind === 'pi.user',
      )?.model?.[0],
    ).toMatchObject({
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image', ...image },
      ],
    })
  })
  it('queues images as steer and follow-up content while busy', async () => {
    const { server } = await fixture()
    const image = { data: 'aGVsbG8=', mimeType: 'image/png' }
    await post(server, '/api/conversations/1/submit', { text: 'start' })
    expect((await server.harness.snapshot(LiveDoc, server.root.id, context))?.run).toBeDefined()
    for (const whenBusy of ['steer', 'followUp']) {
      expect(
        (
          await post(server, '/api/conversations/1/submit', {
            text: 'Look',
            images: [image],
            whenBusy,
          })
        ).status,
      ).toBe(202)
      const items = (await server.harness.snapshot(InboxDoc, server.root.id, context))?.items ?? []
      expect(items).toContainEqual(
        expect.objectContaining({
          mode: whenBusy,
          content: [
            { type: 'text', text: 'Look' },
            { type: 'image', ...image },
          ],
        }),
      )
    }
    await server.root.abort(context)
  })
  it('accepts configure, submit, steering, follow-up and abort; validates errors and creates conversations', async () => {
    const { server } = await fixture()
    // Pi's levels for this model: off, low, high.
    Object.assign(server.host.faux!.models[0], {
      reasoning: true,
      thinkingLevelMap: { minimal: null, medium: null },
    })
    const configure = async (data: Record<string, unknown>) => {
      const { status } = await post(server, '/api/conversations/1/configure', data)
      return { status, thinkingLevel: (await server.root.agent(context)).thinkingLevel }
    }
    expect(
      await configure({ model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'high' }),
    ).toEqual({ status: 200, thinkingLevel: 'high' })
    for (const thinkingLevel of ['medium', 'max', 'bogus', 7])
      expect(await configure({ thinkingLevel })).toEqual({ status: 400, thinkingLevel: 'high' })
    // A new model keeps a supported level and clamps another as Pi does: medium becomes high, not low.
    await server.root.configure({ thinkingLevel: 'medium' }, context)
    expect(await configure({ model: { provider: 'faux', modelId: 'faux-1' } })).toEqual({
      status: 200,
      thinkingLevel: 'high',
    })
    expect(await configure({ thinkingLevel: 'low' })).toEqual({ status: 200, thinkingLevel: 'low' })
    expect((await post(server, '/api/conversations/1/submit', { text: 'start' })).status).toBe(202)
    expect(
      (await post(server, '/api/conversations/1/submit', { text: 'steer', whenBusy: 'steer' }))
        .status,
    ).toBe(202)
    expect(
      (
        await post(server, '/api/conversations/1/submit', {
          text: 'follow up',
          whenBusy: 'followUp',
        })
      ).status,
    ).toBe(202)
    expect((await post(server, '/api/conversations/1/abort')).status).toBe(200)
    await server.harness.waitForIdle(context)
    expect((await post(server, '/api/conversations/1/submit', { text: 7 })).status).toBe(400)
    expect((await post(server, '/api/conversations/999/abort')).status).toBe(404)
    const created = await post(server, '/api/conversations', {
      title: 'Another',
      cwd: server.host.projectRoot,
    })
    expect(created.status).toBe(201)
    const stream = await attach(server, '?conversation=' + created.data.id)
    const summaries = stream.events.find((event) => event.name === 'conversations')!.data
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.data.id, title: 'Another', busy: false }),
      ]),
    )
    await stream.close()
  })
  it('streams input and answer times, keeps them across a reset, and gives summaries to server facets', async () => {
    const { server } = await fixture(false, false, {
      summaries: `import { defineExtension } from '@earendil-works/pi-durable'
export default defineExtension({ name: 'summaries' })
export const actions = { list: async (_args, ctx) => ctx.host.conversations() }`,
    })
    const created = Number((await post(server, '/api/conversations')).data.id)
    const summary = () => server.api.conversations().find((item) => item.id === created)
    expect(summary()).toBeDefined()
    expect(summary()).not.toHaveProperty('inputAt')
    expect(summary()).not.toHaveProperty('answerAt')
    const stream = await attach(server)
    await post(server, `/api/conversations/${created}/submit`, { text: 'Return the word SCOUT.' })
    await server.harness.waitForIdle(context)
    let streamed: ConversationSummary | undefined
    await until(() => {
      streamed = stream.events
        .filter((event) => event.name === 'conversations')
        .map((event) =>
          (event.data as ServerEvents['conversations']).find((item) => item.id === created),
        )
        .at(-1)
      return streamed?.inputAt !== undefined && streamed.answerAt !== undefined
    })
    expect(streamed!.inputAt).toEqual(expect.any(Number))
    expect(streamed!.answerAt).toBeGreaterThanOrEqual(streamed!.inputAt!)
    expect(
      (await post(server, '/api/extensions/summaries/actions/list', { args: null })).data.result,
    ).toEqual(server.api.conversations())
    const conversation = (await server.harness.conversation(created as ConversationId, context))!
    await conversation.commit(async (tx) => {
      ;(await tx.doc(Metadata, created as ConversationId)).label = 'before reset'
    }, context)
    await until(() => summary()?.label === 'before reset')
    expect(summary()).toMatchObject({ inputAt: streamed!.inputAt, answerAt: streamed!.answerAt })
    // A reset empties the active view; the times come from the history before it.
    await conversation.reset(undefined, context)
    await server.harness.waitForIdle(context)
    const view = await conversation.viewState(context)
    expect(view.value.entries.some((entry) => entry.kind === 'pi.user')).toBe(false)
    view.dispose()
    await conversation.commit(async (tx) => {
      ;(await tx.doc(Metadata, created as ConversationId)).label = 'after reset'
    }, context)
    await until(() => summary()?.label === 'after reset')
    expect(summary()).toMatchObject({ inputAt: streamed!.inputAt, answerAt: streamed!.answerAt })
    await stream.close()
  })
  it('derives a title from the active context without storing it and keeps explicit API titles', async () => {
    const { server } = await fixture()
    server.host.faux!.setResponses(
      ['One', 'Two', 'Three'].map((text) => fauxAssistantMessage(text)),
    )
    const created = Number((await post(server, '/api/conversations')).data.id) as ConversationId
    const named = Number((await post(server, '/api/conversations', { title: 'Named' })).data.id)
    const summary = (id: number) => server.api.conversations().find((item) => item.id === id)
    await post(server, `/api/conversations/${created}/submit`, { text: '  First\n\n message ' })
    await server.harness.waitForIdle(context)
    await until(() => summary(created)?.inputAt !== undefined)
    expect(summary(created)?.title).toBe(' First message ')
    expect((await server.harness.snapshot(Metadata, created, context))?.title).toBeUndefined()
    const conversation = (await server.harness.conversation(created, context))!
    await conversation.reset(undefined, context)
    await server.harness.waitForIdle(context)
    await post(server, `/api/conversations/${created}/submit`, { text: 'Second message' })
    await server.harness.waitForIdle(context)
    await conversation.commit(async (tx) => {
      ;(await tx.doc(Metadata, created)).label = 'refreshed'
    }, context)
    await until(() => summary(created)?.label === 'refreshed')
    expect(summary(created)?.title).toBe('Second message')
    expect((await server.harness.snapshot(Metadata, created, context))?.title).toBeUndefined()
    // A title given at creation is not replaced by the first message.
    await post(server, `/api/conversations/${named}/submit`, { text: 'Not the title' })
    await server.harness.waitForIdle(context)
    await until(() => summary(named)?.inputAt !== undefined)
    expect(summary(named)?.title).toBe('Named')
    expect(await server.harness.snapshot(Metadata, named as ConversationId, context)).toEqual({
      title: 'Named',
    })
  })
  it('tracks extension and web builds and stores positional prompt changes', async () => {
    const { server, options } = await fixture(true)
    const first = server.host.build()
    const prepared = await prepareServer({ ...options, home: join(options.home, 'second') })
    expect(prepared.host.build().id).toBe(first.id)
    await prepared.close()
    const stream = await attach(server)
    await post(server, '/api/conversations/1/submit', { text: 'before' })
    await server.harness.waitForIdle(context)
    await writeFile(
      join(options.ultimateRoot, 'extensions/counter/value.ts'),
      "export const value = 'new'",
    )
    await until(() => server.host.build().id !== first.id)
    const second = server.host.build()
    expect(second.extensions.counter).not.toBe(first.extensions.counter)
    expect(second.changed).toEqual(['extensions/counter'])
    await until(() =>
      stream.events.some(
        (event) =>
          event.name === 'system' && (event.data as ServerEvents['system']).build.id === second.id,
      ),
    )
    await post(server, '/api/conversations/1/submit', { text: 'after' })
    await server.harness.waitForIdle(context)
    const view = await server.root.viewState(context)
    const systems = view.value.entries.filter((entry) => entry.kind === 'pi.system')
    expect(systems.length).toBeGreaterThan(1)
    expect(JSON.stringify(systems.at(-1))).toContain(`Ultimate build ${second.id}`)
    view.dispose()
    await writeFile(
      join(options.ultimateRoot, 'extensions/web-only/web.tsx'),
      'export default () => "changed"',
    )
    await until(() => server.host.build().id !== second.id)
    expect(server.host.build().changed).toEqual(['extensions/web-only'])
    await stream.close()
  })
  it('rejects foreign Hosts on API and Vite and accepts localhost Origin', async () => {
    const { server } = await fixture()
    for (const path of ['/api/events', '/']) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          server.url + path,
          { headers: { Host: `evil.example:${server.port}` } },
          (response) => {
            response.resume()
            resolve(response.statusCode)
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(403)
    }
    expect(
      (
        await fetch(server.url + '/api/conversations/1/configure', {
          method: 'POST',
          headers: {
            Origin: `http://localhost:${server.port}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(200)
  })
  it('hot reloads a transitive local import and retains the old extension on a syntax error', async () => {
    const { server } = await fixture(true)
    const entry = () => server.extensions.info().find((extension) => extension.name === 'counter')!
    const loaded = entry().server!.loadedAt
    const promptLoaded = server.extensions.info().find((extension) => extension.name === 'prompt')!
      .server!.loadedAt
    await writeFile(
      join(server.host.ultimateRoot, 'extensions/counter/value.ts'),
      "export const value = 'two'",
    )
    await until(() => entry().server!.loadedAt !== loaded)
    const installed = server.host.registry.snapshot().extension('counter')!
    const section = installed.sections![0]
    expect(await section.render({} as Parameters<typeof section.render>[0], context)).toBe('two')
    expect(
      server.extensions.info().find((extension) => extension.name === 'prompt')!.server!.loadedAt,
    ).toBe(promptLoaded)
    const successful = entry().server!.loadedAt
    await until(async () => {
      await writeFile(
        join(server.host.ultimateRoot, 'extensions/counter/value.ts'),
        'this is not valid TS !!!',
      )
      return !!entry().server!.error
    })
    expect(entry().server!.loadedAt).toBe(successful)
    expect(server.host.registry.snapshot().extension('counter')).toBe(installed)
  })
  it('reloads only the owning extension when files or directories are added or removed', async () => {
    const { server } = await fixture(false, false, {
      a: orderedSource('a'),
      b: orderedSource('b'),
    })
    const loadedAt = (name: string) =>
      server.extensions.info().find((extension) => extension.name === name)!.server!.loadedAt
    const bLoaded = loadedAt('b')
    const folder = join(server.host.ultimateRoot, 'extensions/a')
    const file = join(folder, 'new.ts')
    const nested = join(folder, 'nested')
    for (const change of [
      () => writeFile(file, 'export const value = 1'),
      () => rm(file),
      () => mkdir(nested),
      () => rm(nested, { recursive: true }),
    ]) {
      const aLoaded = loadedAt('a')
      await change()
      await until(() => loadedAt('a') !== aLoaded)
      expect(loadedAt('b')).toBe(bLoaded)
    }
  })
  it('keeps hot reloading extensions after a Vite config change restarts Vite', async () => {
    const { server } = await fixture(true)
    const entry = () => server.extensions.info().find((extension) => extension.name === 'counter')!
    const config = join(server.host.ultimateRoot, 'vite.config.ts')
    const watcher = server.vite.watcher
    await writeFile(config, `${await readFile(config, 'utf8')}\n`)
    await until(() => server.vite.watcher !== watcher)
    // Replacing the watcher does not wait for its initial extension-directory scan.
    await until(() => {
      const watched = server.vite.watcher.getWatched()
      return watched[join(server.host.ultimateRoot, 'extensions/counter')]?.includes('value.ts')
    })
    const loaded = entry().server!.loadedAt
    await writeFile(
      join(server.host.ultimateRoot, 'extensions/counter/value.ts'),
      "export const value = 'after restart'",
    )
    await until(() => entry().server!.loadedAt !== loaded)
    const section = server.host.registry.snapshot().extension('counter')!.sections![0]
    expect(await section.render({} as Parameters<typeof section.render>[0], context)).toBe(
      'after restart',
    )
  })
  it('does not uninstall an extension installed outside the folder loader', async () => {
    const { server } = await fixture(true)
    const external = defineExtension({ name: 'web-only' })
    server.host.registry.install(external)
    await writeFile(
      join(server.host.ultimateRoot, 'extensions/web-only/README.md'),
      'Changed browser facet',
    )
    await until(
      () =>
        server.extensions.info().find((extension) => extension.name === 'web-only')?.readme ===
        'Changed browser facet',
    )
    expect(server.host.registry.snapshot().extension('web-only')).toBe(external)
    await rm(join(server.host.ultimateRoot, 'extensions/web-only'), {
      recursive: true,
      force: true,
      maxRetries: 5,
    })
    await until(() => !server.extensions.info().some((extension) => extension.name === 'web-only'))
    expect(server.host.registry.snapshot().extension('web-only')).toBe(external)
    const folder = join(server.host.ultimateRoot, 'extensions', 'added')
    await mkdir(folder)
    await writeFile(
      join(folder, 'server.ts'),
      "import { defineExtension } from '@earendil-works/pi-durable'; export default defineExtension({ name: 'added' })",
    )
    await until(
      () =>
        !!server.extensions.info().find((extension) => extension.name === 'added')?.server
          ?.loadedAt,
    )
    expect(server.host.registry.snapshot().extension('added')).toBeDefined()
    await rm(folder, { recursive: true })
    await until(() => !server.extensions.info().some((extension) => extension.name === 'added'))
    expect(server.host.registry.snapshot().extension('added')).toBeUndefined()
  })
  it('streams extension document snapshots and deltas, with a notice for unknown kinds', async () => {
    const { server } = await fixture(true)
    const stream = await attach(server, '?docs=test.counter,missing')
    await until(() => stream.events.some((event) => event.name === 'doc'))
    expect(stream.events.find((event) => event.name === 'doc')!.data).toEqual({
      kind: 'test.counter',
      value: { count: 0 },
    })
    expect(stream.events.find((event) => event.name === 'notice')!.data).toEqual(
      expect.objectContaining({ message: 'Unknown extension document: missing' }),
    )
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('increment', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Incremented'),
    ])
    await post(server, '/api/conversations/1/submit', { text: 'increment' })
    await server.harness.waitForIdle(context)
    await until(() => stream.events.some((event) => event.name === 'docOps'))
    let value = { count: 0 }
    for (const event of stream.events)
      if (event.name === 'docOps') value = applyImmutable(value, (event.data as { ops: Op[] }).ops)
    expect(value).toEqual({ count: 1 })
    await stream.close()
  })
  it('runs logins in the models extension: prompt, answer, cancel, no credential leak, dead flows cancelled', async () => {
    const { server, options } = await fixture(false, false, {
      models: await readFile(resolvePath('extensions/models/server.ts'), 'utf8'),
    })
    vi.spyOn(server.host.modelRuntime, 'getProvider').mockReturnValue({
      id: 'stub',
      auth: {
        apiKey: { name: 'Stub', login: async () => ({ key: '' }), resolve: async () => undefined },
      },
    } as unknown as ReturnType<typeof server.host.modelRuntime.getProvider>)
    let answered = ''
    vi.spyOn(server.host.modelRuntime, 'login').mockImplementation(
      async (_provider, _type, interaction) => {
        interaction.notify({ type: 'info', message: 'Stub login' })
        answered = await interaction.prompt({ type: 'secret', message: 'Enter key' })
        return { type: 'api_key', key: answered }
      },
    )
    const stream = await attach(server, '?docs=models.login')
    const action = (name: string, args: unknown, conversationId = 1) =>
      post(server, `/api/extensions/models/actions/${name}`, { args, conversationId })
    const flows = async (id = 1) =>
      (await server.harness.snapshot(Logins, id as ConversationId, context))?.flows ?? {}
    const login = async (conversationId = 1) => {
      const response = await action('login', { provider: 'stub', type: 'api_key' }, conversationId)
      expect(response.status).toBe(200)
      const flowId = String(response.data.result.flowId)
      await until(async () => (await flows(conversationId))[flowId]?.prompt?.type === 'secret')
      return flowId
    }
    const first = await login()
    expect((await action('answer', { flowId: first, value: 'not-a-real-credential' })).status).toBe(
      200,
    )
    await until(async () => (await flows())[first].status === 'complete')
    expect(answered).toBe('not-a-real-credential')
    expect((await flows())[first]).toEqual({
      provider: 'stub',
      type: 'api_key',
      status: 'complete',
      events: [{ type: 'info', message: 'Stub login' }],
    })
    const blank = await login()
    expect((await action('answer', { flowId: blank, value: '' })).status).toBe(200)
    await until(async () => (await flows())[blank].status === 'complete')
    expect(answered).toBe('')
    // A flow lives in the document of the conversation that started it.
    const other = Number((await post(server, '/api/conversations', {})).data.id)
    const second = await login(other)
    expect((await action('cancel', { flowId: second })).status).toBe(200)
    await until(async () => (await flows(other))[second].status === 'cancel')
    expect((await flows(other))[second].prompt).toBeUndefined()
    expect((await action('answer', { flowId: second, value: 'late' })).data).toEqual({
      error: 'Unknown login flow',
    })
    expect(
      stream.events.some(
        (event) =>
          event.name === 'docOps' && (event.data as ServerEvents['docOps']).kind === 'models.login',
      ),
    ).toBe(true)
    expect(JSON.stringify(stream.events)).not.toContain('not-a-real-credential')
    expect(JSON.stringify(await flows())).not.toContain('not-a-real-credential')
    await stream.close()
    // A flow that dies with its process reads cancelled on the next start.
    await server.harness.commit(async (tx) => {
      ;(await tx.doc(Logins, 1 as ConversationId)).flows.dead = {
        provider: 'stub',
        type: 'api_key',
        status: 'running',
        prompt: { type: 'secret', message: 'Enter key' },
        events: [],
      }
    }, context)
    await server.vite.watcher.close()
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const reopened = await createServer(options)
    servers.push(reopened)
    expect(
      (await reopened.harness.snapshot(Logins, 1 as ConversationId, context))?.flows.dead,
    ).toEqual({ provider: 'stub', type: 'api_key', status: 'cancel', events: [] })
  })
})
