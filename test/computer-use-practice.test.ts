import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import type {
  Approval,
  TaskSpec,
  Step,
  Element,
  Observation,
} from '../extensions/computer-use/types.ts'
import type { Region } from '../extensions/computer-use/perception.ts'
import type { Teach, TaughtStep } from '../extensions/computer-use/refs.ts'
import computerUse, { actions } from '../extensions/computer-use/server.ts'
import { createDriver } from '../extensions/computer-use/driver.ts'
import { runtime } from '../extensions/computer-use/runtime.ts'
import { readSession, updateSession, wake } from '../extensions/computer-use/session.ts'
import {
  editTeaching,
  readTeach,
  saveTeaching,
  updateTeach,
} from '../extensions/computer-use/teach.ts'
import { beforePractice } from '../extensions/computer-use/practice.ts'
import { Profile } from '../extensions/subagents/api.ts'
import { saveEvidence } from '../extensions/computer-use/evidence-files.ts'
import * as task from '../extensions/computer-use/task.ts'
import { dispatchGates } from '../extensions/computer-use/gates.ts'
import type { GateContext } from '../extensions/computer-use/gates.ts'
import { createFakeDriver } from './computer-use-fake-driver.ts'
import { temp, removeTemp } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
const region = (label: string, x = 0, y = 0): Region => ({
  id: `${label}-${x}`,
  kind: 'text',
  label,
  confidence: 0.9,
  interactive: true,
  bounds: { x, y, width: 80, height: 20 },
})
const approval = (): Approval => ({
  app: 'com.apple.calculator',
  window: 456,
  pixel: true,
  actions: ['click'],
  steps: 10,
  minutes: 15,
  foreground: true,
})
const lessonStep = (n = 1): TaughtStep => ({
  n,
  action: 'click',
  target: { label: n === 1 ? 'Start' : 'Next', anchors: n === 1 ? ['Skills'] : [] },
  expect: { appears: [n === 1 ? 'Dialog' : 'Done'], timeoutSeconds: 0.001 },
  frame: 'f1',
  approved: true,
})
async function fixture() {
  const home = await temp()
  const fake = createFakeDriver()
  fake.surface.degraded = true
  fake.surface.regions = [region('Archive')]
  const driver = await createDriver({
    expectedVersion: '0.37.0',
    connect: fake.connect,
    stopCommand: async () => {},
  })
  const resources = new Map<string, unknown>(),
    closes: (() => Promise<void>)[] = []
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 0 })
  models.setProvider(faux.provider)
  faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage('Noted')))
  const registry = createRegistry()
  let harness: Harness
  const conversations: { id: number; parentConversationId?: number }[] = []
  let trusted: boolean | undefined = true
  const host = {
    home,
    userHome: home,
    projectRoot: home,
    projectSettings: async () => ({}),
    projectSetup: async () => ({ decision: trusted }),
    harness: () => harness,
    conversations: () => conversations,
    want: () => undefined,
    onClose: (fn: () => Promise<void>) => closes.push(fn),
    onRelease: () => {},
    onOpen: () => {},
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
  } as unknown as ExtensionHost
  const extension = computerUse(host)
  registry.install(extension)
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  conversations.push({ id: root.id })
  await harness.commit(async (tx) => {
    ;(await tx.doc(Profile, root.id)).definition = 'computer-operator'
  }, context)
  runtime(host).driver = Promise.resolve(driver)
  let now = 1000
  runtime(host).clock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  }
  const ctx = { host } as ActionContext
  let calls = 0
  const invoke = (name: string, args: Record<string, unknown>) =>
    (extension.tools as ToolRegistration[])
      .find((t) => t.name === name)!
      .execute(
        args,
        {
          conversationId: root.id,
          callId: String(++calls),
          output: () => {},
          agent: () => root.agent(context),
        } as unknown as ToolExecutionApi,
        context,
      )
  const say = async (content: string) => {
    await root.submit({ type: 'input', content }, context)
    await harness.waitForIdle(context)
  }
  await say('Use Calculator')
  await updateSession(host, root.id, (doc) => {
    doc.grants.push({ app: 'Calculator', scope: 'conversation', at: 0 })
  })
  const confirm = async () => {
    await actions.confirmTask({ conversation: root.id }, ctx)
    await harness.waitForIdle(context)
  }
  const start = async (override: Partial<Omit<TaskSpec, 'stop'>> = {}) =>
    invoke('computer_task', {
      action: 'start',
      spec: {
        id: 'task',
        intent: 'Use Calculator',
        goal: 'Use Calculator',
        criteria: [
          { id: 'C', text: 'Archive visible', check: [{ ocr: { appears: ['Archive'] } }] },
        ],
        scope: {
          apps: ['Calculator'],
          actions: ['click', 'right_click'],
          params: {},
          consequential: [],
        },
        approval: approval(),
        ...override,
      },
    })
  const click = async (label = 'Archive', kind = 'click') => {
    const observed = await invoke('computer_observe', {
      app: 'Calculator',
      window: 456,
      screenshot: 'always',
    })
    const capture = (observed.structuredOutput as unknown as { capture: { id: string } }).capture.id
    return invoke('computer_act', {
      app: 'Calculator',
      window: 456,
      foreground: true,
      actions: [{ kind, x: 10, y: 10, capture, expect_label: label }],
    })
  }
  const save = async (
    steps: TaughtStep[] = [lessonStep()],
    title = 'Upload lesson',
    change?: (segment: NonNullable<Teach['segment']>) => void,
  ) => {
    const file = await saveEvidence(
      home,
      root.id,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSP8AAAAASUVORK5CYII=',
        'base64',
      ),
      'lesson',
    )
    await updateTeach(host, root.id, (doc) => {
      doc.segment = {
        id: 'lesson',
        app: 'Calculator',
        bundle: 'com.apple.calculator',
        window: 456,
        windowTitle: 'Calculator',
        title,
        startedAt: 0,
        endsAt: 100,
        status: 'drafting',
        frames: [
          {
            id: 'f1',
            at: 1,
            width: 800,
            height: 200,
            file,
            ocr: [],
            diff: { appeared: [], disappeared: [] },
            inferred: 'Lesson',
          },
        ],
        narration: [],
        dropped: [],
      }
      change?.(doc.segment)
    })
    await editTeaching(host, root.id, steps)
    return saveTeaching(host, { conversation: root.id, scope: 'project', name: 'lesson' })
  }
  const practice = () =>
    invoke('computer_teach', { action: 'practice', skill: 'lesson', scope: 'project' })
  const check = async (step: number, phase: 'before' | 'after', labels: Region[]) => {
    now += 10
    fake.surface.regions = labels
    return invoke('computer_teach', { action: 'check', step, phase })
  }
  const finish = (outcome = 'done') =>
    invoke('computer_task', { action: 'finish', outcome, summary: 'Practice result' })
  const addConversation = async (parentConversationId?: number) => {
    const child = await harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
      },
      context,
    )
    conversations.push({
      id: child.id,
      ...(parentConversationId === undefined ? {} : { parentConversationId }),
    })
    return child
  }
  cleanup.push(async () => {
    for (const close of closes.toReversed()) await close()
    await harness.close(context)
    await removeTemp(home)
  })
  return {
    host,
    home,
    fake,
    root,
    ctx,
    invoke,
    say,
    start,
    confirm,
    click,
    save,
    practice,
    check,
    finish,
    addConversation,
    trust: (decision: boolean | undefined) => {
      trusted = decision
    },
  }
}
const data = (value: { structuredOutput?: unknown }) =>
  value.structuredOutput as {
    status: string
    outcomes: { status: string; code?: string }[]
    spec: TaskSpec
    plan: { action: string; value: { param: string } }[]
  }

