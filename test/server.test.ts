import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { once } from 'node:events'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import { defineExtension, InboxDoc, LiveDoc } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, prepareServer } from '../server/main.ts'
import { context } from '../server/harness.ts'
import { UiState } from '../server/ui-state.ts'
import type { AuthFlowEvent, ServerEvents } from '../shared/protocol.ts'

const servers: Awaited<ReturnType<typeof createServer>>[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    await server.vite.watcher.close()
    await server.close()
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
async function fixture(extra = false, agents = false, sources?: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-test-'))
  directories.push(directory)
  const repoRoot = join(directory, 'repo')
  await mkdir(join(repoRoot, 'extensions', 'prompt'), { recursive: true })
  await cp(resolvePath('extensions/coding-tools'), join(repoRoot, 'extensions/coding-tools'), {
    recursive: true,
  })
  await mkdir(join(repoRoot, 'web'), { recursive: true })
  await symlink(resolvePath('node_modules'), join(repoRoot, 'node_modules'), 'dir')
  await writeFile(
    join(repoRoot, 'vite.config.ts'),
    "import { defineConfig } from 'vite-plus'; export default defineConfig({ root: 'web', optimizeDeps: { noDiscovery: true } })",
  )
  await writeFile(
    join(repoRoot, 'web', 'index.html'),
    '<html><body>Ultimate server is running</body></html>',
  )
  await writeFile(
    join(repoRoot, 'extensions', 'prompt', 'server.ts'),
    await readFile(resolvePath('extensions/prompt/server.ts'), 'utf8'),
  )
  if (extra) {
    await mkdir(join(repoRoot, 'extensions', 'counter'), { recursive: true })
    await writeFile(
      join(repoRoot, 'extensions', 'counter', 'value.ts'),
      "export const value = 'one'",
    )
    await writeFile(join(repoRoot, 'extensions', 'counter', 'server.ts'), counterSource)
    await mkdir(join(repoRoot, 'extensions', 'web-only'), { recursive: true })
    await writeFile(
      join(repoRoot, 'extensions', 'web-only', 'web.tsx'),
      'export default () => null',
    )
    await writeFile(
      join(repoRoot, 'extensions', 'web-only', 'README.md'),
      'A browser-only extension.\n\nMore detail.',
    )
  }
  if (agents) {
    await mkdir(join(repoRoot, 'server'), { recursive: true })
    await cp(resolvePath('server/metadata.ts'), join(repoRoot, 'server/metadata.ts'))
    await cp(resolvePath('server/agents.ts'), join(repoRoot, 'server/agents.ts'))
    await cp(resolvePath('extensions/subagents'), join(repoRoot, 'extensions/subagents'), {
      recursive: true,
    })
    await cp(resolvePath('agents'), join(repoRoot, 'agents'), { recursive: true })
    await writeFile(join(repoRoot, 'agents/broken.md'), 'not frontmatter')
    await writeFile(
      join(repoRoot, 'agents/configured.md'),
      '---\nname: configured\ndescription: Configured agent\nmodel: openai-codex/gpt-5.4\nthinking: max\n---\nInvestigate.',
    )
  }
  if (sources) {
    await rm(join(repoRoot, 'extensions/coding-tools'), { recursive: true })
    for (const [name, source] of Object.entries(sources)) {
      await mkdir(join(repoRoot, 'extensions', name), { recursive: true })
      await writeFile(join(repoRoot, 'extensions', name, 'server.ts'), source)
    }
  }
  const options = { repoRoot, home: join(directory, 'home'), faux: true, port: 0 }
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
async function post(
  server: Awaited<ReturnType<typeof createServer>>,
  path: string,
  data: unknown = {},
) {
  const response = await fetch(server.url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { status: response.status, data: (await response.json()) as Record<string, unknown> }
}
async function until(test: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}
async function attach(server: Awaited<ReturnType<typeof createServer>>, query = '') {
  const controller = new AbortController()
  const response = await fetch(server.url + '/api/events' + query, { signal: controller.signal })
  expect(response.status).toBe(200)
  const events: { name: keyof ServerEvents; data: unknown }[] = []
  const reader = response.body!.getReader()
  let pending = ''
  const task = (async () => {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      pending += new TextDecoder().decode(result.value)
      let index: number
      while ((index = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, index)
        pending = pending.slice(index + 2)
        const name = /^event: (.+)$/m.exec(block)?.[1]
        const data = /^data: (.+)$/m.exec(block)?.[1]
        if (name && data) events.push({ name: name as keyof ServerEvents, data: JSON.parse(data) })
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) throw error
  })
  await until(() => events.some((event) => event.name === 'view'))
  return {
    events,
    async close() {
      controller.abort()
      await task
    },
  }
}

const orderedSource = (name: string, order = 0) => `
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
export const order = ${order}
export default defineExtension({ name: '${name}', sections: [section('${name === '0-new' ? 'new' : name}', () => '${name}')], tools: [defineTool({ name: '${name === '0-new' ? 'new' : name}', description: '${name}', parameters: Type.Object({}), execute: async () => ({}) })] })`

describe('server', () => {
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
        expect(system?.role === 'system' ? system.sections?.self : undefined).toContain(
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
    const folder = join(options.repoRoot, 'extensions/0-new')
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

  it('puts identity first in the faux server system prompt', async () => {
    const { server } = await fixture()
    await post(server, '/api/conversations/1/submit', { text: 'Return the word SCOUT.' })
    await server.harness.waitForIdle(context)
    const view = await server.root.viewState(context)
    const message = view.value.entries.find((entry) => entry.kind === 'pi.system')!.model![0]
    if (message.role !== 'system') throw new Error('Expected system message')
    expect(Object.keys(message.sections!)[0]).toBe('identity')
    view.dispose()
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

  it('forks root UI state as of the selected entry', async () => {
    const { server } = await fixture()
    await post(server, '/api/ui', { set: { 'shell.panel': 'tasks' } })
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
  })

  it('runs the faux subagent demo and streams its tree, child transcript and definition errors', async () => {
    const { server } = await fixture(false, true)
    const stream = await attach(server)
    const system = stream.events.find((event) => event.name === 'system')!
      .data as ServerEvents['system']
    expect(system.agents.find((agent) => agent.name === 'scout')).toMatchObject({
      description: expect.stringContaining('read-only'),
    })
    expect(system.agents.find((agent) => agent.name === 'configured')).toMatchObject({
      model: { provider: 'openai-codex', modelId: 'gpt-5.4' },
      thinking: 'max',
    })
    expect(system.agents.find((agent) => agent.name === 'broken')).toMatchObject({
      error: expect.stringContaining('frontmatter'),
    })
    await post(server, '/api/conversations/1/submit', { text: 'delegate to scout' })
    await server.root.waitForIdle(context)
    let child: ServerEvents['conversations'][number] | undefined
    await until(() => {
      for (const event of stream.events) {
        if (event.name === 'conversations')
          child =
            (event.data as ServerEvents['conversations']).find((item) => item.agent === 'scout') ??
            child
      }
      return child?.title === 'Return the word SCOUT.' && !child.busy
    })
    expect(child).toMatchObject({
      parentConversationId: server.root.id,
      ownerTaskId: expect.any(Number),
      background: false,
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
    await until(() => stream.events.some((event) => event.name === 'ops'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    let replica = stream.events.find((event) => event.name === 'view')!.data as ConversationView
    for (const event of stream.events)
      if (event.name === 'ops') replica = applyImmutable(replica, event.data as Op[])
    const state = await server.root.viewState(context)
    expect(replica).toEqual(state.value)
    state.dispose()
    expect(replica.entries.filter((entry) => entry.kind === 'pi.tool-result')).toHaveLength(2)
    expect(await readFile(join(server.host.home, 'demo.txt'), 'utf8')).toBe('after\n')
    await stream.close()
  })
  it('accepts configure, submit, steering, follow-up and abort; validates errors and creates conversations', async () => {
    const { server } = await fixture()
    expect(
      (
        await post(server, '/api/conversations/1/configure', {
          model: { provider: 'faux', modelId: 'faux-1' },
          thinkingLevel: 'high',
        })
      ).status,
    ).toBe(200)
    expect((await server.root.agent(context)).thinkingLevel).toBe('high')
    expect(
      (await post(server, '/api/conversations/1/configure', { thinkingLevel: 'max' })).status,
    ).toBe(200)
    expect((await server.root.agent(context)).thinkingLevel).toBe('max')
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
    expect(
      (await post(server, '/api/conversations/1/configure', { thinkingLevel: 'bogus' })).status,
    ).toBe(400)
    const created = await post(server, '/api/conversations', {
      title: 'Another',
      cwd: server.host.repoRoot,
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
  it('updates only touched summaries and does no summary reads for streaming commits', async () => {
    const { server } = await fixture()
    for (let index = 0; index < 4; index++)
      await post(server, '/api/conversations', { title: `Other ${index}` })
    const snapshot = vi.spyOn(server.harness, 'snapshot')
    const stream = await attach(server)
    await post(server, '/api/conversations/1/submit', { text: 'demo' })
    await server.harness.waitForIdle(context)
    await until(() =>
      stream.events.some(
        (event) =>
          event.name === 'conversations' &&
          (event.data as { id: number; busy: boolean; title?: string }[]).some(
            (summary) => summary.id === 1 && summary.title === 'demo' && !summary.busy,
          ),
      ),
    )
    const summaryReads = snapshot.mock.calls.filter(
      ([token]) => token.definition.kind === 'ultimate.metadata',
    )
    expect(summaryReads).toHaveLength(1)
    expect(summaryReads[0][1]).toBe(1)
    await stream.close()
  })
  it('reports machine, persistence, shared resources and folder facets', async () => {
    const { server } = await fixture(true)
    const info = server.system.current()
    expect(info.machine.cpuCount).toBeGreaterThan(0)
    expect(info.machine.hostname).not.toBe('')
    expect(info.machine.home).toBe(homedir())
    expect(info.process.url).toBe(server.url)
    expect(info.persistence.kind).toBe('sqlite')
    expect(info.persistence.sizeBytes).toBeGreaterThan(0)
    expect(info.execution.defaultCwd).toBe(server.host.repoRoot)
    expect(info.extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'web-only',
          readme: 'A browser-only extension.',
          facets: { server: false, web: true },
        }),
      ]),
    )
    expect(info.extensions.find((extension) => extension.name === 'counter')?.server?.docs).toEqual(
      ['test.counter'],
    )
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
      join(options.repoRoot, 'extensions/counter/value.ts'),
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
      join(options.repoRoot, 'extensions/web-only/web.tsx'),
      'export default () => "changed"',
    )
    await until(() => server.host.build().id !== second.id)
    expect(server.host.build().changed).toEqual(['extensions/web-only'])
    expect(server.host.build().history).toHaveLength(3)
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
      join(server.host.repoRoot, 'extensions/counter/value.ts'),
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
    await new Promise((resolve) => setTimeout(resolve, 200))
    await writeFile(
      join(server.host.repoRoot, 'extensions/counter/value.ts'),
      'this is not valid TS !!!',
    )
    await until(() => !!entry().server!.error)
    expect(entry().server!.loadedAt).toBe(successful)
    expect(server.host.registry.snapshot().extension('counter')).toBe(installed)
  })
  it('keeps hot reloading extensions after a Vite config change restarts Vite', async () => {
    const { server } = await fixture(true)
    const entry = () => server.extensions.info().find((extension) => extension.name === 'counter')!
    const config = join(server.host.repoRoot, 'vite.config.ts')
    const watcher = server.vite.watcher
    await writeFile(config, `${await readFile(config, 'utf8')}\n`)
    await until(() => server.vite.watcher !== watcher)
    const loaded = entry().server!.loadedAt
    await writeFile(
      join(server.host.repoRoot, 'extensions/counter/value.ts'),
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
      join(server.host.repoRoot, 'extensions/web-only/README.md'),
      'Changed browser facet',
    )
    await until(
      () =>
        server.extensions.info().find((extension) => extension.name === 'web-only')?.readme ===
        'Changed browser facet',
    )
    expect(server.host.registry.snapshot().extension('web-only')).toBe(external)
    await rm(join(server.host.repoRoot, 'extensions/web-only'), {
      recursive: true,
      force: true,
      maxRetries: 5,
    })
    await until(() => !server.extensions.info().some((extension) => extension.name === 'web-only'))
    expect(server.host.registry.snapshot().extension('web-only')).toBe(external)
  })
  it('discovers and removes extension folders while running', async () => {
    const { server } = await fixture()
    const folder = join(server.host.repoRoot, 'extensions', 'added')
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
    const { fauxAssistantMessage, fauxToolCall } =
      await import('@earendil-works/pi-ai/providers/faux')
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
  it('resumes a committed mid-turn checkpoint after SIGKILL', async () => {
    const { server, options } = await fixture()
    await server.vite.watcher.close()
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createServer } from ${JSON.stringify(resolvePath('server/main.ts'))}; const server = await createServer(${JSON.stringify(options)}); console.log('READY ' + server.url)`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on('data', () => {})
    try {
      await until(() => output.includes('READY '))
      const url = /READY (http:\/\/[^\s]+)/.exec(output)![1]
      const response = await fetch(url + '/api/conversations/1/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'resume demo' }),
      })
      expect(response.status).toBe(202)
      // Wait for a committed live generation or tool before killing the owner.
      const controller = new AbortController()
      const stream = await fetch(url + '/api/events', { signal: controller.signal })
      const reader = stream.body!.getReader()
      let wire = ''
      while (!wire.includes('starting') && !wire.includes('I will demonstrate')) {
        const next = await reader.read()
        if (next.done) throw new Error('Stream ended')
        wire += new TextDecoder().decode(next.value)
      }
      expect(wire).not.toContain('## Complete')
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      controller.abort()
      const resumed = await createServer(options)
      servers.push(resumed)
      await resumed.harness.waitForIdle(context)
      const state = await resumed.root.viewState(context)
      expect(
        state.value.entries.some(
          (entry) =>
            entry.kind === 'pi.assistant' && JSON.stringify(entry.model).includes('## Complete'),
        ),
      ).toBe(true)
      expect(await readFile(join(options.home, 'demo.txt'), 'utf8')).toBe('after\n')
      state.dispose()
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
  })
  it('bridges login prompts to answers and cancellation without exposing credentials', async () => {
    const { server } = await fixture()
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
    const stream = await attach(server)
    const login = await post(server, '/api/auth/login', { provider: 'stub', type: 'api_key' })
    expect(login.status).toBe(202)
    await until(() =>
      stream.events.some(
        (event) => event.name === 'auth' && (event.data as AuthFlowEvent).type === 'prompt',
      ),
    )
    expect(
      (
        await post(server, `/api/auth/flows/${String(login.data.flowId)}/answer`, {
          value: 'not-a-real-credential',
        })
      ).status,
    ).toBe(200)
    await until(() =>
      stream.events.some(
        (event) => event.name === 'auth' && (event.data as AuthFlowEvent).type === 'complete',
      ),
    )
    expect(answered).toBe('not-a-real-credential')
    expect(JSON.stringify(stream.events)).not.toContain('not-a-real-credential')
    const blank = await post(server, '/api/auth/login', { provider: 'stub', type: 'api_key' })
    await until(
      () =>
        stream.events.filter(
          (event) => event.name === 'auth' && (event.data as AuthFlowEvent).type === 'prompt',
        ).length === 2,
    )
    expect(
      (await post(server, `/api/auth/flows/${String(blank.data.flowId)}/answer`, { value: '' }))
        .status,
    ).toBe(200)
    await until(
      () =>
        stream.events.filter(
          (event) => event.name === 'auth' && (event.data as AuthFlowEvent).type === 'complete',
        ).length === 2,
    )
    expect(answered).toBe('')
    const second = await post(server, '/api/auth/login', { provider: 'stub', type: 'api_key' })
    await until(
      () =>
        stream.events.filter(
          (event) => event.name === 'auth' && (event.data as AuthFlowEvent).type === 'prompt',
        ).length === 3,
    )
    expect(
      (await post(server, `/api/auth/flows/${String(second.data.flowId)}/cancel`)).status,
    ).toBe(200)
    await until(() =>
      stream.events.some(
        (event) => event.name === 'auth' && (event.data as AuthFlowEvent).type === 'cancel',
      ),
    )
    await stream.close()
  })
})
