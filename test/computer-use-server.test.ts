import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ClassifyService, ClassifyResult } from '../extensions/classify/api.ts'
import type { Observation, Step } from '../extensions/computer-use/types.ts'
import { afterEach, expect, it, vi } from 'vitest'
import computerUse, { actions, act, userActions } from '../extensions/computer-use/server.ts'
import { readSession, updateSession } from '../extensions/computer-use/session.ts'
import { createDriver } from '../extensions/computer-use/driver.ts'
import { createFakeDriver } from './computer-use-fake-driver.ts'
import { fauxServer, removeTemp, temp } from './helpers.ts'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
  vi.useRealTimers()
})
async function fixture(classify?: ClassifyService) {
  const fake = createFakeDriver()
  const driver = await createDriver({
    expectedVersion: '0.37.0',
    connect: fake.connect,
    stopCommand: async () => {},
  })
  const resources = new Map<string, unknown>()
  const closes: (() => Promise<void>)[] = []
  const models = createModels()
  const faux = fauxProvider({ tokensPerSecond: 0 })
  models.setProvider(faux.provider)
  faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage('Acknowledged.')))
  const registry = createRegistry()
  let harness: Harness
  const home = await temp()
  const host = {
    userHome: home,
    projectSettings: async () => ({}),
    harness: () => harness,
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) {
        const value = create()
        if (key === 'computer-use.driver')
          Object.assign(value as object, { driver: Promise.resolve(driver) })
        resources.set(key, value)
      }
      return resources.get(key)
    },
    onClose: (close: () => Promise<void>) => closes.push(close),
    want: () => classify,
  } as unknown as ExtensionHost
  const extension = computerUse(host)
  registry.install(extension)
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  cleanup.push(async () => {
    await harness.close(context)
    for (const close of closes) await close()
    await removeTemp(home)
  })
  const ctx = { host } as ActionContext
  const tools = extension.tools as ToolRegistration[]
  let call = 0
  const invoke = async (name: string, args: Record<string, unknown>) =>
    tools
      .find((t) => t.name === name)!
      .execute(
        args,
        {
          conversationId: root.id,
          callId: String(++call),
          output: () => {},
        } as unknown as ToolExecutionApi,
        context,
      )
  const observe = async () => {
    const output = await invoke('computer_observe', {
      app: 'Calculator',
      window: 456,
      screenshot: 'never',
    })
    return output.structuredOutput as unknown as Observation
  }
  const grant = () =>
    actions.grant({ conversation: root.id, app: 'Calculator', scope: 'conversation' }, ctx)
  const run = (steps: Step[], foreground = false) =>
    act(
      host,
      driver,
      root.id,
      String(++call),
      { app: 'Calculator', window: 456, actions: steps, foreground },
      new AbortController().signal,
    )
  return { fake, driver, host, root, ctx, tools, invoke, observe, grant, run, resources }
}
const data = (output: { structuredOutput?: unknown }) =>
  output.structuredOutput as {
    status: string
    outcomes: { status: string }[]
    observation: Observation
    verdict: string
  }