it('always confirms scoped approval, uses its budgets, and confirms widening on replan', async () => {
  const f = await fixture()
  expect(data(await f.start()).status).toBe('awaiting_confirmation')
  expect((await readSession(f.host, f.root.id)).task?.runTakeover).not.toBe(true)
  await f.confirm()
  const state = (await readSession(f.host, f.root.id)).task!
  expect(state.spec.stop).toMatchObject({ steps: 10, minutes: 15 })
  const changed = task.replan(
    state,
    { reason: 'More steps', approval: { ...approval(), steps: 20 } },
    Date.now(),
  )
  expect(changed.status).toBe('awaiting_confirmation')
  expect(task.confirmChange(changed).spec.stop.steps).toBe(20)
  expect(() =>
    task.startTask({ ...state.spec, approval: { ...approval(), steps: 201 } }, 0),
  ).toThrow('Invalid task approval')
})
it('delivers a benign in-scope pixel click with run takeover and no per-click card', async () => {
  const f = await fixture()
  f.fake.frontmostPid = 123
  await f.start()
  await f.confirm()
  const clicked = await f.click()
  expect(data(clicked).outcomes[0].status).toBe('delivered')
  const session = await readSession(f.host, f.root.id)
  expect(session.takeovers).toEqual([])
  expect(session.pending.some((p) => p.kind === 'confirm')).toBe(false)
  expect(clicked.details).toMatchObject({
    task: {
      approval: {
        app: { text: 'com.apple.calculator', untrusted: true },
        takeover: true,
        steps: 10,
      },
    },
  })
})
it.each(['app', 'window', 'kind'] as const)(
  'falls back to normal gates outside the approved %s',
  async (outside) => {
    const f = await fixture()
    f.fake.frontmostPid = 123
    const a = {
      ...approval(),
      ...(outside === 'app' ? { app: 'Other' } : outside === 'window' ? { window: 999 } : {}),
    }
    await f.start({ approval: a })
    await f.confirm()
    const clicked = await f.click('Archive', outside === 'kind' ? 'right_click' : 'click')
    expect(data(clicked).outcomes[0]).toMatchObject({ status: 'refused', code: 'user_active' })
    expect(f.fake.calls.some((c) => c.tool === 'click')).toBe(false)
  },
)
it('honors an existing manual takeover outside the run approval', async () => {
  const f = await fixture()
  f.fake.frontmostPid = 123
  await f.start({ approval: { ...approval(), window: 999 } })
  await f.confirm()
  await updateSession(f.host, f.root.id, (doc) => {
    doc.takeovers.push({ app: 'Calculator', at: Date.now() })
  })
  expect(data(await f.click()).outcomes[0].status).toBe('delivered')
})
it.each([
  { labels: [], allowed: false },
  { labels: ['Upload skill now'], allowed: false },
  { labels: ['UPLOAD SKILL'], allowed: true },
])('requires exact whole effective-label pre-approval: $labels', async ({ labels, allowed }) => {
  const f = await fixture()
  f.fake.frontmostPid = 123
  f.fake.surface.regions = [region('Upload skill')]
  await f.start({
    scope: { apps: ['Calculator'], actions: ['click'], params: {}, consequential: labels },
  })
  await f.confirm()
  const clicked = await f.click('Upload skill')
  expect(data(clicked).outcomes[0]).toMatchObject(
    allowed ? { status: 'delivered' } : { status: 'refused', code: 'confirm_required' },
  )
})
it('releases run takeover on own input and Stop, but not on synthetic wakes', async () => {
  const f = await fixture()
  await f.start()
  await f.confirm()
  await wake(f.host, f.root.id, 'Synthetic continuation')
  await f.host.harness().waitForIdle(context)
  expect((await readSession(f.host, f.root.id)).task?.runTakeover).toBe(true)
  await f.say('I am using the window now')
  expect((await readSession(f.host, f.root.id)).task?.runTakeover).toBe(false)
  await updateSession(f.host, f.root.id, (doc) => {
    doc.task!.runTakeover = true
  })
  await actions.stop({ conversation: f.root.id }, f.ctx)
  expect((await readSession(f.host, f.root.id)).task?.runTakeover).toBe(false)
})
it('releases run takeover when the task finishes', async () => {
  const f = await fixture()
  await f.start()
  await f.confirm()
  expect(data(await f.finish()).status).toBe('done')
  expect((await readSession(f.host, f.root.id)).task?.runTakeover).toBe(false)
})
it('requires a saved manifest, safe files, matching hash, and grounded practice intent', async () => {
  const f = await fixture()
  expect(data(await f.practice()).status).toBe('resave_required')
  expect(
    data(
      await f.invoke('computer_teach', {
        action: 'practice',
        skill: '../escape',
        scope: 'project',
      }),
    ).status,
  ).toBe('resave_required')
  const saved = await f.save()
  expect(data(await f.practice()).status).toBe('intent_required')
  await f.say('Upload lesson')
  const manifest = await readFile(join(saved.path, 'teach.json'), 'utf8')
  await rm(join(saved.path, 'teach.json'))
  expect(data(await f.practice()).status).toBe('resave_required')
  await writeFile(join(saved.path, 'teach.json'), manifest)
  const procedure = await readFile(join(saved.path, 'procedure.json'), 'utf8')
  await writeFile(join(saved.path, 'procedure.json'), procedure + ' ')
  expect(data(await f.practice()).status).toBe('resave_required')
  await writeFile(join(saved.path, 'procedure.json'), procedure)
  await rm(join(saved.path, 'SKILL.md'))
  await symlink(join(saved.path, 'procedure.json'), join(saved.path, 'SKILL.md'))
  expect(data(await f.practice()).status).toBe('resave_required')
  expect(f.fake.calls.some((c) => ['click', 'type_text', 'launch_app'].includes(c.tool))).toBe(
    false,
  )
})
it('builds the practice task and plan, maps upload/select to click, and refuses secret typing', async () => {
  const f = await fixture()
  await f.save([
    { ...lessonStep(), action: 'upload' },
    { ...lessonStep(2), action: 'select' },
  ])
  await f.say('Upload lesson')
  const built = await f.practice()
  expect(data(built)).toMatchObject({
    status: 'awaiting_confirmation',
    spec: {
      intent: 'Upload lesson',
      approval: {
        pixel: true,
        steps: 4,
        minutes: 15,
        foreground: true,
        actions: ['click'],
        window: 'Calculator',
      },
    },
    plan: [{ action: 'click' }, { action: 'click' }],
  })
  expect(data(built).spec.criteria).toHaveLength(2)
  expect((await readSession(f.host, f.root.id)).task?.practiceRun).toBe(data(built).spec.id)
  const other = await fixture()
  await other.save([{ ...lessonStep(), action: 'type_secret', value: { param: 'credential' } }])
  expect(data(await other.practice()).status).toBe('unsupported_until_secrets')
})
it('requires parameter values from user input and keeps them out of results, details and journal', async () => {
  const f = await fixture()
  await f.save([{ ...lessonStep(), action: 'type', value: { param: 'file' } }])
  await f.say('Upload lesson\nUse file /tmp/example.txt')
  expect(data(await f.practice()).status).toBe('param_required')
  expect(
    data(
      await f.invoke('computer_teach', {
        action: 'practice',
        skill: 'lesson',
        scope: 'project',
        params: { file: 'not-from-user' },
      }),
    ).status,
  ).toBe('param_provenance')
  expect(
    data(
      await f.invoke('computer_teach', {
        action: 'practice',
        skill: 'lesson',
        scope: 'project',
        params: { file: '/tmp/example.txt\n' },
      }),
    ).status,
  ).toBe('param_provenance')
  const built = await f.invoke('computer_teach', {
    action: 'practice',
    skill: 'lesson',
    scope: 'project',
    params: { file: '/tmp/example.txt' },
  })
  expect(data(built).status).toBe('awaiting_confirmation')
  expect(JSON.stringify(built)).not.toContain('/tmp/example.txt')
  expect(JSON.stringify((await readSession(f.host, f.root.id)).journal)).not.toContain(
    '/tmp/example.txt',
  )
})
it.each([
  { name: 'pass', regions: [region('Start'), region('Skills', 100)], passed: true },
  {
    name: 'ambiguous target',
    regions: [region('Start'), region('Start', 300), region('Skills', 100)],
    passed: false,
  },
  { name: 'far anchor', regions: [region('Start'), region('Skills', 700)], passed: false },
  {
    name: 'repeated anchor with close copy',
    regions: [region('Start'), region('Skills', 100), region('Skills', 700)],
    passed: true,
  },
])('before-check geometry: $name', ({ regions, passed }) => {
  expect(
    beforePractice(
      lessonStep(),
      regions,
      { width: 800, height: 200 },
      { id: 'f1', width: 800, height: 200 },
      0.5,
    ),
  ).toBe(passed)
})
it('scales taught regions into fresh screenshot pixels', () => {
  const step = {
    ...lessonStep(),
    target: {
      label: 'Start',
      anchors: ['Skills'],
      region: [0, 0, 200, 100] as [number, number, number, number],
    },
  }
  expect(
    beforePractice(
      step,
      [region('Start', 100, 40), region('Skills', 300, 40)],
      { width: 1600, height: 400 },
      { id: 'f1', width: 800, height: 200 },
      0.5,
    ),
  ).toBe(true)
  expect(
    beforePractice(
      step,
      [region('Start', 100, 40), region('Skills', 600, 40)],
      { width: 1600, height: 400 },
      { id: 'f1', width: 800, height: 200 },
      0.5,
    ),
  ).toBe(false)
})
async function ready(steps = [lessonStep()]) {
  const f = await fixture()
  await f.save(steps)
  await f.say('Upload lesson')
  await f.practice()
  await f.confirm()
  return f
}
async function sequential(f: Awaited<ReturnType<typeof fixture>>) {
  expect(data(await f.check(1, 'before', [region('Start'), region('Skills', 100)])).status).toBe(
    'satisfied',
  )
  expect(data(await f.check(1, 'after', [region('Dialog')])).status).toBe('satisfied')
  expect(data(await f.check(2, 'before', [region('Next')])).status).toBe('satisfied')
  expect(data(await f.check(2, 'after', [region('Done')])).status).toBe('satisfied')
}
it('checks fresh before/after captures without input and finishes a sequential lesson from ordered proofs plus a live final check', async () => {
  const f = await ready([lessonStep(), lessonStep(2)])
  await sequential(f)
  const checks = (await readTeach(f.host, f.root.id)).practice!.checks
  expect(checks).toHaveLength(4)
  expect(checks[1]).toMatchObject({
    predicates: [{ ocr: { appears: ['Dialog'] } }],
    capture: expect.any(String),
    at: expect.any(Number),
  })
  expect(checks[1].at).toBeGreaterThan(checks[0].at)
  const before = f.fake.calls.filter((c) => c.tool === 'get_window_state').length
  expect(data(await f.finish()).status).toBe('done')
  expect(f.fake.calls.filter((c) => c.tool === 'get_window_state')).toHaveLength(before + 1)
  expect((await readTeach(f.host, f.root.id)).practice?.final?.capture).toBeTruthy()
  expect(
    f.fake.calls.every((c) =>
      ['list_apps', 'list_windows', 'get_window_state', 'parse_visual_regions'].includes(c.tool),
    ),
  ).toBe(true)
})
it('practices a lesson over windows of two apps, capturing each step’s window by its title fragment', async () => {
  const f = await fixture()
  f.fake.windows = [
    { window_id: 456, title: 'Calculator', app_name: 'Calculator', pid: 123 },
    { window_id: 457, title: 'Paper Tape', app_name: 'Calculator', pid: 123 },
    {
      window_id: 7,
      title: 'OpsMate \u2014 Microsoft\u200B Edge',
      app_name: 'Citrix Viewer',
      pid: 29200,
    },
  ]
  await f.save([lessonStep(), { ...lessonStep(2), frame: 'f2' }], 'Upload lesson', (segment) => {
    segment.windows = [
      { app: 'Calculator', bundle: 'com.apple.calculator', window: 456, windowTitle: 'Calculator' },
      { app: 'Calculator', bundle: 'com.apple.calculator', window: 457, windowTitle: 'Tape' },
      { app: 'Citrix Viewer', window: 7, windowTitle: 'Microsoft Edge' },
    ]
    segment.frames.push({ ...segment.frames[0], id: 'f2', window: 2 })
  })
  await f.say('Upload lesson')
  const { spec } = data(await f.practice())
  expect(spec.scope.apps).toEqual(['Calculator', 'Citrix Viewer'])
  // Two windows of the approved app: the run approval binds no single window.
  expect(spec.approval).not.toHaveProperty('window')
  await f.confirm()
  expect((await readTeach(f.host, f.root.id)).practice?.windows).toHaveLength(3)
  await sequential(f)
  const captured = f.fake.calls
    .filter((c) => c.tool === 'get_window_state')
    .map((c) => [c.args.pid, c.args.window_id])
  expect(captured).toEqual([
    [123, 456],
    [123, 456],
    [29200, 7],
    [29200, 7],
  ])
  expect(data(await f.finish()).status).toBe('done')
})
it('records redacted mismatch frames and blocks done but allows partial', async () => {
  const f = await ready()
  await updateSession(f.host, f.root.id, (doc) => {
    doc.task!.spec.scope.params = { private: 'private-value' }
  })
  await f.check(1, 'before', [region('Start'), region('Skills', 100)])
  const mismatch = await f.check(1, 'after', [region('Not Dialog'), region('private-value', 100)])
  expect(data(mismatch).status).toBe('mismatch')
  const doc = await readTeach(f.host, f.root.id)
  expect(doc.practice?.status).toBe('mismatch')
  expect(doc.mismatches![0].taught.file).toBeTruthy()
  expect(doc.mismatches![0].fresh.file).toBeTruthy()
  expect(JSON.stringify(mismatch.details)).not.toContain('private-value')
  expect(mismatch.details).toMatchObject({
    teach: {
      mismatches: [
        {
          expected: [{ untrusted: true }],
          seen: expect.arrayContaining([
            { text: '[param]', untrusted: true },
            { text: 'Not Dialog', untrusted: true },
          ]),
        },
      ],
    },
  })
  expect(data(await f.finish()).status).toBe('practice_mismatch')
  expect(data(await f.finish('partial')).status).toBe('partial')
})
it('records a before-check mismatch for ambiguous targets', async () => {
  const f = await ready()
  expect(
    data(await f.check(1, 'before', [region('Start'), region('Start', 300), region('Skills', 100)]))
      .status,
  ).toBe('mismatch')
  expect((await readTeach(f.host, f.root.id)).mismatches![0].phase).toBe('before')
})
it('refuses done when a practice check is missing', async () => {
  const f = await ready()
  await f.check(1, 'before', [region('Start'), region('Skills', 100)])
  expect(data(await f.finish()).status).toBe('practice_checks_required')
})
it('refuses done when checks were made out of order', async () => {
  const f = await ready([lessonStep(), lessonStep(2)])
  await f.check(2, 'before', [region('Next')])
  await f.check(2, 'after', [region('Done')])
  await f.check(1, 'before', [region('Start'), region('Skills', 100)])
  await f.check(1, 'after', [region('Dialog')])
  expect(data(await f.finish()).status).toBe('practice_checks_required')
})
it('refuses done and records a mismatch when the fresh final-step recheck fails', async () => {
  const f = await ready([lessonStep(), lessonStep(2)])
  await sequential(f)
  f.fake.surface.regions = [region('Not Done')]
  expect(data(await f.finish()).status).toBe('criteria_unmet')
  expect((await readTeach(f.host, f.root.id)).mismatches?.at(-1)).toMatchObject({
    step: 2,
    phase: 'after',
  })
  expect((await readSession(f.host, f.root.id)).task?.practiceMismatch).toBe(true)
})
it('ordinary tasks still verify every criterion even when a model reuses an old practice id', async () => {
  const f = await ready([lessonStep(), lessonStep(2)])
  await sequential(f)
  const old = (await readSession(f.host, f.root.id)).task!.spec
  await f.finish('partial')
  const { approval: _approval, ...ordinary } = old
  await f.invoke('computer_task', { action: 'start', spec: { ...ordinary, practiceRun: old.id } })
  expect((await readSession(f.host, f.root.id)).task?.practiceRun).toBeUndefined()
  const before = f.fake.calls.filter((c) => c.tool === 'parse_visual_regions').length
  expect(data(await f.finish()).status).toBe('criteria_unmet')
  expect(f.fake.calls.filter((c) => c.tool === 'parse_visual_regions')).toHaveLength(before + 2)
})
it('uses the approval step budget rather than the old conversation cap', async () => {
  const f = await fixture()
  f.fake.frontmostPid = 123
  await f.start({ approval: { ...approval(), steps: 100, minutes: 60 } })
  await f.confirm()
  await updateSession(f.host, f.root.id, (doc) => {
    doc.budget.steps = 60
    doc.task!.counters.steps = 60
  })
  expect(data(await f.click()).outcomes[0].status).toBe('delivered')
})
it('stops at the approved step and time budget', async () => {
  const f = await fixture()
  f.fake.frontmostPid = 123
  await f.start({ approval: { ...approval(), steps: 1, minutes: 1 } })
  await f.confirm()
  expect(data(await f.click()).outcomes[0].status).toBe('delivered')
  expect(data(await f.click()).status).toBe('budget')
  const state = (await readSession(f.host, f.root.id)).task!
  expect(
    task.budgetGate(
      { ...state, counters: { ...state.counters, steps: 0 } },
      state.counters.startedAt + 60000,
    )?.refuse,
  ).toBe('budget')
})
it('preserves own-input takeover revocation while failed finish verification is in flight', async () => {
  const f = await fixture()
  await f.start()
  await f.confirm()
  f.fake.replyFor('parse_visual_regions', async () => {
    await f.say('Wait, I am typing')
    return { content: [], structuredContent: { regions: [region('Not Archive')] } }
  })
  expect(data(await f.finish()).status).toBe('criteria_unmet')
  expect((await readSession(f.host, f.root.id)).task?.runTakeover).toBe(false)
})
it('serializes simultaneous practice checks before their document reads', async () => {
  const f = await ready()
  const checked = await Promise.all([
    f.check(1, 'before', [region('Start'), region('Skills', 100)]),
    f.check(1, 'before', [region('Start'), region('Skills', 100)]),
  ])
  expect(checked.map((value) => data(value).status).toSorted()).toEqual(['busy', 'satisfied'])
})
it('requires an explicit skill scope and lists matching locations without starting a task', async () => {
  const f = await fixture()
  await f.save()
  expect(
    data(await f.invoke('computer_teach', { action: 'practice', skill: 'lesson' })),
  ).toMatchObject({ status: 'scope_required', scopes: ['project', 'personal'] })
  expect((await readSession(f.host, f.root.id)).task).toBeUndefined()
})
it.each(['Upload skill', 'Never taught', 'Upload'])(
  'only pre-approves whole taught consequential labels: %s',
  async (label) => {
    const f = await fixture()
    await f.save([{ ...lessonStep(), target: { label: 'Upload skill', anchors: [] } }])
    await f.say('Upload lesson')
    const built = await f.invoke('computer_teach', {
      action: 'practice',
      skill: 'lesson',
      scope: 'project',
      consequential: [label],
    })
    expect(data(built).status).toBe(
      label === 'Upload skill' ? 'awaiting_confirmation' : 'consequential_not_taught',
    )
    expect(
      (built.details as unknown as { task: { approval: { consequential: unknown } } | null }).task
        ?.approval.consequential,
    ).toEqual(label === 'Upload skill' ? [{ text: label, untrusted: true }] : undefined)
  },
)
const reopen = (f: Awaited<ReturnType<typeof fixture>>) =>
  actions.teachReopen(
    { conversation: f.root.id, scope: 'project', name: 'lesson' },
    { ...f.ctx, device: { device: 'desktop test' } },
  )
