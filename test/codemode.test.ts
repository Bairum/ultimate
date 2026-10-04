import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { fauxServer as createServer, until, temp, linkDependencies } from './helpers.ts'
import { context } from '../server/harness.ts'
import { Store } from '../extensions/codemode/server.ts'

const servers: Awaited<ReturnType<typeof createServer>>[] = []
const directories: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.vite.watcher.close()
    await server.close()
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})
async function fixture() {
  const directory = await temp('ultimate-codemode-')
  directories.push(directory)
  const ultimateRoot = join(directory, 'repo')
  await mkdir(join(ultimateRoot, 'extensions/codemode'), { recursive: true })
  await cp(resolve('extensions/coding-tools'), join(ultimateRoot, 'extensions/coding-tools'), {
    recursive: true,
  })
  await cp(resolve('extensions/faux'), join(ultimateRoot, 'extensions/faux'), { recursive: true })
  await mkdir(join(ultimateRoot, 'web'), { recursive: true })
  await linkDependencies(ultimateRoot)
  await writeFile(
    join(ultimateRoot, 'vite.config.ts'),
    "import { defineConfig } from 'vite-plus'; export default defineConfig({ root: 'web', cacheDir: '.vite-cache', optimizeDeps: { noDiscovery: true } })",
  )
  await writeFile(join(ultimateRoot, 'web/index.html'), '<html>Codemode</html>')
  // The copy reaches the definitions module in the checkout, as `ultimate.agents()` reads them through it.
  await writeFile(
    join(ultimateRoot, 'extensions/codemode/server.ts'),
    (await readFile(resolve('extensions/codemode/server.ts'), 'utf8')).replace(
      "'../subagents/agents.ts'",
      JSON.stringify(resolve('extensions/subagents/agents.ts')),
    ),
  )
  const options = {
    ultimateRoot,
    projectRoot: ultimateRoot,
    userHome: directory,
    home: join(directory, 'home'),
    faux: true,
    port: 0,
  }
  const server = await createServer(options)
  servers.push(server)
  expect(
    server.extensions.info().find((extension) => extension.name === 'codemode')?.server?.error,
  ).toBeUndefined()
  return { server, options }
}
async function run(
  server: Awaited<ReturnType<typeof createServer>>,
  code: string,
  prompt = 'run codemode',
) {
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('codemode', { code })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: prompt }, context)
  await server.harness.waitForIdle(context)
  const state = await server.root.viewState(context)
  try {
    const entry = state.value.entries.findLast((item) => item.kind === 'pi.tool-result')!
    return {
      text: JSON.stringify(entry.model?.[0]?.role === 'toolResult' ? entry.model[0].content : []),
      data: entry.model![0] as unknown as {
        details: {
          calls: { name: string; status: string; ms: number }[]
          value?: unknown
          error?: string
        }
        isError: boolean
      },
    }
  } finally {
    state.dispose()
  }
}

