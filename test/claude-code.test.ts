import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { normalizeContext, Type } from '@earendil-works/pi-ai'
import { CompactionTask, defineExtension, defineTool, hook } from '@earendil-works/pi-durable'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import codemode from '../extensions/codemode/server.ts'
import { ToolBridge, bridgeTools } from '../extensions/claude-code/bridge.ts'
import type { Automation } from '../extensions/automations/server.ts'
import { ProjectTrustStore, resolveCliModel } from '@earendil-works/pi-coding-agent'
import {
  claudeCode,
  continuePrompt,
  createClaudeProvider,
  userTurns,
} from '../extensions/claude-code/server.ts'
import { Sessions, killOrphan } from '../extensions/claude-code/sessions.ts'
import { childEnv } from '../extensions/claude-code/runner.ts'
import type { Runner, RunOptions } from '../extensions/claude-code/runner.ts'
import { exclusiveHooks, pluginDirectory, promptAppend } from '../extensions/claude-code/setup.ts'
import { exclusiveSlot } from '../extensions/exclusive-commands/server.ts'
import subagents, { Subagents } from '../extensions/subagents/server.ts'
import automations, {
  actions as automationActions,
  Automations,
} from '../extensions/automations/server.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { git } from '../extensions/subagents/isolates/worktree.ts'
import { temp, until } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})
const usage = { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, cost: 0.01 }
const calls: RunOptions[] = []
const fake: Runner = (options) => {
  calls.push(options)
  return {
    interrupt: async () => {},
    kill: () => {},
    async *[Symbol.asyncIterator]() {
      yield { type: 'tool', name: 'Bash', input: { command: 'echo fake' } }
      await options.store.append({ projectKey: options.cwd, sessionId: options.id }, [
        { type: 'user', uuid: 'turn-' + calls.length, message: options.prompt },
      ])
      yield { type: 'result', text: `Answer: ${options.prompt}`, usage }
    },
  }
}

async function fixture(runner: Runner = fake, isolate = false) {
  calls.length = 0
  const root = await temp('ultimate-claude-code-')
  await mkdir(join(root, 'agents'))
  await writeFile(
    join(root, 'agents/claude-worker.md'),
    `---\nname: claude-worker\ndescription: Work\nmodel: claude-code/haiku\nisolate: ${isolate ? 'worktree' : 'none'}\n---\nOnly the requested work.\n`,
  )
  if (isolate) {
    await git(root, 'init', '-b', 'main')
    await git(root, 'config', 'user.name', 'Test')
    await git(root, 'config', 'user.email', 'test@example.com')
    await git(root, 'add', '.')
    await git(root, 'commit', '-m', 'base')
  }
  new ProjectTrustStore(join(root, '.ultimate')).set(root, true)
  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome: root,
    home: join(root, 'home'),
    faux: false,
  })
  let opened: OpenHost
  const closers: (() => Promise<void>)[] = []
  const resources = new Map<string, unknown>()
  const host = {
    ...prepared,
    harness: () => opened.harness,
    metadata: Metadata,
    resource: <T>(key: string, create: () => T): T => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onClose: (close: () => Promise<void>) => closers.push(close),
    onOpen: () => {},
    projectSettings: async () => ({}),
    conversations: () => [],
    extensions: () => [{ name: 'subagents', enabled: true }],
  } as unknown as ExtensionHost
  prepared.registry.install(claudeCode(host, runner))
  prepared.registry.install(subagents(host))
  prepared.registry.install(automations(host))
  const parent = fauxProvider({ provider: 'test-parent', models: [{ id: 'parent' }] })
  const route: FauxResponseFactory = (transcript) => {
    parent.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (
      last.role === 'user' &&
      typeof last.content === 'string' &&
      last.content.startsWith('CALL ')
    )
      return fauxAssistantMessage([fauxToolCall('subagent', JSON.parse(last.content.slice(5)))], {
        stopReason: 'toolUse',
      })
    return fauxAssistantMessage('Parent finished')
  }
  parent.setResponses([route])
  prepared.modelRuntime.registerNativeProvider(parent.provider)
  opened = await prepared.open()
  await opened.root.configure({ model: { provider: 'test-parent', modelId: 'parent' } }, context)
  cleanups.push(async () => {
    await opened.close()
    for (const closer of closers) await closer()
  })
  const call = async (args: object) => {
    await (
      await opened.root.submit({ type: 'input', content: `CALL ${JSON.stringify(args)}` }, context)
    ).wait(context)
    const view = await opened.root.viewState(context)
    const text = JSON.stringify(view.value)
    view.dispose()
    return text
  }
  const children = async () =>
    Object.values((await opened.harness.snapshot(Subagents, opened.root.id, context))?.agents ?? {})
  return { root, prepared, host, opened, call, children }
}