it('reopens a saved lesson for fresh approval and saves an explicit replacement', async () => {
  const f = await fixture()
  const saved = await f.save()
  const reviewed = await reopen(f)
  expect(reviewed.segment).toMatchObject({
    status: 'review',
    source: { scope: 'project', name: 'lesson', hash: expect.any(String) },
  })
  expect(reviewed.steps?.every((step) => step.approved === undefined)).toBe(true)
  expect(data(await f.practice()).status).toBe('review_required')
  await editTeaching(f.host, f.root.id, [
    { ...lessonStep(), target: { label: 'Better Start', anchors: [] } },
  ])
  await saveTeaching(f.host, {
    conversation: f.root.id,
    scope: 'project',
    name: 'lesson',
    overwrite: true,
  })
  expect(
    JSON.parse(await readFile(join(saved.path, 'procedure.json'), 'utf8'))[0].target.label,
  ).toBe('Better Start')
  expect(data(await f.invoke('computer_teach', { action: 'frames' })).status).toBe('saved')
})
it('refuses reopening a tampered lesson and all in-process calls without a user browser', async () => {
  const f = await fixture()
  const saved = await f.save()
  await expect(
    actions.teachReopen({ conversation: f.root.id, scope: 'project', name: 'lesson' }, f.ctx),
  ).rejects.toThrow('user browser')
  await writeFile(join(saved.path, 'procedure.json'), '[]')
  await expect(reopen(f)).rejects.toThrow('manifest')
})
it('rejects only the reopened review, retaining the saved lesson and images', async () => {
  const f = await fixture()
  const saved = await f.save()
  const reviewed = await reopen(f)
  const image = reviewed.segment!.frames[0].file!
  const bytes = await readFile(image)
  await actions.teachReject({ conversation: f.root.id }, f.ctx)
  expect(await readFile(image)).toEqual(bytes)
  expect(JSON.parse(await readFile(join(saved.path, 'procedure.json'), 'utf8'))).toHaveLength(1)
  expect((await readTeach(f.host, f.root.id)).segment?.status).toBe('rejected')
})
it('refuses reopening a live practice until it is finished partial or blocked', async () => {
  const f = await ready()
  await expect(reopen(f)).rejects.toThrow('Finish the practice')
  await f.finish('partial')
  expect((await reopen(f)).segment?.status).toBe('review')
})
it('refuses a saved image changed to a symlink after reopening', async () => {
  const f = await fixture()
  await f.save()
  const reviewed = await reopen(f)
  const image = reviewed.segment!.frames[0].file!
  const outside = join(f.home, 'outside.png')
  await writeFile(outside, 'private outside bytes')
  await rm(image)
  await symlink(outside, image)
  await editTeaching(f.host, f.root.id, [lessonStep()])
  await expect(
    saveTeaching(f.host, {
      conversation: f.root.id,
      scope: 'project',
      name: 'lesson',
      overwrite: true,
    }),
  ).rejects.toThrow('Unsafe taught image')
})
it.each(['2', 'type', 'file'])(
  'keeps protocol fields intact when a parameter value is %s',
  async (value) => {
    const f = await fixture()
    await f.save([{ ...lessonStep(), action: 'type', value: { param: 'file' } }])
    await f.say(`Upload lesson\nUse value '${value}'`)
    const raw = await f.invoke('computer_teach', {
      action: 'practice',
      skill: 'lesson',
      scope: 'project',
      params: { file: value },
    })
    const built = data(raw)
    expect(built.status).toBe('awaiting_confirmation')
    expect(built.spec.approval!.steps).toBe(2)
    expect(built.spec.scope.actions).toEqual(['type'])
    expect(built.spec.scope.params).toEqual({ file: '[param]' })
    expect(built.plan[0]).toMatchObject({ action: 'type', value: { param: 'file' } })
    expect(raw.details).toMatchObject({ task: { approval: { actions: ['type'] } } })
  },
)
it.each(['drafting', 'review'] as const)(
  'does not discard an existing %s draft when reopening',
  async (status) => {
    const f = await fixture()
    await f.save()
    await updateTeach(f.host, f.root.id, (doc) => {
      doc.segment!.status = status
      doc.steps![0].target.label = 'Unsaved edits'
      delete doc.steps![0].approved
      doc.segment!.frames[0].inferred = 'Keep this unsaved frame'
    })
    const before = await readTeach(f.host, f.root.id)
    await expect(reopen(f)).rejects.toThrow('Save or reject the current draft before reopening.')
    const after = await readTeach(f.host, f.root.id)
    expect(after.steps).toEqual(before.steps)
    expect(after.segment?.frames).toEqual(before.segment?.frames)
  },
)

