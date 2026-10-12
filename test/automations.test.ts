import { mkdir, rm, writeFile } from 'node:fs/promises'
import { awaitWithContext } from '@earendil-works/chord/context'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, expect, it, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, defineTask } from '@earendil-works/pi-durable'
import type { ConversationId, TaskDefinition, TaskId } from '@earendil-works/pi-durable'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import automations, { actions, Automations } from '../extensions/automations/server.ts'
import type { Automation } from '../extensions/automations/server.ts'
import legacyAutomations, { actions as legacyActions } from './fixtures/legacy-automations.ts'
import type { ActionContext } from '../server/actions.ts'
import { temp, until } from './helpers.ts'

const hosts: OpenHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
})
async function fixture(failDelivery = false, legacy = false) {
  const root = await temp('ultimate-automations-')
  const userHome = await temp()
  await mkdir(join(root, 'agents'))
  await writeFile(
    join(root, 'agents/writer.md'),
    '---\nname: writer\ndescription: Writes\ntools: [hold]\nisolate: worktree\n---\nOnly write the report.\n',
  )
  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome,
    home: join(root, 'home'),
    faux: true,
  })
  let opened: OpenHost
  let enabled = true
  let release: (() => void) | undefined
  prepared.registry.install(
    defineExtension({
      name: 'subagents',
      tools: [
        defineTool({
          name: 'hold',
          description: 'Wait',
          parameters: Type.Object({}),
          replay: 'safe',
          execute: async (_args, _api, ctx) => {
            await awaitWithContext(
              new Promise<void>((resolve) => {
                release = resolve
              }),
              ctx,
            )
            return { content: [{ type: 'text', text: 'Released' }] }
          },
        }),
      ],
    }),
  )
  const host = {
    ...prepared,
    harness: () => opened.harness,
    metadata: Metadata,
    extensions: () => [{ name: 'subagents', enabled }],
  }
  const extension = (legacy ? legacyAutomations : automations)(
    host as unknown as Parameters<typeof automations>[0],
  )
  if (failDelivery) {
    const phases = extension.tasks!.find((t) => t.definition.name === 'ultimate.automation-run')!
      .definition.phases as TaskDefinition<
      { automation: Automation; firedAt: number },
      { phase: 'deliver'; conversationId: ConversationId },
      null,
      object
    >['phases']
    const deliver = phases.deliver
    vi.spyOn(phases, 'deliver').mockImplementationOnce((task, runtime, ctx) => {
      vi.spyOn(runtime, 'conversation').mockRejectedValueOnce(new Error('Delivery unavailable'))
      return deliver(task, runtime, ctx)
    })
  }
  prepared.registry.install(extension)
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((m) => m.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
    if (last.role === 'user' && text.startsWith('CALL '))
      return fauxAssistantMessage([fauxToolCall('automation', JSON.parse(text.slice(5)))], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && text === 'HOLD')
      return fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
    return fauxAssistantMessage([fauxText(`Answer: ${text}\nSecond line`)])
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  hosts.push(opened)
  let dispatch = legacy ? legacyActions : actions
  const action = async (name: string, args: unknown = {}) =>
    dispatch[name](args as never, { host } as unknown as ActionContext)
  const records = async () =>
    Object.values((await opened.harness.snapshot(Automations, context))?.automations ?? {})
  return {
    prepared,
    extension,
    disableDependency: () => {
      enabled = false
    },
    removeProfile: () => rm(join(root, 'agents/writer.md')),
    get opened() {
      return opened
    },
    action,
    records,
    held: () => !!release,
    release: () => release!(),
    async reopen() {
      if (hosts.includes(opened)) {
        await opened.close()
        hosts.splice(hosts.indexOf(opened), 1)
      }
      opened = await prepared.open()
      hosts.push(opened)
    },
    async upgrade() {
      await opened.close()
      hosts.splice(hosts.indexOf(opened), 1)
      prepared.registry.install(automations(host as unknown as Parameters<typeof automations>[0]))
      dispatch = actions
      opened = await prepared.open()
      hosts.push(opened)
    },
    async close() {
      await opened.close()
      hosts.splice(hosts.indexOf(opened), 1)
    },
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

it('reopens actual old A1/A2 schedulers and an admitted legacy run with unchanged shapes and exactly-once delivery', async () => {
  const f = await fixture(false, true)
  const Gate = defineTask<null, { phase: 'hold' }, null>({
    name: 'test.automation-legacy-boundary',
    version: 1,
    initial: () => ({ phase: 'hold' }),
    phases: {
      hold: async (_task, runtime, ctx) => {
        await runtime.sleep(Date.now() + 60000, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  f.prepared.registry.install(defineExtension({ name: 'legacy-boundary', tasks: [Gate] }))
  const gate = await f.opened.harness.commit(
    (tx) =>
      tx.createTask(Gate, null, {
        conversationId: f.opened.root.id,
        ownership: { kind: 'conversation' },
        background: true,
      }),
    context,
  )
  const a1 = (await f.action('create', {
    name: 'A1 future',
    prompt: 'future',
    schedule: 'in 1h',
  })) as Automation
  const a2 = (await f.action('create', {
    name: 'A2 legacy run',
    prompt: 'Legacy boundary',
    schedule: 'in 1h',
  })) as Automation
  const phases = f.extension.tasks!.find(
    (task) => task.definition.name === 'ultimate.automation-run',
  )!.definition.phases as TaskDefinition<
    { automation: Automation; firedAt: number },
    { phase: 'deliver'; conversationId: ConversationId },
    null,
    object
  >['phases']
  const deliver = phases.deliver
  vi.spyOn(phases, 'deliver').mockImplementationOnce(async (task, runtime, ctx) => {
    const commit = runtime.commit.bind(runtime)
    // Execute the real old submit/wait, then pause before its final result commit.
    vi.spyOn(runtime, 'commit').mockImplementationOnce((_change, current) =>
      commit(
        () => ({
          status: 'waiting',
          on: [gate],
          policy: 'allSettled',
          checkpoint: task.state.checkpoint,
        }),
        current,
      ),
    )
    await deliver(task, runtime, ctx)
  })
  const run = (await f.action('run', { id: a2.id })) as { id: string }
  const runId = Number(run.id) as TaskId
  await until(
    async () => (await f.opened.harness.getTask(runId, context))?.state.status === 'waiting',
  )
  const before = (await f.opened.harness.snapshot(Automations, context))!
  expect(Object.keys(before.automations)).toEqual(['A1', 'A2'])
  expect(before.next).toBe(3)
  const scheduler = await f.opened.harness.getTask(a1.scheduler!, context)
  expect(scheduler).toMatchObject({
    kind: 'ultimate.automation-scheduler',
    version: 1,
    input: { id: 'A1' },
    state: { checkpoint: { phase: 'sleep', until: before.automations.A1.nextAt } },
  })
  const task = await f.opened.harness.getTask(runId, context)
  const childId = before.automations.A2.runs[0].conversationId!
  expect(task).toMatchObject({
    kind: 'ultimate.automation-run',
    version: 1,
    input: { automation: { id: 'A2', prompt: 'Legacy boundary', runs: [] } },
    state: { checkpoint: { phase: 'deliver', conversationId: childId } },
  })
  const legacySubmission = await f.opened.harness.commit(
    (tx) => tx.submissionByRequest(childId, `automation-run:${runId}`),
    context,
  )
  expect(legacySubmission!.status).toBe('done')
  await f.upgrade()
  expect(await f.opened.harness.snapshot(Automations, context)).toEqual(before)
  expect((await f.opened.harness.getTask(a1.scheduler!, context))!.input).toEqual(scheduler!.input)
  expect((await f.opened.harness.getTask(runId, context))!.input).toEqual(task!.input)
  const submit = vi.spyOn(f.prepared.workspaces, 'submit')
  await f.opened.harness.abortTask(gate, context)
  expect((await f.opened.harness.waitForTask(runId, context)).state.outcome.status).toBe(
    'completed',
  )
  expect(submit).toHaveBeenCalledWith(
    childId,
    expect.objectContaining({ requestId: `automation-run:${runId}` }),
    expect.anything(),
  )
  await f.reopen()
  const after = (await f.opened.harness.snapshot(Automations, context))!
  expect(after.automations.A1).toEqual(before.automations.A1)
  expect(after.automations.A2.runs).toHaveLength(1)
  expect(after.automations.A2.runs[0]).toMatchObject({
    id: run.id,
    conversationId: childId,
    status: 'done',
    answer: 'Answer: Legacy boundary',
  })
  const receipt = await f.opened.harness.commit(
    (tx) => tx.submissionByRequest(childId, `automation-run:${runId}`),
    context,
  )
  expect(receipt!.id).toBe(legacySubmission!.id)
  const view = await (await f.opened.harness.conversation(childId, context))!.viewState(context)
  expect(view.value.entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
  view.dispose()
})
it('fires every 2s into distinct answered conversations and supports pause, resume, run and delete', async () => {
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Report',
    prompt: 'Scheduled report',
    schedule: 'every 2s',
  })) as Automation
  await until(
    async () => (await f.records())[0].runs.filter((r) => r.status === 'done').length >= 2,
    7000,
  )
  await f.action('pause', { id: a.id })
  const runs = (await f.records())[0].runs
  expect(new Set(runs.map((r) => r.conversationId)).size).toBe(runs.length)
  for (const run of runs) {
    expect(run.answer).toBe('Answer: Scheduled report')
    const child = (await f.opened.harness.conversation(run.conversationId!, context))!
    const view = await child.viewState(context)
    expect(
      view.value.entries.some(
        (e) => e.model?.[0]?.role === 'user' && e.model[0].content === 'Scheduled report',
      ),
    ).toBe(true)
    view.dispose()
    expect((await child.agent(context)).tools.map((t) => t.name)).not.toContain('automation')
    expect((await f.opened.harness.snapshot(Metadata, child.id, context))?.label).toBe('automation')
  }
  await delay(2200)
  expect((await f.records())[0].runs).toHaveLength(runs.length)
  await f.action('run', { id: a.id })
  await until(async () => (await f.records())[0].runs.at(-1)?.status === 'done')
  expect((await f.records())[0].runs).toHaveLength(runs.length + 1)
  await f.action('resume', { id: a.id })
  await until(async () => (await f.records())[0].runs.length === runs.length + 2, 3500)
  await f.action('delete', { id: a.id })
  expect(await f.records()).toEqual([])
  expect(await f.opened.harness.conversation(runs[0].conversationId!, context)).toBeDefined()
}, 15000)

it('pause keeps a running profile run alive, skips overlap, and abort cancels a run', async () => {
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Hold',
    prompt: 'HOLD',
    schedule: 'every 1s',
    agent: 'writer',
  })) as Automation
  await until(f.held)
  const run = (await f.records())[0].runs[0]
  const child = (await f.opened.harness.conversation(run.conversationId!, context))!
  const agent = await child.agent(context)
  expect(agent.tools.map((t) => t.name)).toEqual(['hold'])
  expect(agent.instructions).toBe('Only write the report.')
  await until(async () => (await f.records())[0].runs.some((r) => r.status === 'skipped'), 2500)
  await f.action('pause', { id: a.id })
  expect((await f.records())[0].runs[0].status).toBe('running')
  f.release()
  await until(async () => (await f.records())[0].runs[0].status === 'done')
  const manual = (await f.action('run', { id: a.id })) as { id: string }
  await until(async () => !!(await f.records())[0].runs.at(-1)?.conversationId)
  await f.action('abort', { id: a.id, runId: manual.id })
  await until(async () => (await f.records())[0].runs.at(-1)?.status === 'aborted')
  await expect(f.action('update', { id: a.id, agent: 'missing' })).rejects.toThrow('Unknown agent')
}, 10000)

it('catches up a missed fire exactly once after reopening', async () => {
  const f = await fixture()
  await f.action('create', {
    name: 'Once',
    prompt: 'After restart',
    schedule: { kind: 'at', time: new Date(Date.now() + 1200).toISOString() },
  })
  await until(async () => !!(await f.records())[0].nextAt)
  await f.close()
  await delay(1500)
  await f.reopen()
  await until(async () => (await f.records())[0].runs[0]?.status === 'done')
  await f.reopen()
  await delay(300)
  const a = (await f.records())[0]
  expect(a.runs).toHaveLength(1)
  expect(a.enabled).toBe(false)
})

it('creates an automation through a faux model tool call', async () => {
  const f = await fixture()
  await (
    await f.opened.root.submit(
      {
        type: 'input',
        content:
          'CALL ' +
          JSON.stringify({
            action: 'create',
            name: 'Tool schedule',
            prompt: 'Hello',
            schedule: 'every 15m',
            agent: 'writer',
          }),
      },
      context,
    )
  ).wait(context)
  expect((await f.records())[0]).toMatchObject({
    id: 'A1',
    name: 'Tool schedule',
    agent: 'writer',
    schedule: { kind: 'every', ms: 900000 },
  })
  await f.action('pause', { id: 'A1' })
  expect(await f.opened.harness.conversation(1 as ConversationId, context)).toBeDefined()
})

it('fails removed profiles clearly and requires the subagents extension', async () => {
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Profile',
    prompt: 'Hello',
    schedule: 'every 15m',
    agent: 'writer',
  })) as Automation
  await f.removeProfile()
  await f.action('run', { id: a.id })
  await until(async () => (await f.records())[0].runs[0]?.status === 'failed')
  expect((await f.records())[0].runs[0].answer).toContain('Unknown agent: writer')
  await f.action('pause', { id: a.id })
  const described = (await f.action('describe', {
    schedule: 'cron "0 9 * * 1-5" Europe/Vienna',
  })) as { description: string; next: number[] }
  expect(described.description).toBe('At 09:00 on weekdays (Europe/Vienna)')
  expect(described.next).toHaveLength(3)
  f.disableDependency()
  await expect(f.action('list')).rejects.toThrow(
    'automations needs the subagents extension enabled',
  )
})

