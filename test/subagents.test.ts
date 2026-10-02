import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { afterEach, describe, expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import subagents, { Subagents } from '../extensions/subagents/server.ts'
import codemode from '../extensions/codemode/server.ts'
import { Metadata } from '../server/metadata.ts'
import { discoverAgents, parseDefinition } from '../server/agents.ts'

const directories: string[] = []
const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true, maxRetries: 5 })
})
const definition = (body = 'Original instructions') =>
  `---\nname: scout\ndescription: Search\ntools: [read, bash]\n---\n${body}\n`
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'ultimate-subagents-'))
  directories.push(path)
  return path
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function fixture() {
  const repoRoot = await directory()
  await mkdir(join(repoRoot, 'agents'))
  await writeFile(join(repoRoot, 'agents/scout.md'), definition())
  const prepared = await prepareHarness({ repoRoot, home: join(repoRoot, 'home'), faux: true })
  prepared.registry.install(CodingTools)
  prepared.registry.install(subagents(prepared))
  prepared.registry.install(
    codemode({
      ...prepared,
      resource: (_key, create) => create(),
      onClose: () => {},
      harness: () => {
        throw new Error('Not used')
      },
      system: () => {
        throw new Error('Not used')
      },
      extensions: () => [],
      doc: () => undefined,
    }),
  )
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    if (last.role === 'user' && text.startsWith('CODE '))
      return fauxAssistantMessage([fauxToolCall('codemode', { code: text.slice(5) })], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && text.startsWith('CALL '))
      return fauxAssistantMessage([fauxToolCall('subagent', JSON.parse(text.slice(5)))], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && text === 'slow')
      return fauxAssistantMessage([fauxText('Working '.repeat(700))])
    if (last.role === 'user' && text.startsWith('[subagent'))
      return fauxAssistantMessage([fauxText('Report received')])
    return fauxAssistantMessage([
      fauxText(last.role === 'toolResult' ? `Result: ${text}` : `Child: ${text}`),
    ])
  }
  prepared.faux!.setResponses([route])
  const opened = await prepared.open()
  hosts.push(opened)
  return { prepared, opened, repoRoot }
}
async function call(opened: OpenHost, args: Record<string, unknown>) {
  await (
    await opened.root.submit({ type: 'input', content: `CALL ${JSON.stringify(args)}` }, context)
  ).wait(context)
  const view = await opened.root.viewState(context)
  const tool = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)!
  const result = tool.model?.[0]
  const text =
    result?.role === 'toolResult'
      ? result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      : ''
  view.dispose()
  return { tool, text }
}
async function children(opened: OpenHost) {
  return Object.values(
    (await opened.harness.snapshot(Subagents, opened.root.id, context))?.agents ?? {},
  )
}
async function reports(opened: OpenHost) {
  const view = await opened.root.viewState(context)
  const entries = view.value.entries.filter(
    (entry) =>
      entry.model?.[0]?.role === 'user' &&
      typeof entry.model[0].content === 'string' &&
      entry.model[0].content.startsWith('[subagent'),
  )
  view.dispose()
  return entries
}