it('registers native aliases, resolves a definition, maps turns, progress, usage and resumes the same child session', async () => {
  const f = await fixture()
  expect(f.prepared.modelRuntime.getModels('claude-code').map((model) => model.id)).toEqual([
    'opus',
    'sonnet',
    'haiku',
    'fable',
  ])
  expect(
    resolveCliModel({ cliModel: 'claude-code/haiku', modelRuntime: f.prepared.modelRuntime }).model
      ?.provider,
  ).toBe('claude-code')
  expect(await f.call({ action: 'start', agent: 'claude-worker', task: 'first' })).toContain(
    'Answer: first',
  )
  const child = (await f.children())[0]
  expect(await f.call({ action: 'message', id: child.conversationId, text: 'second' })).toContain(
    'Answer: second',
  )
  expect(calls.map((call) => [call.prompt, call.resume])).toEqual([
    ['first', false],
    ['second', true],
  ])
  expect(calls[0].id).toBe(calls[1].id)
  expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  expect(calls[0].id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(calls[0].append).toContain('Only the requested work.')
  expect(calls[0].append).toContain('Answer concisely for the parent')
  const conversation = await f.opened.harness.conversation(child.conversationId, context)
  const view = await conversation!.viewState(context)
  expect(JSON.stringify(view.value)).toContain('echo fake')
  const message = view.value.entries.findLast((entry) => entry.kind === 'pi.assistant')?.model?.[0]
  expect(message?.role === 'assistant' && message.usage.input).toBe(10)
  expect(message?.role === 'assistant' && message.usage.cost.total).toBe(0)
  view.dispose()
  expect(
    await calls[0].store.load({ projectKey: calls[0].cwd, sessionId: calls[0].id }),
  ).toHaveLength(2)
})

it('queues a mid-turn steer as a follow-up without sending Pi system instructions or tools', async () => {
  let release: (() => void) | undefined
  const f = await fixture((options) => {
    calls.push(options)
    return {
      interrupt: async () => {},
      kill: () => {},
      async *[Symbol.asyncIterator]() {
        if (!options.resume)
          await new Promise<void>((resolve) => {
            release = resolve
          })
        yield { type: 'result', text: `Answer: ${options.prompt}`, usage }
      },
    }
  })
  await f.call({ action: 'start', agent: 'claude-worker', task: 'original', background: true })
  await until(() => !!release)
  const child = (await f.children())[0]
  await f.call({ action: 'message', id: child.conversationId, text: 'steered input', steer: true })
  expect(calls.map((call) => call.prompt)).toEqual(['original'])
  release!()
  await until(() => calls.length === 2)
  await f.opened.harness.waitForIdle(context)
  expect(calls.map((call) => call.prompt)).toEqual(['original', 'steered input'])
  expect(calls[1].resume).toBe(true)
  expect(calls[1].id).toBe(calls[0].id)
  expect(calls[1].append).not.toContain('You coordinate')
  expect(calls[1]).not.toHaveProperty('tools')
})

it('recovers an in-flight turn without repeating it and replays a completed result without another run', async () => {
  const root = await temp()
  const sessions = new Sessions(join(root, 'sessions.sqlite'))
  cleanups.push(async () => sessions.close())
  const resources = new Map<string, unknown>()
  const host = {
    home: root,
    projectRoot: root,
    skills: () => [],
    projectSettings: async () => ({}),
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
  } as unknown as ExtensionHost
  const transcript = normalizeContext({
    messages: [
      { role: 'user' as const, content: 'do not duplicate', timestamp: 1 },
      {
        role: 'system' as const,
        content: '',
        timestamp: 2,
        sections: {
          'claude-code-context': JSON.stringify({
            cwd: root,
            instructions: 'Do it',
            conversation: 1,
          }),
        },
      },
    ],
  })
  sessions.put({
    id: 'session',
    cwd: root,
    handled: [],
    turn: { prompt: 'do not duplicate', keys: userTurns(transcript).map((turn) => turn.key) },
  })
  calls.length = 0
  const provider = createClaudeProvider(host, sessions, fake)
  const result = await provider
    .streamSimple(provider.getModels()[0], transcript, { sessionId: 'session' })
    .result()
  expect(result.stopReason).toBe('stop')
  expect(calls).toHaveLength(1)
  expect(calls[0].prompt).toBe(continuePrompt)
  expect(calls[0].resume).toBe(true)
  await provider
    .streamSimple(provider.getModels()[0], transcript, { sessionId: 'session' })
    .result()
  expect(calls).toHaveLength(1)
})

it('stop interrupts and kills a fake Claude process within five seconds', async () => {
  let child: ReturnType<typeof spawn> | undefined
  let interrupted = false
  let killed = false
  const f = await fixture((options) => {
    child = spawn(process.execPath, ['-e', "process.title='claude-fake';setInterval(()=>{},1000)"])
    options.onPid(child.pid!)
    return {
      interrupt: async () => {
        interrupted = true
      },
      kill: () => {
        killed = true
        child!.kill('SIGKILL')
      },
      async *[Symbol.asyncIterator]() {
        await once(child!, 'exit')
        yield { type: 'error', message: 'interrupted' }
      },
    }
  })
  const pending = f.call({
    action: 'start',
    agent: 'claude-worker',
    task: 'hold',
    background: true,
  })
  await until(() => !!child)
  await pending
  const agent = (await f.children())[0]
  const started = Date.now()
  const exited = once(child!, 'exit')
  await f.call({ action: 'stop', id: agent.conversationId })
  await exited
  expect(Date.now() - started).toBeLessThan(5000)
  expect(interrupted && killed).toBe(true)
})

it('preserves HOME and strips keys and parent markers at the spawn boundary', async () => {
  const env = childEnv({
    HOME: '/same/home',
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: 'fake',
    ANTHROPIC_AUTH_TOKEN: 'fake',
    CLAUDE_CODE_SESSION: 'parent',
    CLAUDE_CODE_OTHER: 'parent',
    CLAUDECODE: '1',
  })
  const child = spawn(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  await once(child, 'exit')
  const captured = JSON.parse(output)
  expect(captured.HOME).toBe('/same/home')
  expect(captured.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
  expect(
    Object.keys(captured).filter(
      (key) =>
        key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE',
    ),
  ).toEqual([])
})

it('mirrors entries atomically and deduplicates UUIDs, retaining entries without UUIDs', async () => {
  const root = await temp()
  const store = new Sessions(join(root, 'mirror.sqlite'))
  const key = { projectKey: 'project', sessionId: 'session' }
  await store.mirror.append(key, [{ type: 'user', uuid: 'one' }, { type: 'metadata' }])
  await store.mirror.append(key, [
    { type: 'user', uuid: 'one' },
    { type: 'assistant', uuid: 'two' },
  ])
  expect(await store.mirror.load(key)).toEqual([
    { type: 'user', uuid: 'one' },
    { type: 'metadata' },
    { type: 'assistant', uuid: 'two' },
  ])
  store.close()
  const reopened = new Sessions(join(root, 'mirror.sqlite'))
  expect(await reopened.mirror.load(key)).toHaveLength(3)
  expect(await reopened.mirror.load({ ...key, subpath: 'other' })).toBeNull()
  reopened.close()
})

it('links merged skill directories into the plugin and appends AGENTS only without CLAUDE', async () => {
  const f = await fixture()
  const paths = [
    join(f.root, 'skills/builtin'),
    join(f.root, '.pi/skills/pi'),
    join(f.root, '.ultimate/skills/project'),
  ]
  for (const path of paths) {
    await mkdir(path, { recursive: true })
    await writeFile(
      join(path, 'SKILL.md'),
      `---\nname: ${path.split('/').at(-1)}\ndescription: test\n---\nUse it\n`,
    )
  }
  const plugin = await pluginDirectory(f.host, f.root, 'plugin-test')
  for (const path of paths)
    expect(await readlink(join(plugin, 'skills', path.split('/').at(-1)!))).toBe(path)
  await writeFile(join(f.root, 'AGENTS.md'), 'AGENT INSTRUCTIONS')
  expect(await promptAppend(f.root, 'DEFINITION', 9)).toContain('AGENT INSTRUCTIONS')
  await writeFile(join(f.root, 'CLAUDE.md'), 'NATIVE INSTRUCTIONS')
  const append = await promptAppend(f.root, 'DEFINITION', 9)
  expect(append).toContain('conversation #9')
  expect(append).not.toContain('AGENT INSTRUCTIONS')
})

it('Bash PreToolUse waits on the shared exclusive lock and releases on completion or abort', async () => {
  const resources = new Map<string, unknown>()
  const host = {
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    projectSettings: async () => ({ exclusiveCommands: ['heavy'] }),
  }
  const controller = new AbortController()
  const slot = exclusiveSlot(host)
  await slot.acquire('other heavy')
  const hooks = exclusiveHooks(host, controller.signal)
  const input = {
    hook_event_name: 'PreToolUse' as const,
    tool_name: 'Bash',
    tool_use_id: 'tool',
    tool_input: { command: 'heavy command' },
    session_id: 'session',
    transcript_path: '',
    cwd: '',
  }
  let granted = false
  const pre = hooks.hooks
    .PreToolUse![0].hooks[0](input, 'tool', { signal: controller.signal })
    .then(() => {
      granted = true
    })
  await until(() => slot.queue.length === 1)
  expect(granted).toBe(false)
  slot.release()
  await pre
  expect(slot.command).toBe('heavy command')
  await hooks.hooks.PostToolUse![0].hooks[0](
    { ...input, hook_event_name: 'PostToolUse', tool_response: 'ok' },
    'tool',
    { signal: controller.signal },
  )
  expect(slot.command).toBeUndefined()
  await hooks.hooks.PreToolUse![0].hooks[0](input, 'another', { signal: controller.signal })
  controller.abort()
  expect(slot.command).toBeUndefined()
  hooks.close()
})

it('runs a claude-code definition from an automation and records its answer', async () => {
  const f = await fixture()
  const actionContext = { host: f.host } as unknown as ActionContext
  const automation = (await automationActions.create(
    {
      name: 'Personal report',
      prompt: 'automation input',
      schedule: 'every 1h',
      agent: 'claude-worker',
    },
    actionContext,
  )) as Automation
  await automationActions.run({ id: automation.id }, actionContext)
  await until(async () =>
    Object.values((await f.opened.harness.snapshot(Automations, context))?.automations ?? {}).some(
      (item) => item.runs.some((run) => run.status === 'done'),
    ),
  )
  expect(calls[0].prompt).toBe('automation input')
  const records = Object.values(
    (await f.opened.harness.snapshot(Automations, context))!.automations,
  )
  expect(JSON.stringify(records)).toContain('Answer: automation input')
})

it('passes the worktree cwd to a Claude child and its fake-runner commit is landable', async () => {
  const f = await fixture(
    (options) => ({
      interrupt: async () => {},
      kill: () => {},
      async *[Symbol.asyncIterator]() {
        calls.push(options)
        await writeFile(join(options.cwd, 'child.txt'), 'child\n')
        await git(options.cwd, 'add', 'child.txt')
        await git(options.cwd, 'commit', '-m', 'fake child')
        yield { type: 'result', text: 'Committed', usage }
      },
    }),
    true,
  )
  expect(await f.call({ action: 'start', agent: 'claude-worker', task: 'implement' })).toContain(
    'Committed',
  )
  const child = (await f.children())[0]
  expect(calls[0].cwd).toBe(child.isolate!.path)
  expect(calls[0].cwd).not.toBe(f.root)
  expect(await f.call({ action: 'land', id: child.conversationId })).toContain('Landed commits')
  expect(await readFile(join(f.root, 'child.txt'), 'utf8')).toBe('child\n')
})

async function mcpClient(options: Pick<RunOptions, 'mcpServers'>) {
  const server = options.mcpServers!.ultimate as McpSdkServerConfigWithInstance
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(serverTransport)
  const client = new Client({ name: 'fake-claude', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

async function preCall(
  options: Pick<RunOptions, 'id' | 'cwd' | 'hooks' | 'signal'>,
  name: string,
  args: object,
  id: string,
) {
  for (const group of options.hooks?.PreToolUse ?? [])
    if (group.matcher === 'mcp__ultimate__.*')
      for (const callback of group.hooks)
        await callback(
          {
            hook_event_name: 'PreToolUse',
            session_id: options.id,
            transcript_path: '',
            cwd: options.cwd,
            tool_name: 'mcp__ultimate__' + name,
            tool_input: args,
            tool_use_id: id,
          },
          id,
          { signal: options.signal },
        )
}

it('round trips real codemode and screenshot Pi tool tasks through held MCP calls without restarting the query', async () => {
  const received: unknown[] = []
  let spawned = 0
  const f = await fixture((options) => {
    spawned++
    return {
      interrupt: async () => {},
      kill: () => {},
      async *[Symbol.asyncIterator]() {
        const client = await mcpClient(options)
        try {
          const listed = await client.listTools()
          expect(listed.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(['codemode', 'screenshot']),
          )
          expect(
            listed.tools.some((tool) =>
              [
                'read',
                'write',
                'edit',
                'bash',
                'grep',
                'find',
                'ls',
                'subagent',
                'web_search',
                'web_fetch',
              ].includes(tool.name),
            ),
          ).toBe(false)
          expect(
            listed.tools.find((tool) => tool.name === 'screenshot')?.annotations?.readOnlyHint,
          ).toBe(true)
          for (const [name, args] of [
            ['codemode', { code: 'return 6 * 7' }],
            ['screenshot', {}],
          ] as const) {
            await preCall(options, name, args, 'call-' + name)
            received.push(await client.callTool({ name, arguments: args }))
          }
          yield { type: 'result', text: 'MCP FINISHED', usage }
        } finally {
          await client.close()
        }
      },
    }
  })
  f.prepared.registry.install(codemode(f.host))
  let screenshots = 0
  f.prepared.registry.install(
    defineExtension({
      name: 'screenshot',
      tools: [
        defineTool({
          name: 'screenshot',
          description: 'Capture image',
          parameters: Type.Object({}),
          execute: async () => {
            screenshots++
            const graph = await f.opened.harness.taskGraph(context)
            expect(JSON.stringify(graph.value)).toContain('pi.tool')
            graph.dispose()
            return { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] }
          },
        }),
      ],
    }),
  )
  expect(await f.call({ action: 'start', agent: 'claude-worker', task: 'bridge' })).toContain(
    'MCP FINISHED',
  )
  expect(spawned).toBe(1)
  expect(screenshots).toBe(1)
  expect(JSON.stringify(received[0])).toContain('42')
  expect(received[1]).toMatchObject({
    content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    isError: false,
  })
  const child = (await f.children())[0]
  const conversation = await f.opened.harness.conversation(child.conversationId, context)
  const view = await conversation!.viewState(context)
  const tools = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result')
  expect(tools).toHaveLength(2)
  expect(JSON.stringify(tools)).toContain('call-codemode')
  expect(JSON.stringify(tools)).toContain('call-screenshot')
  view.dispose()
})

it('excludes native tool variants and subagent and preserves JSON Schema and selected tool removals', async () => {
  const names = [
    'read',
    'write',
    'edit',
    'bash',
    'grep',
    'find',
    'ls',
    'WebSearch',
    'WebFetch',
    'web_search',
    'web_fetch',
    'subagent',
    'codemode',
    'removed',
  ]
  const parameters = Type.Object({
    value: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  })
  const transcript = normalizeContext({
    messages: [
      {
        role: 'system',
        content: '',
        timestamp: 1,
        toolsAdded: names.map((name) => ({ name, description: name, parameters })),
      },
      { role: 'system', content: '', timestamp: 2, toolsRemoved: [{ name: 'removed' }] },
    ],
  })
  expect(bridgeTools(transcript).map((tool) => tool.name)).toEqual(['codemode'])
  const bridge = new ToolBridge(bridgeTools(transcript))
  const client = await mcpClient({ mcpServers: { ultimate: bridge.server } })
  try {
    expect(bridge.server.timeout).toBe(3600000)
    expect((await client.listTools()).tools[0].inputSchema).toEqual(
      JSON.parse(JSON.stringify(parameters)),
    )
  } finally {
    await client.close()
  }
})

it.each(['swap', 'timeout'])(
  'resumes a lost held MCP query after %s with the durable result as text and no duplicate execution',
  async (loss) => {
    const prompts: string[] = []
    let executions = 0
    let release: (() => void) | undefined
    let cancel: (() => void) | undefined
    let abandoned = false
    const runner: Runner = (options) => {
      prompts.push(options.prompt)
      const controller = new AbortController()
      cancel = () => controller.abort()
      return {
        interrupt: async () => {},
        kill: () => controller.abort(),
        async *[Symbol.asyncIterator]() {
          if (!options.resume) {
            const client = await mcpClient(options)
            try {
              await preCall(options, 'screenshot', {}, 'held-call')
              await client.callTool({ name: 'screenshot', arguments: {} }, undefined, {
                signal: controller.signal,
                timeout: loss === 'timeout' ? 50 : 60000,
              })
            } catch {
              abandoned = true
              throw new Error('fake query lost')
            } finally {
              await client.close()
            }
          }
          yield { type: 'result', text: 'RECOVERED BRIDGE RESULT', usage }
        },
      }
    }
    const f = await fixture(runner)
    f.prepared.registry.install(
      defineExtension({
        name: 'screenshot',
        tools: [
          defineTool({
            name: 'screenshot',
            description: 'Read-only image',
            parameters: Type.Object({}),
            replay: 'safe',
            execute: async () => {
              executions++
              await new Promise<void>((resolve) => {
                release = resolve
              })
              return { content: [{ type: 'text', text: 'UNIQUE TOOL RESULT' }], isError: true }
            },
          }),
        ],
      }),
    )
    await f.call({ action: 'start', agent: 'claude-worker', task: 'ORIGINAL', background: true })
    await until(() => !!release)
    if (loss === 'swap') {
      cancel!()
      await until(() => abandoned)
      f.prepared.registry.install(claudeCode(f.host, runner))
    } else await until(() => abandoned)
    release!()
    await until(() => prompts.length === 2)
    const child = (await f.children())[0]
    const conversation = await f.opened.harness.conversation(child.conversationId, context)
    await conversation!.waitForIdle(context)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('Your call to screenshot was interrupted by a restart')
    expect(prompts[1]).toContain('UNIQUE TOOL RESULT')
    expect(prompts[1]).toContain('"isError":true')
    expect(prompts[1]).not.toContain('ORIGINAL')
    expect(executions).toBe(1)
    const view = await conversation!.viewState(context)
    expect(JSON.stringify(view.value)).toContain('RECOVERED BRIDGE RESULT')
    expect(view.value.entries.filter((entry) => entry.kind === 'pi.tool-result')).toHaveLength(1)
    view.dispose()
  },
)

it("offers only a definition's explicitly selected Pi tools to MCP", async () => {
  let listed: string[] = []
  const f = await fixture((options) => ({
    interrupt: async () => {},
    kill: () => {},
    async *[Symbol.asyncIterator]() {
      const client = await mcpClient(options)
      try {
        listed = (await client.listTools()).tools.map((tool) => tool.name)
      } finally {
        await client.close()
      }
      yield { type: 'result', text: 'SELECTED', usage }
    },
  }))
  f.prepared.registry.install(codemode(f.host))
  f.prepared.registry.install(
    defineExtension({
      name: 'screenshot',
      tools: [
        defineTool({
          name: 'screenshot',
          description: 'Read-only image',
          parameters: Type.Object({}),
          execute: async () => ({}),
        }),
      ],
    }),
  )
  await writeFile(
    join(f.root, 'agents/claude-worker.md'),
    `---\nname: claude-worker\ndescription: Work\nmodel: claude-code/haiku\nisolate: none\ntools: [screenshot]\n---\nOnly screenshot.\n`,
  )
  expect(
    await f.call({ action: 'start', agent: 'claude-worker', task: 'selected tools' }),
  ).toContain('SELECTED')
  expect(listed).toEqual(['screenshot'])
})

it('stops a held MCP process within five seconds, interrupts before killing, and sends the next message as new work', async () => {
  let child: ReturnType<typeof spawn> | undefined
  let executing = false
  const order: string[] = []
  const prompts: string[] = []
  const f = await fixture((options) => {
    prompts.push(options.prompt)
    if (options.resume)
      return {
        interrupt: async () => {},
        kill: () => {},
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', text: options.prompt, usage }
        },
      }
    child = spawn(process.execPath, ['-e', "process.title='claude-fake';setInterval(()=>{},1000)"])
    options.onPid(child.pid!)
    return {
      interrupt: async () => {
        order.push('interrupt')
      },
      kill: () => {
        order.push('kill')
        child!.kill('SIGKILL')
      },
      async *[Symbol.asyncIterator]() {
        const client = await mcpClient(options)
        try {
          await preCall(options, 'screenshot', {}, 'stop-held')
          await client.callTool({ name: 'screenshot', arguments: {} })
        } finally {
          await client.close()
        }
        yield { type: 'result', text: 'SHOULD NOT COMPLETE', usage }
      },
    }
  })
  f.prepared.registry.install(
    defineExtension({
      name: 'screenshot',
      tools: [
        defineTool({
          name: 'screenshot',
          description: 'Hold',
          parameters: Type.Object({}),
          execute: async (_args, _api, taskContext) => {
            executing = true
            await new Promise<void>((_resolve, reject) =>
              taskContext.abortSignal!.addEventListener(
                'abort',
                () => reject(taskContext.abortSignal!.reason),
                { once: true },
              ),
            )
            return {}
          },
        }),
      ],
    }),
  )
  await f.call({
    action: 'start',
    agent: 'claude-worker',
    task: 'old canceled task',
    background: true,
  })
  await until(() => executing)
  const agent = (await f.children())[0]
  const exited = once(child!, 'exit')
  const started = Date.now()
  await f.call({ action: 'stop', id: agent.conversationId })
  await f.call({ action: 'message', id: agent.conversationId, text: 'do Y' })
  await exited
  expect(Date.now() - started).toBeLessThan(5000)
  expect(Date.now() - started).toBeGreaterThanOrEqual(2900)
  expect(order.slice(0, 2)).toEqual(['interrupt', 'kill'])
  await until(() => prompts.length === 2)
  expect(prompts).toEqual(['old canceled task', 'do Y'])
})

it('retries a failed first launch with sessionId instead of resuming a nonexistent session', async () => {
  const optionsSeen: RunOptions[] = []
  const f = await fixture((options) => {
    optionsSeen.push(options)
    if (optionsSeen.length === 1) throw new Error('ENOENT before spawn')
    return {
      interrupt: async () => {},
      kill: () => {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', text: 'RETRY OK', usage }
      },
    }
  })
  await f.call({ action: 'start', agent: 'claude-worker', task: 'original instructions' })
  const agent = (await f.children())[0]
  expect(
    await f.call({ action: 'message', id: agent.conversationId, text: 'retry now' }),
  ).toContain('RETRY OK')
  expect(optionsSeen.map((options) => options.resume)).toEqual([false, false])
  expect(optionsSeen[1].prompt).toContain('original instructions')
  expect(optionsSeen[1].prompt).toContain('retry now')
  expect(optionsSeen[1].prompt).not.toContain(continuePrompt)
})

it('retires an aborted active turn and delivers the new user message normally', async () => {
  const seen: string[] = []
  const f = await fixture((options) => {
    seen.push(options.prompt)
    let end: (() => void) | undefined
    return {
      interrupt: async () => {
        end?.()
      },
      kill: () => {
        end?.()
      },
      async *[Symbol.asyncIterator]() {
        if (seen.length === 1)
          await new Promise<void>((resolve) => {
            end = resolve
          })
        yield { type: 'result', text: options.prompt, usage }
      },
    }
  })
  await f.call({ action: 'start', agent: 'claude-worker', task: 'cancel me', background: true })
  await until(() => seen.length === 1)
  const agent = (await f.children())[0]
  await f.call({ action: 'stop', id: agent.conversationId })
  expect(
    await f.call({ action: 'message', id: agent.conversationId, text: 'do something else' }),
  ).toContain('do something else')
  await until(() => seen.length === 2)
  expect(seen).toEqual(['cancel me', 'do something else'])
})

it('appends fresh input during crash recovery and marks both old and new turn keys handled', async () => {
  const f = await fixture()
  const sessions = new Sessions(join(f.root, 'recovery.sqlite'))
  cleanups.push(async () => sessions.close())
  const old = { role: 'user' as const, content: 'old turn', timestamp: 1 }
  const fresh = { role: 'user' as const, content: 'new recovery instruction', timestamp: 3 }
  const transcript = normalizeContext({
    messages: [
      old,
      fresh,
      {
        role: 'system',
        content: '',
        timestamp: 4,
        sections: {
          'claude-code-context': JSON.stringify({ cwd: f.root, instructions: '', conversation: 1 }),
        },
      },
    ],
  })
  sessions.put({
    id: 'recovery',
    cwd: f.root,
    handled: [],
    turn: {
      prompt: old.content,
      keys: userTurns(normalizeContext({ messages: [old] })).map((turn) => turn.key),
    },
  })
  const provider = createClaudeProvider(f.host, sessions, fake)
  await provider
    .streamSimple(provider.getModels()[0], transcript, { sessionId: 'recovery' })
    .result()
  expect(calls[0].prompt).toContain(continuePrompt)
  expect(calls[0].prompt).toContain('new recovery instruction')
  expect(sessions.get('recovery')?.handled).toEqual(userTurns(transcript).map((turn) => turn.key))
})

it('keeps the native Bash lock across MCP generations and a later exclusive Bash still waits', async () => {
  let bridged = false
  let acquiredSecond = false
  let proceed: (() => void) | undefined
  const f = await fixture((options) => ({
    interrupt: async () => {},
    kill: () => {},
    async *[Symbol.asyncIterator]() {
      const pre = options.hooks!.PreToolUse!.find((group) => group.matcher === 'Bash')!.hooks[0]
      const post = options.hooks!.PostToolUse!.find((group) => group.matcher === 'Bash')!.hooks[0]
      const bash = {
        hook_event_name: 'PreToolUse' as const,
        session_id: options.id,
        transcript_path: '',
        cwd: options.cwd,
        tool_name: 'Bash',
        tool_input: { command: 'heavy native' },
        tool_use_id: 'native-a',
      }
      await pre(bash, 'native-a', { signal: options.signal })
      const client = await mcpClient(options)
      try {
        await preCall(options, 'codemode', { code: 'return 42' }, 'lock-bridge')
        await client.callTool({ name: 'codemode', arguments: { code: 'return 42' } })
        expect(options.signal.aborted).toBe(false)
        await post(
          { ...bash, hook_event_name: 'PostToolUse', tool_response: {} },
          'unrelated-bash',
          { signal: options.signal },
        )
        expect(exclusiveSlot(f.host).command).toBe('heavy native')
        bridged = true
        await new Promise<void>((resolve) => {
          proceed = resolve
        })
        await post({ ...bash, hook_event_name: 'PostToolUse', tool_response: {} }, 'native-a', {
          signal: options.signal,
        })
        await pre(
          { ...bash, tool_use_id: 'native-b', tool_input: { command: 'heavy second' } },
          'native-b',
          { signal: options.signal },
        )
        acquiredSecond = true
        await post({ ...bash, hook_event_name: 'PostToolUse', tool_response: {} }, 'native-b', {
          signal: options.signal,
        })
        yield { type: 'result', text: 'LOCK OK', usage }
      } finally {
        await client.close()
      }
    },
  }))
  f.host.projectSettings = async () => ({ exclusiveCommands: ['heavy'] })
  f.prepared.registry.install(codemode(f.host))
  await f.call({ action: 'start', agent: 'claude-worker', task: 'locks', background: true })
  await until(() => bridged && !!proceed)
  const slot = exclusiveSlot(f.host)
  const external = slot.acquire('external heavy')
  expect(slot.queue).toHaveLength(1)
  proceed!()
  await external
  await until(() => slot.queue.length === 1)
  expect(slot.command).toBe('external heavy')
  expect(acquiredSecond).toBe(false)
  slot.release()
  const agent = (await f.children())[0]
  const child = await f.opened.harness.conversation(agent.conversationId, context)
  await child!.waitForIdle(context)
  expect(acquiredSecond).toBe(true)
  expect(slot.command).toBeUndefined()
})

it('does not threshold-compact Claude-managed context with very large aggregate usage', async () => {
  let compactions = 0
  const f = await fixture((options) => ({
    interrupt: async () => {},
    kill: () => {},
    async *[Symbol.asyncIterator]() {
      yield { type: 'tool', name: 'Bash', input: { command: 'x'.repeat(100000) } }
      yield { type: 'result', text: options.prompt, usage: { ...usage, cacheRead: 5000000 } }
    },
  }))
  f.prepared.registry.install(
    defineExtension({
      name: 'compaction-spy',
      hooks: [
        hook(CompactionTask, {
          beforeCompact: () => {
            compactions++
            return undefined
          },
        }),
      ],
    }),
  )
  expect(f.prepared.modelRuntime.getModels('claude-code')[0].contextWindow).toBe(0)
  await f.call({ action: 'start', agent: 'claude-worker', task: 'big context' })
  const agent = (await f.children())[0]
  expect(
    await f.call({ action: 'message', id: agent.conversationId, text: 'next turn' }),
  ).toContain('next turn')
  expect(compactions).toBe(0)
  const child = await f.opened.harness.conversation(agent.conversationId, context)
  const view = await child!.viewState(context)
  const last = view.value.entries.findLast((entry) => entry.kind === 'pi.assistant')!.model![0]
  expect(last.role === 'assistant' && Number.isFinite(last.usage.totalTokens)).toBe(true)
  view.dispose()
})

it('refuses a mismatched orphan, clears its pid, raises a notice, and proceeds with recovery', async () => {
  const f = await fixture()
  const child = spawn(process.execPath, [
    '-e',
    'setInterval(()=>{},1000)',
    '/tmp/claude-notes.txt',
    '--session-id',
    'wanted-session',
  ])
  const sessions = new Sessions(join(f.root, 'orphan.sqlite'))
  cleanups.push(async () => {
    child.kill('SIGKILL')
    sessions.close()
  })
  const notices: string[] = []
  f.host.notice = (text) => notices.push(text)
  sessions.put({
    id: 'wanted-session',
    cwd: f.root,
    handled: [],
    pid: child.pid,
    turn: { keys: [], prompt: 'original' },
  })
  const provider = createClaudeProvider(f.host, sessions, fake)
  const transcript = normalizeContext({
    messages: [
      {
        role: 'system',
        content: '',
        timestamp: 1,
        sections: {
          'claude-code-context': JSON.stringify({ cwd: f.root, instructions: '', conversation: 1 }),
        },
      },
    ],
  })
  const result = await provider
    .streamSimple(provider.getModels()[0], transcript, { sessionId: 'wanted-session' })
    .result()
  expect(result.stopReason).toBe('stop')
  expect(notices[0]).toContain('Refusing to kill')
  expect(sessions.get('wanted-session')?.pid).toBeUndefined()
  expect(() => process.kill(child.pid!, 0)).not.toThrow()
})

it.each([
  ['the SDK form', (id: string) => `claude --session-id=${id}`],
  ['separate arguments', (id: string) => `claude --resume ${id}`],
])(
  'kills only a Claude-looking orphan with matching recorded session arguments (%s)',
  async (_form, title) => {
    const id = 'matching-session'
    const child = spawn(process.execPath, [
      '-e',
      `process.title=${JSON.stringify(title(id))};setInterval(()=>{},1000)`,
    ])
    try {
      await until(() => {
        const command = execFileSync('ps', ['-p', String(child.pid), '-o', 'command='], {
          encoding: 'utf8',
        })
        return command.startsWith('claude --')
      })
      expect(killOrphan(child.pid!, 'different-session')).toContain('Refusing to kill')
      expect(() => process.kill(child.pid!, 0)).not.toThrow()
      const exited = once(child, 'exit')
      expect(killOrphan(child.pid!, id)).toBeUndefined()
      await exited
      expect(child.signalCode).toBe('SIGKILL')
    } finally {
      child.kill('SIGKILL')
    }
  },
)

it('correlates identical concurrent MCP requests FIFO and purges skipped hook ids at message boundaries', async () => {
  const bridge = new ToolBridge([
    { name: 'screenshot', description: '', parameters: Type.Object({}) },
  ])
  const options = {
    id: 'fifo',
    cwd: '.',
    signal: new AbortController().signal,
    hooks: bridge.hooks,
    mcpServers: { ultimate: bridge.server },
  }
  const client = await mcpClient(options)
  try {
    await preCall(options, 'screenshot', {}, 'skipped')
    bridge.prune(['first', 'second'])
    await preCall(options, 'screenshot', {}, 'first')
    await preCall(options, 'screenshot', {}, 'second')
    const first = client.callTool({ name: 'screenshot', arguments: {} })
    const second = client.callTool({ name: 'screenshot', arguments: {} })
    const a = await bridge.next()
    const b = await bridge.next()
    expect([a.id, b.id]).toEqual(['first', 'second'])
    for (const call of [b, a])
      bridge.resolve({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'result-' + call.id }],
        isError: false,
        timestamp: 1,
      })
    expect(await first).toMatchObject({ content: [{ text: 'result-first' }] })
    expect(await second).toMatchObject({ content: [{ text: 'result-second' }] })
    await preCall(options, 'screenshot', {}, 'denied')
    await bridge.hooks.PostToolUseFailure![0].hooks[0](
      {
        hook_event_name: 'PostToolUseFailure',
        session_id: 'fifo',
        transcript_path: '',
        cwd: '.',
        tool_name: 'mcp__ultimate__screenshot',
        tool_input: {},
        tool_use_id: 'denied',
        error: 'denied',
      },
      'denied',
      { signal: options.signal },
    )
    await preCall(options, 'screenshot', {}, 'after-denial')
    const next = client.callTool({ name: 'screenshot', arguments: {} })
    const call = await bridge.next()
    expect(call.id).toBe('after-denial')
    bridge.resolve({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [],
      isError: false,
      timestamp: 1,
    })
    await next
  } finally {
    await client.close()
  }
})

it('renders the final answer once instead of also copying text deltas into thinking', async () => {
  const f = await fixture(() => ({
    interrupt: async () => {},
    kill: () => {},
    async *[Symbol.asyncIterator]() {
      yield { type: 'text', text: 'UNIQUE FINAL ANSWER' }
      yield { type: 'result', text: 'UNIQUE FINAL ANSWER', usage }
    },
  }))
  await f.call({ action: 'start', agent: 'claude-worker', task: 'answer once' })
  const agent = (await f.children())[0]
  const child = await f.opened.harness.conversation(agent.conversationId, context)
  const view = await child!.viewState(context)
  const message = view.value.entries.findLast((entry) => entry.kind === 'pi.assistant')!.model![0]
  expect(JSON.stringify(message).match(/UNIQUE FINAL ANSWER/g)).toHaveLength(1)
  view.dispose()
})

it.each([false, true])(
  'excludes dangerous inherited tools but allows an explicit definition opt-in (%s)',
  async (explicit) => {
    let names: string[] = []
    const f = await fixture((options) => ({
      interrupt: async () => {},
      kill: () => {},
      async *[Symbol.asyncIterator]() {
        const client = await mcpClient(options)
        try {
          names = (await client.listTools()).tools.map((tool) => tool.name)
        } finally {
          await client.close()
        }
        yield { type: 'result', text: 'TOOLS CHECKED', usage }
      },
    }))
    f.prepared.registry.install(
      defineExtension({
        name: 'dangerous',
        tools: ['restart', 'land', 'discard'].map((name) =>
          defineTool({
            name,
            description: name,
            parameters: Type.Object({}),
            execute: async () => ({}),
          }),
        ),
      }),
    )
    if (explicit)
      await writeFile(
        join(f.root, 'agents/claude-worker.md'),
        '---\nname: claude-worker\ndescription: Work\nmodel: claude-code/haiku\nisolate: none\ntools: [restart, land, discard]\n---\nOpt in.\n',
      )
    await f.call({ action: 'start', agent: 'claude-worker', task: 'tools' })
    expect(names.filter((name) => ['restart', 'land', 'discard'].includes(name))).toEqual(
      explicit ? ['restart', 'land', 'discard'] : [],
    )
  },
)