it.each(['stop', 'hardStop'] as const)(
  '%s revokes every conversation run takeover and Resume does not restore it',
  async (kind) => {
    const f = await fixture()
    await f.start()
    await f.confirm()
    const other = await f.addConversation()
    const initial = (await readSession(f.host, f.root.id)).task!
    expect(initial.runTakeover).toBe(true)
    await updateSession(f.host, other.id, (doc) => {
      doc.task = structuredClone(initial)
    })
    if (kind === 'stop') await actions.stop({ conversation: f.root.id }, f.ctx)
    else await actions.hardStop({}, f.ctx)
    await actions.resume({ conversation: f.root.id }, f.ctx)
    await f.host.harness().waitForIdle(context)
    expect((await readSession(f.host, other.id)).task).toMatchObject({
      status: 'active',
      runTakeover: false,
    })
    expect((await readSession(f.host, f.root.id)).task?.runTakeover).toBe(false)
  },
)

it.each([false, undefined])(
  'refuses untrusted project lessons (%s) in practice, reopen and scope discovery',
  async (decision) => {
    const f = await fixture()
    await f.save()
    await f.say('Upload lesson')
    f.trust(decision)
    const scopes = await f.invoke('computer_teach', { action: 'practice', skill: 'lesson' })
    expect(scopes.structuredOutput).toMatchObject({
      status: 'scope_required',
      scopes: ['personal'],
    })
    expect(data(await f.practice()).status).toBe('project_untrusted')
    await expect(reopen(f)).rejects.toThrow('project_untrusted')
    expect((await readSession(f.host, f.root.id)).task).toBeUndefined()
    expect((await readTeach(f.host, f.root.id)).segment?.status).toBe('saved')
    expect(
      data(
        await f.invoke('computer_teach', {
          action: 'practice',
          skill: 'lesson',
          scope: 'personal',
        }),
      ).status,
    ).toBe('awaiting_confirmation')
  },
)

