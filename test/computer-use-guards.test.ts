import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import { resizeImage } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { Observation, Step } from '../extensions/computer-use/types.ts'
import type { Region } from '../extensions/computer-use/perception.ts'
import computerUse, { actions } from '../extensions/computer-use/server.ts'
import { readSession } from '../extensions/computer-use/session.ts'
import { createDriver } from '../extensions/computer-use/driver.ts'
import { runtime } from '../extensions/computer-use/runtime.ts'
import { Profile } from '../extensions/subagents/api.ts'
import { createFakeDriver } from './computer-use-fake-driver.ts'
import { removeTemp, temp } from './helpers.ts'

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()
  return { ...actual, resizeImage: vi.fn<typeof actual.resizeImage>(actual.resizeImage) }
})
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

/** A computer-operator root with no task and no grant; `settings.guards` is the project's `computerUse.guards`. */
async function fixture(guards?: boolean) {
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
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage('Acknowledged.')))
  const registry = createRegistry()
  let harness: Harness
  const home = await temp()
  const settings = { guards }
  const ids: number[] = []
  const host = {
    userHome: home,
    home,
    projectSettings: async () =>
      settings.guards === undefined ? {} : { computerUse: { guards: settings.guards } },
    harness: () => harness,
    conversations: () => ids.map((id) => ({ id })),
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
    onOpen: () => {},
    onRelease: () => {},
    want: () => undefined,
  } as unknown as ExtensionHost
  const extension = computerUse(host)
  registry.install(extension)
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  ids.push(root.id)
  await harness.commit(async (tx) => {
    ;(await tx.doc(Profile, root.id)).definition = 'computer-operator'
  }, context)
  await root.submit({ type: 'input', content: 'Use Calculator' }, context)
  await harness.waitForIdle(context)
  cleanup.push(async () => {
    await harness.close(context)
    for (const close of closes) await close()
    await removeTemp(home)
  })
  let now = 0
  runtime(host).clock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  }
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
          agent: (callContext: typeof context) => root.agent(callContext),
        } as unknown as ToolExecutionApi,
        context,
      )
  const observe = async () =>
    (await invoke('computer_observe', { app: 'Calculator', window: 456, screenshot: 'never' }))
      .structuredOutput as unknown as Observation
  const act = async (steps: Step[]) =>
    data(await invoke('computer_act', { app: 'Calculator', window: 456, actions: steps }))
  const start = (id: string) =>
    invoke('computer_task', {
      action: 'start',
      spec: {
        id,
        intent: 'Use Calculator',
        goal: 'Use Calculator',
        // Evidence-only and consequential: both ask the user to confirm the task while guards are on.
        criteria: [{ id: 'C1', text: 'Calculator used', check: 'evidence' }],
        scope: { apps: ['Calculator'], params: {}, actions: ['click'], consequential: ['Delete'] },
      },
    })
  return {
    fake,
    driver,
    host,
    root,
    settings,
    invoke,
    observe,
    act,
    start,
    ctx: { host } as ActionContext,
  }
}
const data = (output: { structuredOutput?: unknown }) =>
  output.structuredOutput as { status: string; outcomes: { status: string; code?: string }[] }
const textRegion = (label: string): Region => ({
  id: 'r1',
  kind: 'text',
  label,
  confidence: 0.65,
  bounds: { x: 100, y: 80, width: 90, height: 20 },
  interactive: true,
})
/** A degraded window whose capture shows one OCR text region. */
async function degraded(f: Awaited<ReturnType<typeof fixture>>, label: string) {
  vi.mocked(resizeImage).mockResolvedValue(null)
  f.fake.surface.degraded = true
  f.fake.surface.regions = [textRegion(label)]
  return f.observe()
}

it('guards off: observes, clicks, types and presses Return with no task and no grant', async () => {
  const f = await fixture(false)
  const view = await f.observe()
  expect(view.snapshot).toBeDefined()
  const result = await f.act([
    { kind: 'click', element: `${view.snapshot}:1` },
    { kind: 'type', element: `${view.snapshot}:11`, text: 'hello' },
    { kind: 'key', key: 'Return' },
  ])
  expect(result.outcomes.map((o) => o.status)).toEqual(['delivered', 'delivered', 'delivered'])
  expect(f.fake.calls.map((c) => c.tool)).toEqual(
    expect.arrayContaining(['click', 'type_text', 'press_key']),
  )
  const session = await readSession(f.host, f.root.id)
  expect(session.task).toBeUndefined()
  expect(session.pending).toEqual([])
})

