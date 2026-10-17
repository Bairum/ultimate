import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import {
  fauxServer as createServer,
  until,
  temp,
  removeTemp,
  linkDependencies,
  post,
} from './helpers.ts'
import { context } from '../server/harness.ts'
import { Store } from '../extensions/codemode/server.ts'

const servers: Awaited<ReturnType<typeof createServer>>[] = []
const directories: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.vite.watcher.close()
    await server.close()
  }
  for (const directory of directories.splice(0)) await removeTemp(directory)
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
          yielded?: boolean
          pendingSubagents?: { conversationId: number; background?: boolean }[]
          subagentAnswers?: number[]
        }
        isError: boolean
      },
    }
  } finally {
    state.dispose()
  }
}

it('calls extension actions with caller context and rejects missing or disabled actions', async () => {
  const { server, options } = await fixture()
  const path = join(options.ultimateRoot, 'extensions/action-test')
  await mkdir(path)
  await writeFile(
    join(path, 'server.ts'),
    `import { defineExtension } from '@earendil-works/pi-durable';
    export default defineExtension({ name: 'action-test' });
    export const actions = {
      echo: async (args, ctx) => ({ args, conversationId: ctx.conversationId, signal: ctx.signal instanceof AbortSignal }),
      fail: async () => { throw new Error('Action failed'); },
    };`,
  )
  await until(() => !!server.extensions.action('action-test', 'echo'))
  const result = await run(
    server,
    `return await ultimate.action('action-test', 'echo', { value: 42 });`,
  )
  expect(result.data.details.value).toEqual({
    args: { value: 42 },
    conversationId: server.root.id,
    signal: true,
  })
  const defaults = await run(server, `return await ultimate.action('action-test', 'echo');`)
  expect(defaults.data.details.value).toMatchObject({ args: null })
  for (const [extension, action, error] of [
    ['missing', 'echo', 'Unknown extension action: missing/echo'],
    ['action-test', 'missing', 'Unknown extension action: action-test/missing'],
    ['action-test', 'toString', 'Unknown extension action: action-test/toString'],
    ['action-test', 'fail', 'Action failed'],
  ]) {
    const failed = await run(server, `return await ultimate.action('${extension}', '${action}');`)
    expect(failed.data.isError).toBe(true)
    expect(failed.text).toContain(error)
  }
  await mkdir(join(options.userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(options.userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['action-test'] } }),
  )
  await until(() => !server.extensions.action('action-test', 'echo'))
  const disabled = await run(server, `return await ultimate.action('action-test', 'echo');`)
  expect(disabled.data.isError).toBe(true)
  expect(disabled.text).toContain('Unknown extension action: action-test/echo')
})

it('reserves trust and secret writes for the UI while allowing normal actions', async () => {
  const { server, options } = await fixture()
  await mkdir(join(options.ultimateRoot, 'server'), { recursive: true })
  await cp(resolve('server/lock.ts'), join(options.ultimateRoot, 'server/lock.ts'))
  // Onboarding's setup tool inspects isolation with the shared Git helper.
  await mkdir(join(options.ultimateRoot, 'extensions/workspaces'), { recursive: true })
  await cp(
    resolve('extensions/workspaces/git.ts'),
    join(options.ultimateRoot, 'extensions/workspaces/git.ts'),
  )
  for (const name of ['onboarding', 'secrets']) {
    await cp(resolve(`extensions/${name}`), join(options.ultimateRoot, `extensions/${name}`), {
      recursive: true,
    })
    await until(() => !!server.extensions.action(name, name === 'onboarding' ? 'decide' : 'set'))
  }
  for (const [extension, action, args] of [
    ['onboarding', 'decide', { local: true }],
    ['secrets', 'set', { name: 'TEST_KEY', value: 'test-value' }],
  ] as const) {
    const denied = await run(
      server,
      `return await ultimate.action('${extension}', '${action}', ${JSON.stringify(args)});`,
    )
    expect(denied.data.isError).toBe(true)
    expect(denied.text).toContain(`${extension}/${action} is a user-only action`)
    const response = await post(server, `/api/extensions/${extension}/actions/${action}`, { args })
    expect(response.status).toBe(200)
  }
  const normal = await run(server, `return await ultimate.action('secrets', 'list');`)
  expect(normal.data.isError).not.toBe(true)
  expect(normal.data.details.value).toEqual([
    expect.objectContaining({ name: 'TEST_KEY', set: true }),
  ])
})

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
              output: [{ type: 'text', text: 'private fallback' }],
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
            return { output: [{ type: 'text', text: 'overlapped' }] }
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