const bypassCases: {
  name: string
  step: Step
  role?: string
  label?: string
  approved: boolean
}[] = [
  ...(['click', 'double_click', 'right_click'] as const).map((kind) => ({
    name: kind,
    step: { kind, element: 's:1' },
    approved: true,
  })),
  { name: 'menu', step: { kind: 'menu', path: ['Upload skill'] }, approved: false },
  { name: 'committing key', step: { kind: 'key', key: 'Enter' }, approved: false },
  {
    name: 'committing chord',
    step: { kind: 'key', key: 'Delete', modifiers: ['cmd'] },
    approved: false,
  },
  {
    name: 'multiline typing',
    step: { kind: 'type', element: 's:1', text: 'hello\nworld' },
    approved: false,
  },
  {
    name: 'single-line typing',
    step: { kind: 'type', element: 's:1', text: 'hello' },
    approved: false,
  },
  {
    name: 'sensitive typing',
    step: { kind: 'type', element: 's:1', text: 'hello' },
    label: 'Upload password',
    approved: false,
  },
  {
    name: 'secure value',
    step: { kind: 'set_value', element: 's:1', value: 'hello' },
    role: 'AXSecureTextField',
    approved: false,
  },
  {
    name: 'sensitive click',
    step: { kind: 'click', element: 's:1' },
    label: 'Upload password',
    approved: false,
  },
  {
    name: 'secure click',
    step: { kind: 'click', element: 's:1' },
    role: 'AXSecureTextField',
    approved: false,
  },
]
async function checkLabelBypass(
  step: Step,
  label = 'Upload skill',
  role = 'AXButton',
  risk?: number,
) {
  const f = await fixture()
  f.fake.frontmostPid = 123
  await f.start({
    approval: { ...approval(), actions: [step.kind] },
    scope: { apps: ['Calculator'], actions: [step.kind], params: {}, consequential: [label] },
  })
  await f.confirm()
  if (risk !== undefined)
    Object.assign(f.host, {
      want: () => ({ ask: async () => ({ answers: { risk: { type: 'noul', noul: risk } } }) }),
    })
  const target: Element = {
    token: 's:1',
    index: 1,
    depth: 0,
    role,
    label,
    enabled: true,
    actions: [],
  }
  const observation: Observation = {
    app: 'Calculator',
    pid: 123,
    windowId: 456,
    title: 'Calculator',
    snapshot: 's',
    elements: [target],
    tree: '',
    truncated: false,
  }
  const session = await readSession(f.host, f.root.id)
  const ctx: GateContext = {
    session,
    conversation: f.root.id,
    grants: session.grants,
    app: 'Calculator',
    step,
    target,
    observation,
    identity: { name: 'Calculator', bundle: 'com.apple.calculator' },
    foreground: true,
    active: { stopped: false, inFlight: false },
    count: 0,
    signal: new AbortController().signal,
    host: f.host,
    driver: await runtime(f.host).driver!,
  }
  for (const gate of dispatchGates) {
    const refusal = await gate(ctx)
    if (refusal) return refusal.refuse
  }
  return undefined
}
it.each(bypassCases)(
  'label approval only bypasses label risk: $name',
  async ({ step, label, role, approved }) => {
    expect(await checkLabelBypass(step, label, role)).toBe(
      approved ? undefined : 'confirm_required',
    )
  },
)
it('still requires a card when Jev finds risk in a pre-approved label click', async () => {
  expect(
    await checkLabelBypass({ kind: 'click', element: 's:1' }, 'Upload skill', 'AXButton', 0.9),
  ).toBe('confirm_required')
})