it('guards off: delivers a degraded pixel click without expect_label or a takeover', async () => {
  const f = await fixture(false)
  const view = await degraded(f, 'Continue')
  const result = await f.act([{ kind: 'click', x: 120, y: 90, capture: view.capture!.id }])
  expect(result.status).toBe('delivered')
  expect(f.fake.calls.find((c) => c.tool === 'click')?.args).toMatchObject({ x: 120, y: 90 })
})

it('guards off: clicks a consequential "Delete" label with no confirmation', async () => {
  const f = await fixture(false)
  const view = await degraded(f, 'Delete')
  const result = await f.act([{ kind: 'click', capture: view.capture!.id, expect_label: 'Delete' }])
  expect(result.status).toBe('delivered')
  // The label-only click still resolves the OCR region's centre.
  expect(f.fake.calls.find((c) => c.tool === 'click')?.args).toMatchObject({ x: 145, y: 90 })
  expect((await readSession(f.host, f.root.id)).pending).toEqual([])
})

it('guards off: a task awaiting a change confirmation blocks neither act nor a new task', async () => {
  const f = await fixture()
  await f.start('T1')
  await actions.confirmTask({ conversation: f.root.id }, f.ctx)
  await f.invoke('computer_task', {
    action: 'replan',
    reason: 'Need Terminal too',
    scope: { apps: ['Calculator', 'Terminal'], params: {}, actions: ['click'], consequential: [] },
  })
  const paused = await readSession(f.host, f.root.id)
  expect(paused.task?.status).toBe('awaiting_confirmation')
  expect(paused.task?.pendingChange).toBeDefined()
  f.settings.guards = false
  const view = await f.observe()
  expect((await f.act([{ kind: 'click', element: `${view.snapshot}:1` }])).status).toBe('delivered')
  expect(data(await f.start('T2')).status).toBe('active')
  const session = await readSession(f.host, f.root.id)
  expect(session.task).toMatchObject({ spec: { id: 'T2' }, status: 'active' })
  expect(session.pending.filter((p) => p.kind !== 'consent')).toEqual([])
})

it('guards off: stop still refuses act', async () => {
  const f = await fixture(false)
  const view = await f.observe()
  await actions.stop({ conversation: f.root.id }, f.ctx)
  expect((await f.act([{ kind: 'click', element: `${view.snapshot}:1` }])).status).toBe('stopped')
  expect(f.fake.calls.some((c) => c.tool === 'click')).toBe(false)
})

it('guards off: a secure-field value never reaches the journal or the output', async () => {
  const f = await fixture(false)
  // Element 1 becomes a PIN field; like macOS, the app never echoes what is typed into it.
  const call = f.driver.call.bind(f.driver)
  f.driver.call = async (tool, args, signal) => {
    const reply = await call(tool, args, signal)
    if (tool === 'get_window_state') {
      const elements = reply.structured!.elements as unknown as Record<string, unknown>[]
      Object.assign(
        elements.find((e) => e.element_index === 1)!,
        {
          role: 'AXSecureTextField',
          label: 'PIN',
        },
      )
    }
    return reply
  }
  f.fake.replyFor('type_text', { content: [], structuredContent: { status: 'ok' } })
  const view = await f.observe()
  const secret = 'private-code'
  const result = await f.invoke('computer_act', {
    app: 'Calculator',
    window: 456,
    actions: [{ kind: 'type', element: `${view.snapshot}:1`, text: secret }],
  })
  expect(data(result).status).toBe('delivered')
  expect(f.fake.calls.find((c) => c.tool === 'type_text')?.args.text).toBe(secret)
  const session = await readSession(f.host, f.root.id)
  expect(session.journal.at(-1)).toMatchObject({
    kind: 'type',
    role: 'AXSecureTextField',
    length: secret.length,
  })
  expect(JSON.stringify(session)).not.toContain(secret)
  expect(JSON.stringify(result.output)).not.toContain(secret)
  expect(JSON.stringify(result.details)).not.toContain(secret)
})

it('guards on by default: refuses act without consent and starts a task awaiting confirmation', async () => {
  const f = await fixture()
  expect(data(await f.start('T1')).status).toBe('awaiting_confirmation')
  await actions.confirmTask({ conversation: f.root.id }, f.ctx)
  const view = await f.observe()
  expect((await f.act([{ kind: 'click', element: `${view.snapshot}:1` }])).status).toBe(
    'consent_required',
  )
  expect(f.fake.calls.some((c) => c.tool === 'click')).toBe(false)
})