function identityNext(
  fake: ReturnType<typeof createFakeDriver>,
  name = 'Calculator',
  bundle = 'com.apple.calculator',
) {
  fake.replyNext({
    content: [],
    structuredContent: { apps: [{ name, bundle_id: bundle, pid: 123 }] },
  })
}
it('loads when enabled, without creating a Driver', async () => {
  const home = await temp()
  await mkdir(`${home}/.ultimate`)
  await writeFile(
    `${home}/.ultimate/settings.json`,
    JSON.stringify({ extensions: { enable: ['computer-use'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: home,
    userHome: home,
    home: `${home}/state`,
  })
  cleanup.push(async () => {
    await server.close()
    await removeTemp(home)
  })
  const info = server.extensions.info().find((e) => e.name === 'computer-use')
  expect(info?.enabled).toBe(true)
  expect(info?.server?.error).toBeUndefined()
})
it('observe returns a bounded untrusted tree and is replay safe', async () => {
  const f = await fixture()
  const output = await f.invoke('computer_observe', {
    app: 'Calculator',
    window: 456,
    screenshot: 'never',
  })
  expect(f.tools.find((t) => t.name === 'computer_observe')?.replay).toBe('safe')
  expect(JSON.stringify(output.output)).toContain('untrusted_screen_content')
  expect(JSON.stringify(output.output)).toContain('AXButton Multiply')
})
it('refuses without consent without any Driver calls', async () => {
  const f = await fixture()
  expect(data(await f.run([{ kind: 'click', element: 's1:7' }])).status).toBe('consent_required')
  expect(f.fake.calls).toEqual([])
})
it('delivers 6 × 7 one step at a time and reads 42', async () => {
  const f = await fixture()
  await f.grant()
  await f.observe()
  const output = data(
    await f.run([7, 11, 8, 12].map((i) => ({ kind: 'click', element: `s1:${i}` }))),
  )
  expect(output.outcomes.map((o) => o.status)).toEqual(Array(4).fill('delivered'))
  expect(f.fake.display).toBe('42')
  expect(output.observation.tree).toContain('42')
  expect(f.fake.calls.filter((c) => c.tool === 'click')).toHaveLength(4)
  expect((await readSession(f.host, f.root.id)).journal.map((j) => j.status)).toEqual(
    Array(4).fill('delivered'),
  )
})
it('requires confirmation for an exact consequential action before dispatch', async () => {
  const f = await fixture()
  await f.grant()
  await f.observe()
  const step: Step = { kind: 'menu', path: ['File', 'Delete'] }
  identityNext(f.fake)
  f.fake.replyNext({ content: [], structuredContent: { windows: [{ pid: 999 }] } })
  expect(data(await f.run([step])).status).toBe('confirm_required')
  expect(f.fake.calls.some((c) => c.tool === 'invoke_menu')).toBe(false)
  const request = (await readSession(f.host, f.root.id)).pending[0]
  expect(request.window).toBe('Calculator')
  expect(request.label).toBe('File / Delete')
  const key = request.key!
  await actions.confirm({ conversation: f.root.id, key }, f.ctx)
  await f.observe()
  identityNext(f.fake)
  f.fake.replyNext({ content: [], structuredContent: { windows: [{ pid: 999 }] } })
  expect(data(await f.run([step])).outcomes[0].status).toBe('delivered')
})
it('refuses frontmost typing, and requires a user takeover plus foreground flag', async () => {
  const f = await fixture()
  await f.grant()
  await f.observe()
  const step: Step = { kind: 'type', element: 's1:1', text: 'private value' }
  const focus = () => {
    identityNext(f.fake)
    f.fake.replyNext({ content: [], structuredContent: { windows: [{ pid: 123 }] } })
  }
  focus()
  expect(data(await f.run([step], true)).status).toBe('user_active')
  expect(f.fake.calls.some((c) => c.tool === 'type_text')).toBe(false)
  await actions.takeover({ conversation: f.root.id, app: 'Calculator' }, f.ctx)
  // Post-act observation changed snapshot to s2.
  focus()
  expect(data(await f.run([{ ...step, element: 's2:1' }], true)).outcomes[0].status).toBe(
    'delivered',
  )
  expect(JSON.stringify((await readSession(f.host, f.root.id)).journal)).not.toContain(
    'private value',
  )
  await actions.stop({ conversation: f.root.id }, f.ctx)
  expect((await readSession(f.host, f.root.id)).takeovers).toEqual([])
})
it('remaps a stale token exactly once by role label and parent path', async () => {
  const f = await fixture()
  await f.grant()
  await f.observe()
  identityNext(f.fake)
  f.fake.refuseNext('stale_element_token', 'Observe again')
  expect(data(await f.run([{ kind: 'click', element: 's1:7' }])).outcomes[0].status).toBe(
    'delivered',
  )
  expect(f.fake.calls.filter((c) => c.tool === 'click').map((c) => c.args.element_token)).toEqual([
    's1:7',
    's2:7',
  ])
})
it('requires a fresh observe after a crash left a sending journal entry', async () => {
  const f = await fixture()
  await f.grant()
  await updateSession(f.host, f.root.id, (doc) => {
    doc.journal.push({
      call: 'interrupted',
      step: 0,
      kind: 'click',
      app: 'Calculator',
      status: 'sending',
      at: Date.now(),
    })
  })
  expect(data(await f.run([{ kind: 'click', element: 's1:7' }])).status).toBe('observe_first')
  expect(f.fake.calls).toEqual([])
  await f.observe()
  expect(data(await f.run([{ kind: 'click', element: 's1:7' }])).status).toBe('delivered')
})
it('stops between steps, leaving subsequent steps not_run', async () => {
  const f = await fixture()
  await f.grant()
  await f.observe()
  identityNext(f.fake)
  f.fake.replyNext(async () => {
    await actions.stop({ conversation: f.root.id }, f.ctx)
    return { content: [], structuredContent: { status: 'ok' } }
  })
  const output = data(await f.run([1, 2, 3].map((i) => ({ kind: 'click', element: `s1:${i}` }))))
  expect(output.outcomes.map((o) => o.status)).toEqual(['delivered', 'not_run', 'not_run'])
  expect(f.fake.calls.filter((c) => c.tool === 'click')).toHaveLength(1)
})
it('runs a routine goal through fake classify and journals Jev decisions', async () => {
  let picks = 0
  const classify: ClassifyService = {
    ask: async (request): Promise<ClassifyResult> => {
      if (!request.questions.next)
        return {
          model: 'fake',
          usage: { inputTokens: 1 },
          answers: { risk: { type: 'noul', noul: 0 } },
        }
      const id = Object.keys(
        (request.questions.next as { criteria: Record<string, string> }).criteria,
      ).find((k) => k.includes('"6"'))!
      picks++
      return {
        model: 'fake',
        usage: { inputTokens: 1 },
        answers: {
          next: { type: 'choice', choice: id, confidence: 1, probabilities: { [id]: 1 } },
          done: { type: 'noul', noul: picks > 1 ? 1 : 0 },
          risk: { type: 'noul', noul: 0 },
        },
      }
    },
  }
  const f = await fixture(classify)
  await f.grant()
  await f.observe()
  // Fake verify_state compares args.value; undefined deliberately produces unsatisfied.
  // Script its verified-done reply without changing the fake Driver's contract.
  const call = f.driver.call.bind(f.driver)
  f.driver.call = async (tool, args, signal) =>
    tool === 'verify_state'
      ? { ok: true, text: 'satisfied', structured: { status: 'satisfied' }, images: [] }
      : call(tool, args, signal)
  const output = await act(
    f.host,
    f.driver,
    f.root.id,
    'goal',
    {
      app: 'Calculator',
      window: 456,
      goal: {
        text: 'Press 6',
        done_when: [{ element: { selector: { role: 'AXStaticText' }, value_equals: '6' } }],
      },
    },
    new AbortController().signal,
  )
  expect(data(output).status).toBe('done')
  expect(f.fake.display).toBe('6')
  expect((await readSession(f.host, f.root.id)).journal.some((j) => j.kind === 'jev')).toBe(true)
})
it('lists all authority-changing actions as user-only', () => {
  expect(userActions).toEqual(
    expect.arrayContaining([
      'grant',
      'deny',
      'confirm',
      'stop',
      'hardStop',
      'resume',
      'takeover',
      'release',
    ]),
  )
  expect(userActions).not.toContain('state')
})

it('returns a structured locked-screen observation instead of parsing a missing snapshot', async () => {
  const f = await fixture()
  f.fake.replyNext({ content: [], structuredContent: { windows: [{ pid: 123, window_id: 456 }] } })
  f.fake.replyNext({
    content: [],
    structuredContent: {
      degraded: true,
      degraded_reason: 'screen_locked: wake and unlock',
      elements: [],
    },
  })
  expect(data(await f.invoke('computer_observe', { app: 'Calculator', window: 456 })).status).toBe(
    'screen_locked',
  )
})

it('kills the daemon if a stopped step remains in flight for one second', async () => {
  const f = await fixture()
  await f.grant()
  await f.observe()
  vi.useFakeTimers()
  const sent = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const killed = vi.spyOn(f.driver, 'stop').mockResolvedValue()
  identityNext(f.fake)
  f.fake.replyNext(async () => {
    sent.resolve()
    await finish.promise
    return { content: [], structuredContent: { status: 'ok' } }
  })
  const running = f.run([
    { kind: 'click', element: 's1:7' },
    { kind: 'click', element: 's1:8' },
  ])
  await sent.promise
  await actions.stop({ conversation: f.root.id }, f.ctx)
  await vi.advanceTimersByTimeAsync(1000)
  expect(killed).toHaveBeenCalledOnce()
  finish.resolve()
  expect(data(await running).outcomes.map((o) => o.status)).toEqual(['delivered', 'not_run'])
})

it('reserves the Driver before asynchronous consent checks so concurrent acts cannot dispatch', async () => {
  const f = await fixture()
  await f.grant()
  await f.observe()
  const sent = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  identityNext(f.fake)
  f.fake.replyNext(async () => {
    sent.resolve()
    await finish.promise
    return { content: [], structuredContent: { status: 'ok' } }
  })
  const first = f.run([{ kind: 'click', element: 's1:7' }])
  const second = f.run([{ kind: 'click', element: 's1:8' }])
  await sent.promise
  try {
    expect(data(await second).status).toBe('busy')
  } finally {
    finish.resolve()
    await first
  }
})

it('does not let a non-canonical app grant bypass the Terminal deny list', async () => {
  const f = await fixture()
  await actions.grant({ conversation: f.root.id, app: 'Term', scope: 'conversation' }, f.ctx)
  await f.invoke('computer_observe', { app: 'Term', window: 456, screenshot: 'never' })
  identityNext(f.fake, 'Terminal', 'com.apple.Terminal')
  const output = await f.invoke('computer_act', {
    app: 'Term',
    window: 456,
    actions: [{ kind: 'click', element: 's1:7' }],
  })
  expect(data(output).status).toBe('app_identity')
  expect(JSON.stringify(output.output)).toContain('Terminal')
  expect(JSON.stringify(output.output)).toContain('com.apple.Terminal')
  expect(f.fake.calls.some((c) => c.tool === 'click')).toBe(false)
})