it.each([
  { value: '1', text: 'Use account 12345', accepted: false },
  { value: '123', text: 'Use account 12345', accepted: false },
  { value: '/tmp', text: 'Use file /tmp/example.txt', accepted: false },
  { value: '1', text: 'Use file "1"', accepted: true },
  { value: '/tmp/example.txt', text: 'Use file /tmp/example.txt.', accepted: true },
  { value: '1', text: '1', accepted: true },
  { value: 't upload John', text: "I can't upload John's report", accepted: false },
  { value: 'Use sample.', text: 'First request. Use sample. Next request.', accepted: true },
  { value: 'brief file', text: 'Use file “brief file”', accepted: true, brief: true },
])(
  'requires bounded literal param provenance: $text / $value',
  async ({ value, text, accepted, brief }) => {
    const f = await fixture()
    await f.save([{ ...lessonStep(), action: 'type', value: { param: 'file' } }])
    const content = `Upload lesson\n${text}`
    if (brief) {
      await f.root.submit(
        { type: 'input', content, entry: { kind: 'subagents.instruction' } },
        context,
      )
      await f.host.harness().waitForIdle(context)
    } else await f.say(content)
    const built = await f.invoke('computer_teach', {
      action: 'practice',
      skill: 'lesson',
      scope: 'project',
      params: { file: value },
    })
    expect(data(built).status).toBe(accepted ? 'awaiting_confirmation' : 'param_provenance')
    expect(!!(await readSession(f.host, f.root.id)).task).toBe(accepted)
  },
)