it('composes read and bash with private nested results and final JSON details', async () => {
  const { server } = await fixture()
  const path = join(server.host.home, 'demo.txt')
  const result = await run(
    server,
    `const source = await tools.read({path:${JSON.stringify(path)}}); const shell = await tools.bash({command:'echo nested-private'}); text(source.trim()); return {length:shell.length};`,
  )
  expect(result.text).toContain('Script completed')
  expect(result.text).toContain('before')
  expect(result.text).not.toContain('nested-private')
  expect(result.data.details.calls.map((call) => [call.name, call.status])).toEqual([
    ['read', 'ok'],
    ['bash', 'ok'],
  ])
  expect(result.data.details.value).toEqual({ length: 15 })
  const view = await server.root.viewState(context)
  expect(view.value.entries.filter((entry) => entry.kind === 'pi.tool-result')).toHaveLength(1)
  view.dispose()
  server.host.registry.install(
    defineExtension({
      name: 'structured',
      tools: [
        {
          ...defineTool({
            name: 'structured',
            description: 'Structured test',
            parameters: Type.Object({ answer: Type.Number() }),
            execute: async ({ answer }) => ({
              structuredContent: { answer },
              content: [{ type: 'text', text: 'private fallback' }],
            }),
          }),
          outputSchema: { type: 'object' },
        },
      ],
    }),
  )
  const structured = await run(server, `return await tools.structured({answer:42});`)
  expect(structured.data.details.value).toEqual({ answer: 42 })
  const invalid = await run(server, `await tools.structured({answer:'wrong'});`)
  expect(invalid.data.isError).toBe(true)
  expect(invalid.data.details.calls[0].status).toBe('error')
  const agent = await server.root.agent(context)
  const tool = agent.tools.find((candidate) => candidate.name === 'codemode')!
  expect(tool.description).toContain('ultimate')
  expect(tool.description).toContain('conversationId: number')
  expect(agent.tools.some((candidate) => candidate.name.startsWith('ultimate.'))).toBe(false)
  let entered = 0
  let release!: () => void
  const barrier = new Promise<void>((done) => {
    release = done
  })
  server.host.registry.install(
    defineExtension({
      name: 'parallel',
      tools: [
        defineTool({
          name: 'rendezvous',
          description: 'Wait for both calls',
          parameters: Type.Object({}),
          execute: async () => {
            if (++entered === 2) release()
            await barrier
            return { content: [{ type: 'text', text: 'overlapped' }] }
          },
        }),
      ],
    }),
  )
  const parallel = await run(
    server,
    `return await Promise.all([tools.rendezvous({}), tools.rendezvous({})]);`,
  )
  expect(parallel.data.details.value).toEqual(['overlapped', 'overlapped'])
  const caught = await run(
    server,
    `try { await tools.read({path:'missing-file'}); } catch (error) { return error.message; }`,
  )
  expect(caught.data.details.calls[0].status).toBe('error')
  expect(String(caught.data.details.value)).toContain('missing-file')
  const failed = await run(server, `text('kept');\nawait tools.read({path:'missing-file'});`)
  expect(failed.text).toContain('Script failed')
  expect(failed.text).toContain('kept')
  expect(failed.data.details.error).toContain('missing-file')
  expect(failed.data.isError).toBe(true)
})

it('introspects extensions, documents, system, conversations, task graph, models, agents, and pre-reset stored history', async () => {
  const { server, options } = await fixture()
  await mkdir(join(options.ultimateRoot, 'agents'))
  await writeFile(
    join(options.ultimateRoot, 'agents/scout.md'),
    '---\nname: scout\ndescription: Search\ntools: [read]\n---\nLook\n',
  )
  await writeFile(join(options.ultimateRoot, 'agents/broken.md'), 'broken')
  await run(server, `store('saved', 7); return 1;`, 'history-needle')
  await server.root.reset(undefined, context)
  const response = await fetch(server.url + '/api/ui', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set: { 'shell.activeView': 'tasks' } }),
  })
  expect(response.status).toBe(200)
  const ui = await run(
    server,
    `return {ui:await ultimate.uiState(), live:!!(await ultimate.doc('pi.live'))};`,
  )
  expect(ui.data.details.value).toEqual({ ui: { 'shell.activeView': 'tasks' }, live: true })
  const result = await run(
    server,
    `const extensions = await ultimate.extensions(); const matches = await ultimate.search('history-needle'); const entries = await ultimate.entries(1, {kinds:['pi.user'], limit:1}); const old = await ultimate.entries(1, {before:entries[0].id}); return {extension:extensions.find(x=>x.name==='codemode'), matches:matches.length, old:old.length, doc:await ultimate.doc('codemode.store'), pid:(await ultimate.system()).process.pid, conversations:(await ultimate.conversations()).length, graph:!!(await ultimate.taskGraph()), models:Array.isArray(await ultimate.models()), agents:await ultimate.agents()};`,
  )
  expect(result.data.isError).toBe(false)
  expect(result.data.details.value).toMatchObject({
    extension: { facets: { server: true, web: false }, server: { tools: ['codemode'] } },
    doc: { saved: 7 },
    conversations: 1,
    graph: true,
    models: true,
    pid: process.pid,
    agents: {
      definitions: [
        {
          name: 'scout',
          description: 'Search',
          source: 'builtin',
          path: join(options.ultimateRoot, 'agents/scout.md'),
          tools: ['read'],
          instructions: 'Look',
        },
      ],
      errors: [
        { name: 'broken', source: 'builtin', error: expect.stringContaining('frontmatter') },
      ],
    },
  })
  expect((result.data.details.value as { matches: number }).matches).toBeGreaterThan(0)
  expect((result.data.details.value as { old: number }).old).toBeGreaterThan(0)
})

