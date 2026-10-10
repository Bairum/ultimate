import { spawn } from 'node:child_process'
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
import { normalizeContext } from '@earendil-works/pi-ai'
import type { Automation } from '../extensions/automations/server.ts'
import { ProjectTrustStore, resolveCliModel } from '@earendil-works/pi-coding-agent'
import {
  claudeCode,
  continuePrompt,
  createClaudeProvider,
  userTurns,
} from '../extensions/claude-code/server.ts'
import { Sessions } from '../extensions/claude-code/sessions.ts'
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