it('parent user input revokes a child run takeover but not an unrelated conversation', async () => {
  const f = await fixture()
  await f.start()
  await f.confirm()
  const child = await f.addConversation(f.root.id)
  const unrelated = await f.addConversation()
  const initial = (await readSession(f.host, f.root.id)).task!
  for (const id of [child.id, unrelated.id])
    await updateSession(f.host, id, (doc) => {
      doc.task = structuredClone(initial)
    })
  await f.say('I am taking control')
  expect((await readSession(f.host, child.id)).task?.runTakeover).toBe(false)
  expect((await readSession(f.host, unrelated.id)).task?.runTakeover).toBe(true)
})

it('requires taught consequential labels again on practice replan, before changing any state', async () => {
  const f = await fixture()
  await f.save([{ ...lessonStep(), target: { label: 'Upload skill', anchors: [] } }])
  await f.say('Upload lesson')
  await f.practice()
  await f.confirm()
  const initial = (await readSession(f.host, f.root.id)).task!
  for (const label of ['Untaught', 'Upload']) {
    const changed = await f.invoke('computer_task', {
      action: 'replan',
      reason: 'Add a label',
      scope: { ...initial.spec.scope, consequential: [label] },
    })
    expect(data(changed).status).toBe('consequential_not_taught')
    expect((await readSession(f.host, f.root.id)).task).toEqual(initial)
  }
  const changed = await f.invoke('computer_task', {
    action: 'replan',
    reason: 'Add the taught label',
    scope: { ...initial.spec.scope, consequential: ['Upload skill'] },
  })
  expect(data(changed).status).toBe('awaiting_confirmation')
})

