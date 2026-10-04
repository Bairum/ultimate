import { projectSettings } from '../server/project-setup.ts'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool, InboxDoc, LiveDoc } from '@earendil-works/pi-durable'
import type { Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import subagents, { actions, Subagents } from '../extensions/subagents/server.ts'
import type { ActionContext } from '../server/actions.ts'
import codemode from '../extensions/codemode/server.ts'
import { Metadata } from '../server/metadata.ts'
import { UiState } from '../server/ui-state.ts'
import { discoverAgents, parseDefinition } from '../extensions/subagents/agents.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { until, temp } from './helpers.ts'

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
  const path = await temp('ultimate-subagents-')
  directories.push(path)
  return path
}
async function fixture(
  extension?: Extension,
  observe?: (transcript: Parameters<FauxResponseFactory>[0]) => void,
) {
  const ultimateRoot = await directory()
  const userHome = await directory()
  await mkdir(join(ultimateRoot, 'agents'))
  await writeFile(
    join(ultimateRoot, 'agents/scout.md'),
    extension ? definition().replace('tools: [read, bash]\n', '') : definition(),
  )
  const prepared = await prepareHarness({
    ultimateRoot,
    userHome,
    home: join(ultimateRoot, 'home'),
    faux: true,
  })
  prepared.registry.install(CodingTools)
  if (extension) prepared.registry.install(extension)
  let opened: OpenHost | undefined
  prepared.registry.install(
    subagents({
      projectSettings: () => projectSettings(prepared.projectRoot, prepared.userHome),
      ...prepared,
      harness: () => opened!.harness,
      metadata: Metadata,
    }),
  )
  prepared.registry.install(
    codemode({
      ...prepared,
      resource: (_key, create) => create(),
      onOpen: () => {},
      onClose: () => {},
      harness: () => {
        throw new Error('Not used')
      },
      system: () => {
        throw new Error('Not used')
      },
      conversations: () => [],
      projects: async () => [],
      extensions: () => [],
      reloadExtensions: async () => {},
      projectSetup: async () => ({ config: false, decision: null }),
      projectSettings: async () => ({}),
      projectExtensions: async () => [],
      setProjectDecision: async () => {},
      doc: () => undefined,
      metadata: Metadata,
    }),
  )
  const route: FauxResponseFactory = (transcript) => {
    observe?.(transcript)
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
    if (last.role === 'user' && text === 'HOLD')
      return fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
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
  opened = await prepared.open()
  hosts.push(opened)
  return { prepared, opened, ultimateRoot, userHome }
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
  it('forks before the calling assistant, keeps child configuration and starts with empty agents', async () => {
    const requests: Parameters<FauxResponseFactory>[0][] = []
    const { opened } = await fixture(undefined, (transcript) => requests.push(transcript))
    await opened.harness.commit(async (tx) => {
      Object.assign(await tx.doc(UiState, opened.root.id), {
        'subagents.selected': opened.root.id,
      })
    }, context)
    await (
      await opened.root.submit(
        { type: 'input', content: 'Remember the parent secret: violet' },
        context,
      )
    ).wait(context)
    await call(opened, { action: 'start', agent: 'scout', task: 'older child' })
    const result = await call(opened, {
      action: 'start',
      agent: 'scout',
      task: 'fork task',
      fork: true,
    })
    expect(result.text).toContain('Child: fork task')
    const request = requests.find((candidate) =>
      candidate.messages.some(
        (message) => message.role === 'user' && message.content === 'fork task',
      ),
    )!
    expect(request).toBeDefined()
    expect(JSON.stringify(request.messages)).toContain('Remember the parent secret: violet')
    expect(request.messages.findLast((message) => message.role !== 'system')).toMatchObject({
      role: 'user',
      content: 'fork task',
    })
    expect(
      request.messages.some(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === 'toolCall' &&
              part.name === 'subagent' &&
              (part.arguments as { fork?: boolean }).fork === true,
          ),
      ),
    ).toBe(false)
    const childId = (await children(opened)).at(-1)!.conversationId
    const child = (await opened.harness.conversation(childId, context))!
    const agent = await child.agent(context)
    expect(agent.instructions).toBe('Original instructions')
    expect(agent.extensions.map((extension) => extension.name)).not.toContain('subagents')
    expect(agent.tools.map((tool) => tool.name).toSorted()).toEqual(['bash', 'read'])
    expect(await opened.harness.snapshot(Subagents, childId, context)).toBeUndefined()
    expect(await opened.harness.snapshot(UiState, childId, context)).toEqual({
      'subagents.selected': opened.root.id,
    })
    expect(await opened.harness.snapshot(Metadata, childId, context)).toMatchObject({
      label: 'scout',
      title: 'fork task',
    })
  })
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
  it('discovers all three locations, overrides by name, reports malformed files and rereads edits', async () => {
    const repo = await directory(),
      home = await directory(),
      cwd = await directory()
    for (const path of [
      join(repo, 'agents'),
      join(home, '.ultimate/agents'),
      join(cwd, '.ultimate/agents'),
    ])
      await mkdir(path, { recursive: true })
    await writeFile(join(repo, 'agents/scout.md'), definition('repo'))
    await writeFile(join(home, '.ultimate/agents/scout.md'), definition('home'))
    await writeFile(join(cwd, '.ultimate/agents/scout.md'), definition('cwd'))
    await writeFile(
      join(repo, 'agents/worker.md'),
      definition('worker').replace('name: scout', 'name: worker'),
    )
    await writeFile(
      join(home, '.ultimate/agents/researcher.md'),
      definition('research').replace('name: scout', 'name: researcher'),
    )
    await writeFile(join(cwd, '.ultimate/agents/broken.md'), 'broken')
    const modelRuntime = await ModelRuntime.create()
    for (const [name, model, thinking] of [
      ['exact', 'anthropic/claude-opus-4-8', ''],
      ['suffix', 'anthropic/claude-opus-4-8:high', ''],
      ['explicit', 'anthropic/claude-opus-4-8:high', 'thinking: low\n'],
      ['unknown', 'anthropic/ultimate-nonexistent-model', ''],
      ['missing', 'ultimate-nonexistent-model', ''],
    ])
      await writeFile(
        join(repo, `agents/${name}.md`),
        definition(name)
          .replace('name: scout', `name: ${name}`)
          .replace('tools: [read, bash]', `model: ${model}\n${thinking}`),
      )
    new ProjectTrustStore(join(home, '.ultimate')).set(cwd, true)
    const found = await discoverAgents(repo, cwd, home, modelRuntime)
    expect(found.definitions.find((agent) => agent.name === 'exact')?.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
    })
    expect(found.definitions.find((agent) => agent.name === 'suffix')?.thinking).toBe('high')
    expect(found.definitions.find((agent) => agent.name === 'explicit')?.thinking).toBe('low')
    expect(found.errors.find((file) => file.name === 'unknown')?.error).toContain(
      'model: Model "ultimate-nonexistent-model" not found for provider "anthropic". Using custom model id.',
    )
    expect(found.errors.find((file) => file.name === 'missing')?.error).toContain(
      'model: Model "ultimate-nonexistent-model" not found.',
    )
    expect(found.definitions.map((agent) => agent.name).toSorted()).toEqual([
      'exact',
      'explicit',
      'researcher',
      'scout',
      'suffix',
      'worker',
    ])
    expect(found.definitions.find((agent) => agent.name === 'scout')?.instructions).toBe('cwd')
    expect(found.errors.find((file) => file.name === 'broken')).toMatchObject({
      name: 'broken',
      error: expect.stringContaining('frontmatter'),
    })
    await writeFile(join(cwd, '.ultimate/agents/scout.md'), definition('edited'))
    expect(
      (await discoverAgents(repo, cwd, home, modelRuntime)).definitions.find(
        (agent) => agent.name === 'scout',
      )?.instructions,
    ).toBe('edited')
  })
  it('parses definitions with Pi frontmatter and validates their fields', () => {
    expect(
      parseDefinition(
        '---\nname: scout\ndescription: >\n  A read-only scout\n  that searches.\nmodel: openai-codex/gpt-5.4\nthinking: max\ntools:\n  - read\n  - bash\n---\nSearch\n',
        'scout.md',
      ),
    ).toEqual({
      name: 'scout',
      description: 'A read-only scout that searches.',
      path: 'scout.md',
      instructions: 'Search',
      model: 'openai-codex/gpt-5.4',
      thinking: 'max',
      tools: ['read', 'bash'],
    })
    for (const [from, to, error] of [
      [
        'tools: [read, bash]',
        'tools: [read, bash]\nthinking: nonsense',
        'thinking must be one of off, minimal, low, medium, high, xhigh, max',
      ],
      ['description: Search', 'description: " "', 'description is required'],
      ['name: scout', 'name: a scout', 'name must be a nonempty identifier'],
      ['tools: [read, bash]', 'tools: read', 'tools must be a list of tool names'],
      ['tools: [read, bash]', 'model: " "', 'model must be a nonempty string'],
      ['tools: [read, bash]', 'tool: [read]', 'Unknown field: tool'],
      ['tools: [read, bash]', 'isolate: remote', 'isolate must be none or worktree'],
      ['Original instructions', '', 'Instructions are required'],
    ])
      expect(() => parseDefinition(definition().replace(from, to), 'test')).toThrow(error)
  })
  it('saves a definition as a project override that start uses, writes nothing when invalid, and deletes it', async () => {
    const { prepared, opened, ultimateRoot, userHome } = await fixture()
    const ctx = {
      host: { ...prepared, harness: () => opened.harness },
    } as unknown as ActionContext
    const project = join(prepared.projectRoot, '.ultimate/agents')
    const override = {
      name: 'scout',
      scope: 'project',
      frontmatter: { description: 'Project scout: reads only', tools: ['read'], thinking: 'high' },
      instructions: '# Project\n\nRead the code.\n',
    }
    await expect(actions.saveDefinition(override, ctx)).rejects.toThrow(
      "Choose this project's local setup",
    )
    expect(await actions.definitions(null, ctx)).toMatchObject({ projectLocal: false })
    new ProjectTrustStore(join(userHome, '.ultimate')).set(prepared.projectRoot, true)
    const listed = await actions.definitions(null, ctx)
    expect(listed).toMatchObject({
      projectLocal: true,
      scopes: { user: join(userHome, '.ultimate/agents'), project },
      definitions: [{ name: 'scout', source: 'builtin' }],
    })
    expect(listed.main.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['read', 'bash', 'codemode']),
    )
    expect(listed.main.tools.map((tool) => tool.name)).not.toContain('subagent')
    const builtin = await readFile(join(ultimateRoot, 'agents/scout.md'), 'utf8')
    await actions.saveDefinition(override, ctx)
    const raw = await readFile(join(project, 'scout.md'), 'utf8')
    expect(raw).toBe(
      '---\nname: scout\ndescription: "Project scout: reads only"\nthinking: high\ntools: [read]\n---\n\n# Project\n\nRead the code.\n',
    )
    expect(await readFile(join(ultimateRoot, 'agents/scout.md'), 'utf8')).toBe(builtin)
    const found = await discoverAgents(
      ultimateRoot,
      prepared.projectRoot,
      userHome,
      prepared.modelRuntime,
    )
    expect(found.definitions.find((agent) => agent.name === 'scout')).toMatchObject({
      source: 'project',
      description: 'Project scout: reads only',
      tools: ['read'],
      thinking: 'high',
      instructions: '# Project\n\nRead the code.',
    })
    expect(await actions.definition({ name: 'scout' }, ctx)).toMatchObject({
      source: 'project',
      path: join(project, 'scout.md'),
      raw,
      files: ['builtin', 'project'],
      definition: { instructions: '# Project\n\nRead the code.' },
    })
    await call(opened, { action: 'start', agent: 'scout', task: 'facts' })
    const child = (await children(opened)).at(-1)!
    const agent = await (await opened.harness.conversation(child.conversationId, context))!.agent(
      context,
    )
    expect(agent.tools.map((tool) => tool.name)).toEqual(['read'])
    expect(agent.instructions).toBe('# Project\n\nRead the code.')
    for (const [change, error] of [
      [{ frontmatter: { ...override.frontmatter, description: ' ' } }, 'description is required'],
      [{ frontmatter: { ...override.frontmatter, thinking: 'loud' } }, 'thinking must be one of'],
      [{ frontmatter: { ...override.frontmatter, model: 'anthropic/nonexistent' } }, 'model:'],
      [{ instructions: ' ' }, 'Instructions are required'],
      [{ name: '../scout' }, 'name must be a nonempty identifier'],
      [{ create: true }, 'A definition named scout exists already'],
      [{ scope: 'builtin' }, 'scope must be user or project'],
    ] as const)
      await expect(actions.saveDefinition({ ...override, ...change }, ctx)).rejects.toThrow(error)
    expect(await readFile(join(project, 'scout.md'), 'utf8')).toBe(raw)
    expect(await readdir(project)).toEqual(['scout.md'])
    await actions.saveDefinition(
      {
        name: 'builder',
        scope: 'user',
        create: true,
        frontmatter: { description: 'Builds', isolate: 'worktree' },
        instructions: 'Build it',
      },
      ctx,
    )
    expect(await actions.definition({ name: 'builder' }, ctx)).toMatchObject({
      source: 'user',
      files: ['user'],
      definition: { isolate: 'worktree', instructions: 'Build it' },
    })
    await writeFile(join(project, 'builder.md'), 'broken')
    expect(await actions.definition({ name: 'builder' }, ctx)).toMatchObject({
      source: 'user',
      files: ['user', 'project'],
      invalid: { source: 'project', error: expect.stringContaining('frontmatter') },
    })
    await actions.deleteDefinition({ name: 'scout', scope: 'project' }, ctx)
    expect(await actions.definition({ name: 'scout' }, ctx)).toMatchObject({
      source: 'builtin',
      files: ['builtin'],
    })
    await expect(
      actions.deleteDefinition({ name: 'scout', scope: 'project' }, ctx),
    ).rejects.toThrow('No project definition named scout')
    await expect(
      actions.deleteDefinition({ name: 'scout', scope: 'builtin' }, ctx),
    ).rejects.toThrow('scope must be user or project')
  })
  it('foreground returns the answer, exposes child details, inherits the parent and rereads scout on next start', async () => {
    const { opened, ultimateRoot, userHome } = await fixture()
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
    await writeFile(join(ultimateRoot, 'agents/scout.md'), definition('Updated instructions'))
    await call(opened, { action: 'start', agent: 'scout', task: 'more facts' })
    const second = (await children(opened))[1]
    expect(
      (await (await opened.harness.conversation(second.conversationId, context))!.agent(context))
        .instructions,
    ).toBe('Updated instructions')
    expect(await opened.harness.snapshot(Metadata, first.conversationId, context)).toEqual({
      label: 'scout',
      title: 'facts',
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
    await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
    await writeFile(
      join(userHome, '.ultimate/agents/home-agent.md'),
      definition('User instructions').replace('name: scout', 'name: home-agent'),
    )
    expect((await call(opened, { action: 'start', agent: 'home-agent', task: 'home' })).text).toBe(
      'Child: home',
    )
    const homeAgent = (await children(opened)).at(-1)!
    expect(
      (await (await opened.harness.conversation(homeAgent.conversationId, context))!.agent(context))
        .instructions,
    ).toBe('User instructions')
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
    expect(result.tool.model?.[0]).toMatchObject({
      details: { conversationId: child.conversationId, background: true },
    })
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
  it('delivers a background answer as a steer while the parent is in a tool round', async () => {
    let releaseParent!: () => void
    let releaseChild!: () => void
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    let parentHolding = false
    let childHolding = false
    const { opened } = await fixture(
      defineExtension({
        name: 'hold',
        tools: [
          defineTool({
            name: 'hold',
            description: 'Hold the current tool round',
            parameters: Type.Object({}),
            execute: async (_args, api) => {
              if (api.conversationId === 1) {
                parentHolding = true
                await parentGate
              } else {
                childHolding = true
                await childGate
              }
              return { content: [{ type: 'text', text: 'released' }] }
            },
          }),
        ],
      }),
    )
    try {
      await call(opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
      await until(async () => childHolding)
      await opened.root.submit({ type: 'input', content: 'HOLD' }, context)
      await until(async () => parentHolding)
      releaseChild()
      await until(
        async () =>
          (await opened.harness.snapshot(InboxDoc, opened.root.id, context))?.items.some(
            (item) =>
              item.mode !== 'write' &&
              typeof item.content === 'string' &&
              item.content.startsWith('[subagent'),
          ) === true,
      )
      const inbox = await opened.harness.snapshot(InboxDoc, opened.root.id, context)
      expect(inbox?.items).toHaveLength(1)
      expect(inbox?.items[0].mode).toBe('steer')
      releaseParent()
      await opened.root.waitForIdle(context)
      expect(await reports(opened)).toHaveLength(1)
    } finally {
      releaseChild()
      releaseParent()
    }
  })
  it('withdraws a queued background report when wait returns the same answer', async () => {
    let releaseParent!: () => void
    let releaseChild!: () => void
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    let parentHolding = false
    let childHolding = false
    const { opened } = await fixture(
      defineExtension({
        name: 'hold',
        tools: [
          defineTool({
            name: 'hold',
            description: 'Hold the current tool round',
            parameters: Type.Object({}),
            execute: async (_args, api) => {
              if (api.conversationId === 1) {
                parentHolding = true
                await parentGate
              } else {
                childHolding = true
                await childGate
              }
              return { content: [{ type: 'text', text: 'released' }] }
            },
          }),
        ],
      }),
    )
    try {
      await call(opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
      const [child] = await children(opened)
      await until(async () => childHolding)
      await opened.root.submit({ type: 'input', content: 'HOLD' }, context)
      await until(async () => parentHolding)
      // One steer is placed per boundary, so the report stays queued while the parent waits.
      await opened.root.submit(
        {
          type: 'input',
          content: `CALL ${JSON.stringify({ action: 'wait', id: child.conversationId })}`,
          whenBusy: 'steer',
        },
        context,
      )
      releaseChild()
      await until(
        async () =>
          (await opened.harness.snapshot(InboxDoc, opened.root.id, context))?.items.length === 2,
      )
      releaseParent()
      await opened.root.waitForIdle(context)
      const view = await opened.root.viewState(context)
      const results = view.value.entries.flatMap((entry) => {
        const message = entry.model?.[0]
        return message?.role === 'toolResult' && message.toolName === 'subagent'
          ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
          : []
      })
      view.dispose()
      expect(results.at(-1)).toBe('Result: released')
      expect(await reports(opened)).toHaveLength(0)
      expect((await opened.harness.snapshot(InboxDoc, opened.root.id, context))?.items).toEqual([])
    } finally {
      releaseChild()
      releaseParent()
    }
  })
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
