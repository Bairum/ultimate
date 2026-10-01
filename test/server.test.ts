import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, prepareServer } from '../server/main.ts'
import { context } from '../server/harness.ts'
import type { AuthFlowEvent, ServerEvents } from '../shared/protocol.ts'

const servers: Awaited<ReturnType<typeof createServer>>[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function fixture(extra = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-test-'))
  directories.push(directory)
  const repoRoot = join(directory, 'repo')
  await mkdir(join(repoRoot, 'extensions', 'prompt'), { recursive: true })
  await mkdir(join(repoRoot, 'web'), { recursive: true })
  await symlink(resolvePath('node_modules'), join(repoRoot, 'node_modules'), 'dir')
  await writeFile(
    join(repoRoot, 'vite.config.ts'),
    "import { defineConfig } from 'vite-plus'; export default defineConfig({ root: 'web' })",
  )
  await writeFile(
    join(repoRoot, 'web', 'index.html'),
    '<html><body>Ultimate server is running</body></html>',
  )
  await writeFile(
    join(repoRoot, 'extensions', 'prompt', 'server.ts'),
    "import { defineExtension, section } from '@earendil-works/pi-durable'; export default defineExtension({ name: 'prompt', sections: [section('preamble', () => 'Test')] })",
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

describe('server', () => {
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
  it('hot reloads a transitive local import and retains the old extension on a syntax error', async () => {
    const { server } = await fixture(true)
    const entry = () => server.extensions.info().find((extension) => extension.name === 'counter')!
    const loaded = entry().server!.loadedAt
    await writeFile(
      join(server.host.repoRoot, 'extensions/counter/value.ts'),
      "export const value = 'two'",
    )
    await until(() => entry().server!.loadedAt !== loaded)
    const installed = server.host.registry.snapshot().extension('counter')!
    const section = installed.sections![0]
    expect(await section.render({} as Parameters<typeof section.render>[0], context)).toBe('two')
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
    const second = await post(server, '/api/auth/login', { provider: 'stub', type: 'api_key' })
    await until(
      () =>
        stream.events.filter(
          (event) => event.name === 'auth' && (event.data as AuthFlowEvent).type === 'prompt',
        ).length === 2,
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