it('exposes the saved app display name alongside the canonical approval id without matching on it', async () => {
  const f = await fixture()
  await f.save()
  await f.say('Upload lesson')
  const built = await f.practice()
  expect(data(built).spec.approval).toMatchObject({
    app: 'com.apple.calculator',
    appName: 'Calculator',
  })
  expect(built.details).toMatchObject({
    task: {
      approval: {
        app: { text: 'com.apple.calculator', untrusted: true },
        appName: { text: 'Calculator', untrusted: true },
      },
    },
  })
  await f.confirm()
  await f.finish('partial')
  // Regression (review #54947): a model-written display name is dropped, so the card shows the real app.
  const started = await f.start({
    approval: { ...approval(), app: 'Other', appName: 'Calculator' },
  })
  expect(started.details).toMatchObject({ task: { approval: { app: { text: 'Other' } } } })
  expect(
    (started.details as { task?: { approval?: { appName?: unknown } } }).task?.approval?.appName,
  ).toBeUndefined()
  await f.confirm()
  expect(data(await f.click()).outcomes[0].code).toBe('user_active')
})

it('does not manufacture parameter whitespace between separate user text blocks', async () => {
  const f = await fixture()
  await f.save([{ ...lessonStep(), action: 'type', value: { param: 'file' } }])
  await f.say('Upload lesson')
  await f.root.submit(
    {
      type: 'input',
      content: [
        { type: 'text', text: '1' },
        { type: 'text', text: '2' },
      ],
    },
    context,
  )
  await f.host.harness().waitForIdle(context)
  const built = await f.invoke('computer_teach', {
    action: 'practice',
    skill: 'lesson',
    scope: 'project',
    params: { file: '1 2' },
  })
  expect(data(built).status).toBe('param_provenance')
  expect((await readSession(f.host, f.root.id)).task).toBeUndefined()
})
