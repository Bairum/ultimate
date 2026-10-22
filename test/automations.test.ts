import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { JsonValue } from '@earendil-works/chord'
import { awaitWithContext } from '@earendil-works/chord/context'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, expect, it, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { TaskId } from '@earendil-works/pi-durable'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Profile } from '../extensions/subagents/api.ts'
import automations, { actions, Automations } from '../extensions/automations/server.ts'
import type { Automation } from '../extensions/automations/server.ts'
import type { ActionContext } from '../server/actions.ts'
import type { SubagentsService } from '../extensions/subagents/api.ts'
import { createChild } from '../extensions/subagents/children.ts'
import { apis, temp, until as waitFor } from './helpers.ts'

// Advance scheduler time while the shared helper measures IO against a real deadline.
const until = (test: () => boolean | Promise<boolean>, timeout = 7000) =>
  waitFor(test, timeout, () => vi.advanceTimersByTimeAsync(50))

const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  vi.useRealTimers()
})
async function fixture() {
  const provided = new Map<string, unknown>()
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
    faux: fauxProvider(),
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
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
            return { output: [{ type: 'text', text: 'Released' }] }
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
    ...apis(provided),
  }
  provided.set('subagents', {
    createChild,
  } satisfies Partial<SubagentsService>)
  const extension = automations(host as unknown as Parameters<typeof automations>[0])
  prepared.registry.install(extension)
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((m) => m.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
    if (last.role === 'user' && text === 'HOLD')
      return fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
    return fauxAssistantMessage([fauxText(`Answer: ${text}\nSecond line`)])
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  hosts.push(opened)
  const action = async (name: keyof typeof actions, args: JsonValue = {}): Promise<unknown> =>
    actions[name](args, { host } as unknown as ActionContext)
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
    async close() {
      await opened.close()
      hosts.splice(hosts.indexOf(opened), 1)
    },
  }
}

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
  await vi.advanceTimersByTimeAsync(2200)
  expect((await f.records())[0].runs).toHaveLength(runs.length)
  await f.action('run', { id: a.id })
  await until(async () => (await f.records())[0].runs.at(-1)?.status === 'done')
  expect((await f.records())[0].runs).toHaveLength(runs.length + 1)
  await f.action('resume', { id: a.id })
  await until(async () => {
    const current = (await f.records())[0].runs
    return current.length === runs.length + 2 && current.at(-1)?.status === 'done'
  }, 3500)
  await f.action('delete', { id: a.id })
  expect(await f.records()).toEqual([])
  expect(await f.opened.harness.conversation(runs[0].conversationId!, context)).toBeDefined()
})

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
  // Labelled 'automation', the run still records the definition it runs, which fast mode reads.
  expect(await f.opened.harness.snapshot(Profile, child.id, context)).toEqual({
    definition: 'writer',
  })
  await until(async () => (await f.records())[0].runs.some((r) => r.status === 'skipped'), 2500)
  await f.action('pause', { id: a.id })
  expect((await f.records())[0].runs[0].status).toBe('running')
  f.release()
  await until(async () => (await f.records())[0].runs[0].status === 'done')
  await f.opened.harness.waitForTask(Number(run.id) as TaskId, context)
  const manual = (await f.action('run', { id: a.id })) as { id: string }
  expect(manual.id).not.toMatch(/^skipped:/)
  await until(async () => !!(await f.records())[0].runs.at(-1)?.conversationId)
  await f.action('abort', { id: a.id, runId: manual.id })
  await until(async () => (await f.records())[0].runs.at(-1)?.status === 'aborted')
  await expect(f.action('update', { id: a.id, agent: 'missing' })).rejects.toThrow('Unknown agent')
})

it('fires nothing while the host is paused and catches up once after Play', async () => {
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Report',
    prompt: 'Scheduled report',
    schedule: 'every 2s',
  })) as Automation
  await until(async () => !!(await f.records())[0].nextAt)
  // The host's pause holds Pi's scheduler; an automation fire is a scheduler task, so it starts nothing.
  f.opened.harness.hold()
  await vi.advanceTimersByTimeAsync(5000)
  expect((await f.records())[0].runs).toEqual([])
  f.opened.harness.release()
  await until(async () => (await f.records())[0].runs.some((r) => r.status === 'done'))
  await f.action('pause', { id: a.id })
  // One missed fire, not one per period the pause lasted.
  expect((await f.records())[0].runs.filter((r) => r.status !== 'skipped')).toHaveLength(1)
})

it('catches up a missed fire exactly once after reopening', async () => {
  const f = await fixture()
  await f.action('create', {
    name: 'Once',
    prompt: 'After restart',
    schedule: { kind: 'at', time: new Date(Date.now() + 1200).toISOString() },
  })
  await until(async () => !!(await f.records())[0].nextAt)
  await f.close()
  await vi.advanceTimersByTimeAsync(1500)
  await f.reopen()
  await until(async () => (await f.records())[0].runs[0]?.status === 'done')
  await f.reopen()
  await vi.advanceTimersByTimeAsync(300)
  const a = (await f.records())[0]
  expect(a.runs).toHaveLength(1)
  expect(a.enabled).toBe(false)
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
  f.disableDependency()
  await expect(f.action('list')).rejects.toThrow(
    'automations needs the subagents extension enabled',
  )
})

it('refuses resuming a spent one-shot through the action', async () => {
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Spent',
    prompt: 'Hello',
    schedule: 'in 1s',
  })) as Automation
  await until(async () => (await f.records())[0].runs[0]?.status === 'done', 3000)
  await expect(f.action('resume', { id: a.id })).rejects.toThrow('update the time first')
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
  await vi.advanceTimersByTimeAsync(50)
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
})
