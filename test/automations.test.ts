import { mkdir, rm, writeFile } from 'node:fs/promises'
import { awaitWithContext } from '@earendil-works/chord/context'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, expect, it } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import automations, { actions, Automations } from '../extensions/automations/server.ts'
import type { Automation } from '../extensions/automations/server.ts'
import type { ActionContext } from '../server/actions.ts'
import { temp, until } from './helpers.ts'

const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})
async function fixture() {
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
  prepared.registry.install(automations(host as unknown as Parameters<typeof automations>[0]))
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
  const action = async (name: string, args: unknown = {}) =>
    actions[name](args as never, { host } as unknown as ActionContext)
  const records = async () =>
    Object.values((await opened.harness.snapshot(Automations, context))?.automations ?? {})
  return {
    prepared,
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
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
