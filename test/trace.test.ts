import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { afterAll, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { callTrace, summary } from '../server/trace.ts'
import type { Call, CallTree } from '../server/trace.ts'
import { fauxServer, linkDependencies, temp, until } from './helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const tokens = `
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { defineApi } from '${resolve('shared/extension-api.ts')}'
import { defineEvent } from '${resolve('shared/events.ts')}'
const Beta = defineApi()('beta')
const Delta = defineApi()('delta')
const Worked = defineEvent('beta.worked')`
// alpha's action calls beta's service, which emits an event; gamma reacts by calling delta, which tooler's tool calls too.
const extensions = {
  alpha: `${tokens}
export default defineExtension({ name: 'alpha' })
export const actions = {
  go: async (args, { host }) => host.need(Beta).work(args),
  recent: async (_args, { host }) => host.eventLog.recent({ events: [Worked] }),
  fail: async (_args, { host }) => {
    const beta = host.need(Beta)
    const thrown = host.resource('beta.thrown', () => new Error('boom'))
    const caught = []
    try { beta.boom() } catch (error) { caught.push(error === thrown) }
    try { await beta.reject() } catch (error) { caught.push(error === thrown) }
    return caught
  },
}`,
  beta: `${tokens}
export default (host) => {
  const thrown = host.resource('beta.thrown', () => new Error('boom'))
  host.implement(Beta, {
    async work(args) {
      await host.harness().commit((tx) => host.emit(tx, Worked, { n: 1 }), {})
      return { done: true, args }
    },
    boom() { throw thrown },
    async reject() { throw thrown },
  })
  return defineExtension({ name: 'beta' })
}`,
  gamma: `${tokens}
export default (host) => {
  const delta = host.need(Delta)
  host.react('on-worked', [Worked], async (_tx, event) => { delta.note({ from: event.name }) })
  return defineExtension({ name: 'gamma' })
}`,
  delta: `${tokens}
export default (host) => {
  host.implement(Delta, { note: (data) => ({ noted: data }) })
  return defineExtension({ name: 'delta' })
}`,
  tooler: `${tokens}
import { Type } from '@earendil-works/pi-ai'
export default (host) => {
  const delta = host.need(Delta)
  return defineExtension({
    name: 'tooler',
    tools: [defineTool({
      name: 'probe',
      description: 'Calls delta',
      parameters: Type.Object({}),
      execute: async (_args, api, ctx) => {
        await api.commit(async () => delta.note({ tool: true }), ctx)
        return { output: [{ type: 'text', text: 'probed' }] }
      },
    })],
  })
}`,
}

/** A minimal Ultimate with the five extensions above and the real secrets extension. */
async function start() {
  const root = await temp('ultimate-trace-')
  await linkDependencies(root)
  await mkdir(join(root, 'web'))
  await writeFile(
    join(root, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true } }",
  )
  await mkdir(join(root, 'extensions'))
  await symlink(resolve('extensions/secrets'), join(root, 'extensions/secrets'))
  for (const [name, source] of Object.entries(extensions)) {
    await mkdir(join(root, 'extensions', name))
    await writeFile(join(root, 'extensions', name, 'server.ts'), source)
  }
  const home = await temp()
  const server = await fauxServer({ ultimateRoot: root, home, userHome: home })
  servers.push(server)
  for (const name of [...Object.keys(extensions), 'secrets'])
    expect(server.extensions.info().find((entry) => entry.name === name)?.server?.error).toBe(
      undefined,
    )
  return server
}
const signal = new AbortController().signal
const call = (name: string): Call => ({ kind: 'service', caller: 'a', callee: 'b', name })
/** Names of a tree, nested like it. */
const shape = (nodes: CallTree[]): unknown[] =>
  nodes.map((node) => (node.children.length ? [node.name, shape(node.children)] : node.name))

it('traces an action through a service, its event and a reactor into another service', async () => {
  const server = await start()
  const conversation = server.root.id as number
  const result = await server.extensions.invoke(
    'alpha',
    'go',
    { token: 'abc', nested: { secret: 's', value: 1 } },
    signal,
    conversation,
  )
  expect(result).toEqual({ done: true, args: { token: 'abc', nested: { secret: 's', value: 1 } } })
  const action = server.extensions.trace.query().find((row) => row.name === 'alpha/go')!
  await until(() =>
    server.extensions.trace.query({ trace: action.trace }).some((row) => row.name === 'delta.note'),
  )
  const rows = server.extensions.trace.query({ trace: action.trace })
  expect(rows.map((row) => [row.kind, row.caller, row.callee, row.name])).toEqual([
    ['action', 'ui', 'alpha', 'alpha/go'],
    ['service', 'alpha', 'beta', 'beta.work'],
    ['reactor', 'beta.worked', 'gamma', 'gamma/on-worked'],
    ['service', 'gamma', 'delta', 'delta.note'],
  ])
  const [, work, reactor, note] = rows
  expect([work.parent, reactor.parent, note.parent]).toEqual([action.id, work.id, reactor.id])
  for (const row of rows) {
    expect(row).toMatchObject({ ok: true, conversation })
    expect(row.ms).toBeGreaterThanOrEqual(0)
  }
  expect(shape(server.extensions.trace.tree(action.trace))).toEqual([
    ['alpha/go', [['beta.work', [['gamma/on-worked', ['delta.note']]]]]],
  ])
  // The event carries the context the reaction continued.
  const [event] = (await server.extensions.invoke('alpha', 'recent', null, signal)) as {
    context: unknown
  }[]
  expect(event.context).toEqual({
    traceId: action.trace,
    conversationId: conversation,
    parentCall: work.id,
  })
  // Secret-looking keys are redacted in arguments and results.
  expect(work.args).toBe('[{"token":"[redacted]","nested":{"secret":"[redacted]","value":1}}]')
  expect(work.result).toBe(
    '{"done":true,"args":{"token":"[redacted]","nested":{"secret":"[redacted]","value":1}}}',
  )
  expect(JSON.stringify(rows)).not.toContain('abc')
  expect(note.args).toBe('[{"from":"beta.worked"}]')
})

it('records failing service calls and passes the error through unchanged', async () => {
  const server = await start()
  expect(await server.extensions.invoke('alpha', 'fail', null, signal)).toEqual([true, true])
  const rows = server.extensions.trace.query().filter((row) => row.callee === 'beta')
  expect(rows.map(({ name, ok, error }) => ({ name, ok, error }))).toEqual([
    { name: 'beta.boom', ok: false, error: 'boom' },
    { name: 'beta.reject', ok: false, error: 'boom' },
  ])
  const action = server.extensions.trace.query().find((row) => row.name === 'alpha/fail')!
  expect(rows.every((row) => row.parent === action.id && row.trace === action.trace)).toBe(true)
  expect(action).toMatchObject({ ok: true, caller: 'ui', result: '[true,true]' })
})

it('records secrets actions without arguments or results', async () => {
  const server = await start()
  await server.extensions.invoke('secrets', 'set', { name: 'TRACE_TEST', value: 'hunter2' }, signal)
  expect(await server.extensions.invoke('secrets', 'list', null, signal)).toContainEqual(
    expect.objectContaining({ name: 'TRACE_TEST', set: true }),
  )
  const rows = server.extensions.trace.query().filter((row) => row.callee === 'secrets')
  expect(rows.map((row) => row.name)).toEqual(['secrets/set', 'secrets/list'])
  for (const row of rows) expect(row).not.toHaveProperty('args')
  for (const row of rows) expect(row).not.toHaveProperty('result')
  expect(JSON.stringify(server.extensions.trace.query())).not.toContain('hunter2')
})

it('links a tool call to its conversation and tool-call entry, with service calls as children', async () => {
  const server = await start()
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('probe', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ])
  await server.root.submit({ type: 'input', content: 'probe' }, context)
  await server.harness.waitForIdle(context)
  const view = await server.root.viewState(context)
  const assistant = view.value.entries.find(
    (entry) => entry.kind === 'pi.assistant' && JSON.stringify(entry.model).includes('"toolCall"'),
  )!
  view.dispose()
  const tool = server.extensions.trace.query().find((row) => row.kind === 'tool')!
  expect(tool).toMatchObject({
    caller: 'agent',
    callee: 'tooler',
    name: 'probe',
    ok: true,
    conversation: server.root.id,
    entry: assistant.id,
  })
  expect(tool.task).toEqual(expect.any(Number))
  expect(tool).not.toHaveProperty('args')
  expect(server.extensions.trace.query({ conversation: server.root.id })).toContainEqual(
    expect.objectContaining({
      name: 'delta.note',
      parent: tool.id,
      trace: tool.trace,
      entry: assistant.id,
    }),
  )
})

it('keeps the newest rows within the cap, drops old ones, and records nothing while closed', async () => {
  const file = join(await temp(), 'trace.sqlite')
  const trace = callTrace(file, { rows: 10, days: 7 })
  expect(trace.run(call('closed'), () => 42)).toBe(42)
  trace.open()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() - 8 * 864e5)
  trace.run(call('old'), () => 0)
  clock.mockRestore()
  for (const name of ['one', 'two', 'three', 'four']) trace.run(call(name), () => name)
  expect(trace.reader.query().map((row) => row.name)).toEqual([
    'old',
    'one',
    'two',
    'three',
    'four',
  ])
  trace.close()
  expect(trace.run(call('after close'), () => 'still runs')).toBe('still runs')
  expect(trace.reader.query()).toEqual([])
  // Reopening applies retention: first the age, then the row cap.
  trace.open()
  expect(trace.reader.query().map((row) => row.name)).toEqual(['one', 'two', 'three', 'four'])
  trace.close()
  const capped = callTrace(file, { rows: 3, days: 7 })
  capped.open()
  expect(capped.reader.query().map((row) => row.name)).toEqual(['two', 'three', 'four'])
  capped.close()
})

it('summarises values: secret keys redacted, long values cut, unserializable said so', () => {
  const text = summary({
    apiKey: 'k',
    auth: { password: 'p' },
    list: [{ accessToken: 't' }],
    long: 'x'.repeat(1000),
  })!
  expect(text).not.toMatch(/"[kpt]"/)
  expect(text).toContain('"apiKey":"[redacted]"')
  expect(text).toContain('"auth":"[redacted]"')
  expect(text).toContain('"accessToken":"[redacted]"')
  expect(text.length).toBeLessThanOrEqual(301)
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  expect(summary(cycle)).toBe('[unserializable]')
  expect(summary(undefined)).toBe(undefined)
})