it('persists store over two calls and harness close/reopen; discards failed writes', async () => {
  const { server, options } = await fixture()
  expect(
    (await run(server, `store('runs', (load('runs') ?? 0)+1); return load('runs');`)).data.details
      .value,
  ).toBe(1)
  expect(
    (await run(server, `store('runs', load('runs')+1); return load('runs');`)).data.details.value,
  ).toBe(2)
  await run(server, `store('runs', 99); throw new Error('no commit');`)
  expect(await server.harness.snapshot(Store, server.root.id, context)).toEqual({ runs: 2 })
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = await createServer(options)
  servers.push(reopened)
  expect(
    (await run(reopened, `const n = load('runs'); store('runs', undefined); return n;`)).data
      .details.value,
  ).toBe(2)
  expect(await reopened.harness.snapshot(Store, reopened.root.id, context)).toEqual({})
  const truncated = await run(
    reopened,
    `// @options: {"max_output_tokens":20}\ntext('x'.repeat(1000));`,
  )
  expect(truncated.text).toContain('Output truncated')
})

it('shows faux-demo nested progress in pi.live before completion and aborts nested work', async () => {
  const { server } = await fixture()
  await server.root.submit({ type: 'input', content: 'codemode demo' }, context)
  await until(async () => {
    const state = await server.root.viewState(context)
    try {
      return JSON.stringify(state.value.docs['pi.live']).includes('✓ tools.read')
    } finally {
      state.dispose()
    }
  })
  await server.harness.waitForIdle(context)
  let view = await server.root.viewState(context)
  expect(
    JSON.stringify(view.value.entries.find((entry) => entry.kind === 'pi.tool-result')),
  ).toContain('Script completed')
  view.dispose()
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('codemode', {
          code: `await tools.read({path:${JSON.stringify(join(server.host.home, 'demo.txt'))}}); await tools.bash({command:'sleep 30'}); store('aborted', true);`,
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: 'abort this' }, context)
  await until(async () => {
    const state = await server.root.viewState(context)
    try {
      return JSON.stringify(state.value.docs['pi.live']).includes('✓ tools.read')
    } finally {
      state.dispose()
    }
  })
  await server.root.abort(context)
  await server.harness.waitForIdle(context)
  expect(await server.harness.snapshot(Store, server.root.id, context)).toBeUndefined()
  view = await server.root.viewState(context)
  expect(
    JSON.stringify(view.value.entries.findLast((entry) => entry.kind === 'pi.tool-result')),
  ).toMatch(/aborted|interrupted/)
  view.dispose()
})

it('recovers an unsafe interrupted script with its committed nested-call log', async () => {
  const { server, options } = await fixture()
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('codemode', {
          code: `await tools.read({path:${JSON.stringify(join(server.host.home, 'demo.txt'))}}); await tools.bash({command:'sleep 30'}); store('finished', true);`,
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: 'interrupt this' }, context)
  await until(async () => {
    const state = await server.root.viewState(context)
    try {
      return JSON.stringify(state.value.docs['pi.live']).includes('✓ tools.read')
    } finally {
      state.dispose()
    }
  })
  await server.vite.watcher.close()
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = await createServer(options)
  servers.push(reopened)
  await reopened.harness.waitForIdle(context)
  const state = await reopened.root.viewState(context)
  try {
    const result = state.value.entries.find((entry) => entry.kind === 'pi.tool-result')
    expect(JSON.stringify(result)).toContain('interrupted')
    expect(JSON.stringify(result)).toContain('✓ tools.read')
    expect(await reopened.harness.snapshot(Store, reopened.root.id, context)).toBeUndefined()
  } finally {
    state.dispose()
  }
})