it('records a throwing delivery as failed and lets the next scheduled fire run', async () => {
  const f = await fixture(true)
  const a = (await f.action('create', {
    name: 'Retry',
    prompt: 'Hello',
    schedule: 'every 1s',
  })) as Automation
  await until(async () => (await f.records())[0].runs[0]?.status === 'failed', 3000)
  expect((await f.records())[0].runs[0].answer).toContain('Delivery unavailable')
  await until(async () => (await f.records())[0].runs[1]?.status === 'done', 3000)
  await f.action('pause', { id: a.id })
})

it('refuses resuming a spent one-shot through both action and tool', async () => {
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Spent',
    prompt: 'Hello',
    schedule: 'in 1s',
  })) as Automation
  await until(async () => (await f.records())[0].runs[0]?.status === 'done', 3000)
  await expect(f.action('resume', { id: a.id })).rejects.toThrow('update the time first')
  await (
    await f.opened.root.submit(
      {
        type: 'input',
        content: 'CALL ' + JSON.stringify({ action: 'resume', id: a.id }),
      },
      context,
    )
  ).wait(context)
  const view = await f.opened.root.viewState(context)
  expect(JSON.stringify(view.value.entries)).toContain('update the time first')
  view.dispose()
  await delay(100)
  expect((await f.records())[0].runs).toHaveLength(1)
  expect((await f.records())[0].enabled).toBe(false)
})

it('preserves the next interval fire on rename, even when the same schedule is supplied', async () => {
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Before',
    prompt: 'Hello',
    schedule: 'every 1d',
  })) as Automation
  await delay(50)
  const renamed = (await f.action('update', {
    id: a.id,
    name: 'After',
    schedule: 'every 1d',
  })) as Automation
  expect(renamed.nextAt).toBe(a.nextAt)
  const reordered = (await f.action('update', {
    id: a.id,
    prompt: 'Updated',
    schedule: { ms: 86400000, kind: 'every' },
  })) as Automation
  expect(reordered.nextAt).toBe(a.nextAt)
  const changed = (await f.action('update', { id: a.id, schedule: 'every 2d' })) as Automation
  expect(changed.nextAt).toBeGreaterThan(a.nextAt!)
  await f.action('pause', { id: a.id })
})