it('reads stored history and documents from before a reset', async () => {
  const { server } = await fixture()
  await run(server, `store('saved', 7); return 1;`, 'history-needle')
  await server.root.reset(undefined, context)
  const result = await run(
    server,
    `const matches = await ultimate.search('history-needle'); const entries = await ultimate.entries(1, {kinds:['pi.user'], limit:1}); const old = await ultimate.entries(1, {before:entries[0].id}); return {matches:matches.length, old:old.length, doc:await ultimate.doc('codemode.store')};`,
  )
  expect(result.data.isError).toBe(false)
  expect(result.data.details.value).toMatchObject({
    doc: { saved: 7 },
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

it('aborts nested work without committing store writes', async () => {
  const { server } = await fixture()
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
  const view = await server.root.viewState(context)
  expect(
    JSON.stringify(view.value.entries.findLast((entry) => entry.kind === 'pi.tool-result')),
  ).toMatch(/aborted|interrupted/)
  view.dispose()
})

it.each([
  ['sequential', `await tools.subagent({action:'wait', id:41});`],
  ['foreground start', `await tools.subagent({action:'start'});`],
  [
    'catch',
    `try { await tools.subagent({action:'wait', id:41}); } catch { text('caught'); await tools.effect({}); }`,
  ],
  [
    'finally',
    `try { await tools.subagent({action:'wait', id:41}); } finally { text('finalized'); await tools.effect({}); }`,
  ],
])('yields %s without executing the remainder or committing store writes', async (_name, wait) => {
  const { server } = await fixture()
  let effects = 0
  server.host.registry.install(
    defineExtension({
      name: 'yield-test',
      tools: [
        defineTool({
          name: 'subagent',
          description: 'Fake child wait',
          parameters: Type.Object({ action: Type.String(), id: Type.Optional(Type.Number()) }),
          execute: async ({ id }): Promise<ToolExecutionResult> =>
            id === 1
              ? {
                  output: [{ type: 'text', text: 'earlier-private-answer' }],
                  details: { conversationId: 1, answerId: 101 },
                }
              : {
                  output: [{ type: 'text', text: 'Unfinished; yielded to steering' }],
                  details: { yielded: true, conversationId: id ?? 41, background: true },
                },
        }),
        defineTool({
          name: 'effect',
          description: 'Record a side effect',
          parameters: Type.Object({}),
          execute: async () => {
            effects++
            return { output: [{ type: 'text', text: 'effect' }] }
          },
        }),
      ],
    }),
  )
  await run(server, `store('saved', 7); store('deleted', true);`)
  const result = await run(
    server,
    `await tools.subagent({action:'wait', id:1}); await tools.effect({}); text('prior-output'); store('saved', 99); store('deleted', undefined); store('new', true); ${wait} text('continued'); await tools.effect({}); return 'finished';`,
  )
  expect(result.data.isError).toBe(false)
  expect(result.data.details).toMatchObject({
    yielded: true,
    pendingSubagents: [{ conversationId: 41, background: true }],
    calls: [
      { name: 'subagent', status: 'ok' },
      { name: 'effect', status: 'ok' },
      { name: 'subagent', status: 'yielded' },
    ],
  })
  expect(result.data.details).not.toHaveProperty('subagentAnswers')
  expect(result.data.details.value).toBeUndefined()
  expect(result.data.details.error).toBeUndefined()
  expect(result.text).toContain(
    'Script yielded to steering; subagents still running; remaining script not executed; prior side effects may have happened',
  )
  expect(result.text).toContain('41')
  expect(result.text).toContain('prior-output')
  expect(result.text).not.toMatch(
    /Script completed|Script failed|continued|caught|finalized|finished|earlier-private-answer/,
  )
  expect(effects).toBe(1)
  expect(await server.harness.snapshot(Store, server.root.id, context)).toEqual({
    saved: 7,
    deleted: true,
  })
  // A sandbox-local yield does not cancel the parent's invocation or its next tool round.
  expect((await run(server, `return await tools.effect({});`)).data.details.value).toBe('effect')
  expect(effects).toBe(2)
})

it('yields Promise.all, cancels pending host work, and preserves other waiting child IDs', async () => {
  const { server } = await fixture()
  let entered = 0
  let release!: () => void
  const barrier = new Promise<void>((done) => {
    release = done
  })
  let cancelled = 0
  let effects = 0
  const rendezvous = () => {
    if (++entered === 3) release()
  }
  server.host.registry.install(
    defineExtension({
      name: 'parallel-yield-test',
      tools: [
        defineTool({
          name: 'subagent',
          description: 'Fake parallel wait',
          parameters: Type.Object({ action: Type.String(), id: Type.Number() }),
          execute: async ({ id }, _api, nestedContext) => {
            rendezvous()
            if (id === 41) {
              await barrier
              return {
                output: [{ type: 'text', text: 'Still running' }],
                details: { yielded: true, conversationId: id },
              }
            }
            await new Promise<void>((_resolve, reject) => {
              nestedContext.abortSignal!.addEventListener(
                'abort',
                () => {
                  cancelled++
                  reject(new Error('Wait cancelled'))
                },
                { once: true },
              )
            })
            throw new Error('Unreachable')
          },
        }),
        defineTool({
          name: 'effect',
          description: 'Normal cancellable tool',
          parameters: Type.Object({}),
          execute: async (_args, _api, nestedContext) => {
            rendezvous()
            await new Promise<void>((_resolve, reject) => {
              nestedContext.abortSignal!.addEventListener(
                'abort',
                () => {
                  cancelled++
                  reject(new Error('Work cancelled'))
                },
                { once: true },
              )
            })
            effects++
            return { output: [{ type: 'text', text: 'effect' }] }
          },
        }),
      ],
    }),
  )
  const result = await run(
    server,
    `store('parallel', true); try { await Promise.all([tools.subagent({action:'wait', id:41}), tools.subagent({action:'wait', id:42}), tools.effect({})]); } catch { text('caught'); } finally { text('finalized'); } text('continued'); return 'finished';`,
  )
  expect(result.data.isError).toBe(false)
  expect(result.data.details.yielded).toBe(true)
  expect(result.data.details).not.toHaveProperty('subagentAnswers')
  expect(result.data.details.pendingSubagents).toEqual([
    { conversationId: 41 },
    { conversationId: 42 },
  ])
  expect(result.data.details.calls.map((call) => [call.name, call.status])).toEqual([
    ['subagent', 'yielded'],
    ['subagent', 'cancelled'],
    ['effect', 'cancelled'],
  ])
  expect(cancelled).toBe(2)
  expect(effects).toBe(0)
  expect(result.text).not.toMatch(/caught|finalized|continued|finished|Script failed/)
  expect(await server.harness.snapshot(Store, server.root.id, context)).toBeUndefined()
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