describe('subagents', () => {
  it('keeps nested parallel starts distinct and delivers a subsequent nested message', async () => {
    const { opened } = await fixture()
    await (
      await opened.root.submit(
        {
          type: 'input',
          content: `CODE const results = await Promise.all(['first','second'].map(task => tools.subagent({action:'start',agent:'scout',task}))); text(results);`,
        },
        context,
      )
    ).wait(context)
    const agents = await children(opened)
    expect(agents).toHaveLength(2)
    expect(new Set(agents.map((agent) => agent.conversationId)).size).toBe(2)
    let view = await opened.root.viewState(context)
    expect(JSON.stringify(view.value.entries)).toContain('Child: first')
    expect(JSON.stringify(view.value.entries)).toContain('Child: second')
    view.dispose()
    await (
      await opened.root.submit(
        {
          type: 'input',
          content: `CODE const child = await tools.subagent({action:'start',agent:'scout',task:'third'}); text(await tools.subagent({action:'message',id:JSON.parse(await tools.subagent({action:'list'})).at(-1).conversationId,text:'follow-up'}));`,
        },
        context,
      )
    ).wait(context)
    view = await opened.root.viewState(context)
    expect(JSON.stringify(view.value.entries)).toContain('Child: follow-up')
    view.dispose()
  })
  it('accepts max thinking in definitions', () => {
    expect(
      parseDefinition(
        '---\nname: scout\ndescription: Search\nthinking: max\n---\nSearch',
        'scout.md',
      ).thinking,
    ).toBe('max')
  })
  it('discovers all three locations, overrides by name, reports malformed files and rereads edits', async () => {
    const repo = await directory(),
      home = await directory(),
      cwd = await directory()
    for (const path of [join(repo, 'agents'), join(home, 'agents'), join(cwd, '.ultimate/agents')])
      await mkdir(path, { recursive: true })
    await writeFile(join(repo, 'agents/scout.md'), definition('repo'))
    await writeFile(join(home, 'agents/scout.md'), definition('home'))
    await writeFile(join(cwd, '.ultimate/agents/scout.md'), definition('cwd'))
    await writeFile(
      join(repo, 'agents/worker.md'),
      definition('worker').replace('name: scout', 'name: worker'),
    )
    await writeFile(
      join(home, 'agents/researcher.md'),
      definition('research').replace('name: scout', 'name: researcher'),
    )
    await writeFile(join(cwd, '.ultimate/agents/broken.md'), 'broken')
    const found = await discoverAgents(repo, cwd, home)
    expect(found.definitions.map((agent) => agent.name).toSorted()).toEqual([
      'researcher',
      'scout',
      'worker',
    ])
    expect(found.definitions.find((agent) => agent.name === 'scout')?.instructions).toBe('cwd')
    expect(found.errors[0]).toMatchObject({
      name: 'broken',
      error: expect.stringContaining('frontmatter'),
    })
    await writeFile(join(cwd, '.ultimate/agents/scout.md'), definition('edited'))
    expect(
      (await discoverAgents(repo, cwd, home)).definitions.find((agent) => agent.name === 'scout')
        ?.instructions,
    ).toBe('edited')
    expect(
      parseDefinition(
        definition().replace('tools: [read, bash]', 'tools:\n  - read\n  - bash'),
        'test',
      ).tools,
    ).toEqual(['read', 'bash'])
    expect(() =>
      parseDefinition(definition().replace('description: Search', 'thinking: nonsense'), 'test'),
    ).toThrow('description is required')
  })
  it('foreground returns the answer, exposes child details, inherits the parent and rereads scout on next start', async () => {
    const { opened, repoRoot } = await fixture()
    const result = await call(opened, { action: 'start', agent: 'scout', task: 'facts' })
    expect(result.text).toBe('Child: facts')
    const [first] = await children(opened)
    expect(result.tool.model?.[0]).toMatchObject({
      details: { conversationId: first.conversationId },
    })
    const record = await opened.harness.commit(
      (tx) => tx.conversation(first.conversationId),
      context,
    )
    expect(record?.owner?.conversationId).toBe(opened.root.id)
    const child = (await opened.harness.conversation(first.conversationId, context))!
    const agent = await child.agent(context)
    expect(agent.tools.map((tool) => tool.name)).toEqual(['read', 'bash'])
    expect(agent.model).toEqual((await opened.root.agent(context)).model)
    expect(agent.instructions).toBe('Original instructions')
    await writeFile(join(repoRoot, 'agents/scout.md'), definition('Updated instructions'))
    await call(opened, { action: 'start', agent: 'scout', task: 'more facts' })
    const second = (await children(opened))[1]
    expect(
      (await (await opened.harness.conversation(second.conversationId, context))!.agent(context))
        .instructions,
    ).toBe('Updated instructions')
    expect(await opened.harness.snapshot(Metadata, first.conversationId, context)).toMatchObject({
      agent: 'scout',
      title: 'facts',
      background: false,
    })
    expect(
      (
        await call(opened, {
          action: 'message',
          id: first.conversationId,
          text: 'next',
          steer: true,
        })
      ).text,
    ).toBe('Child: next')
    expect((await call(opened, { action: 'wait', id: first.conversationId })).text).toBe(
      'Child: next',
    )
    const listed = JSON.parse((await call(opened, { action: 'list' })).text)
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ conversationId: first.conversationId, busy: false })
  })
  it('background returns immediately, survives parent abort and restart, and reports exactly once', async () => {
    const { prepared, opened } = await fixture()
    const result = await call(opened, {
      action: 'start',
      agent: 'scout',
      task: 'slow',
      background: true,
    })
    expect(await children(opened)).toHaveLength(1)
    const [child] = await children(opened)
    expect(result.text).toContain(String(child.conversationId))
    expect((await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.run).toBeUndefined()
    expect(
      (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeDefined()
    await opened.root.abort(context)
    expect(
      (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeDefined()
    await opened.close()
    hosts.splice(hosts.indexOf(opened), 1)
    const resumed = await prepared.open()
    hosts.push(resumed)
    await until(async () => (await reports(resumed)).length === 1)
    await resumed.harness.waitForIdle(context)
    expect(await children(resumed)).toHaveLength(1)
    expect(await reports(resumed)).toHaveLength(1)
    const view = await resumed.root.viewState(context)
    expect(
      view.value.entries.some(
        (entry) =>
          entry.model?.[0]?.role === 'assistant' &&
          entry.model[0].content.some(
            (part) => part.type === 'text' && part.text === 'Report received',
          ),
      ),
    ).toBe(true)
    view.dispose()
    await call(resumed, { action: 'message', id: child.conversationId, text: 'another' })
    await until(async () => (await reports(resumed)).length === 2)
    await resumed.root.waitForIdle(context)
    expect((await children(resumed))[0].reported).toHaveLength(2)
  }, 20000)
  it('records a background child answer returned by wait as reported', async () => {
    const { opened } = await fixture()
    await call(opened, { action: 'start', agent: 'scout', task: 'slow', background: true })
    const [agent] = await children(opened)
    await call(opened, { action: 'stop', id: agent.conversationId })
    const child = (await opened.harness.conversation(agent.conversationId, context))!
    const answer = await (
      await child.submit({ type: 'input', content: 'wait-only answer' }, context)
    ).wait(context)
    expect(answer.status).toBe('done')
    expect((await call(opened, { action: 'wait', id: agent.conversationId })).text).toBe(
      'Child: wait-only answer',
    )
    if (answer.status !== 'done' || answer.type !== 'input') throw new Error('Expected answer')
    expect((await children(opened))[0].reported).toContain(answer.answer)
    expect(await reports(opened)).toHaveLength(0)
  })
  it('replays an interrupted foreground start using its existing owned child', async () => {
    const { prepared, opened } = await fixture()
    await opened.root.submit(
      { type: 'input', content: 'CALL {"action":"start","agent":"scout","task":"slow"}' },
      context,
    )
    await until(async () => {
      const [child] = await children(opened)
      return (
        child !== undefined &&
        (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run !== undefined
      )
    })
    const [before] = await children(opened)
    await opened.close()
    hosts.splice(hosts.indexOf(opened), 1)
    const resumed = await prepared.open()
    hosts.push(resumed)
    await resumed.root.waitForIdle(context)
    expect(await children(resumed)).toHaveLength(1)
    expect((await children(resumed))[0].conversationId).toBe(before.conversationId)
    const view = await resumed.root.viewState(context)
    const results = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result')
    expect(results).toHaveLength(1)
    expect(results[0].model?.[0]).toMatchObject({
      content: [{ type: 'text', text: 'Working '.repeat(700) }],
      details: { conversationId: before.conversationId },
      isError: false,
    })
    view.dispose()
  }, 15000)
  it('stops a background child, suppresses its aborted report, and leaves it reusable', async () => {
    const { opened } = await fixture()
    await call(opened, {
      action: 'start',
      agent: 'scout',
      task: 'slow',
      background: true,
    })
    expect(await children(opened)).toHaveLength(1)
    const [child] = await children(opened)
    expect((await call(opened, { action: 'stop', id: child.conversationId })).text).toBe(
      `Stopped ${child.conversationId}.`,
    )
    expect(
      (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    expect(await reports(opened)).toHaveLength(0)
    await call(opened, { action: 'message', id: child.conversationId, text: 'reuse', steer: true })
    await until(async () => (await reports(opened)).length === 1)
  })
})
