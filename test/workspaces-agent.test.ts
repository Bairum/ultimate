import { Type } from '@earendil-works/pi-ai'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask, defineTool, InboxDoc } from '@earendil-works/pi-durable'
import type { Conversation, JsonObject, TaskId, ToolExecutionApi } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { afterEach, expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { Metadata } from '../server/metadata.ts'
import { WorkspaceDoc, LifecycleQueue } from '../server/workspaces/doc.ts'
import { git } from '../server/workspaces/worktree.ts'
import * as worktree from '../server/workspaces/worktree.ts'
import workspaceExtension from '../extensions/workspaces/server.ts'
import self from '../extensions/self/server.ts'
import subagents, { Subagents } from '../extensions/subagents/server.ts'
import codemode from '../extensions/codemode/server.ts'
import { removeTemp, temp } from './helpers.ts'

const Gate = defineTask<null, { phase: 'hold' }, null>({
  name: 'test.workspace-agent-gate',
  version: 1,
  initial: () => ({ phase: 'hold' }),
  phases: {
    hold: async (_task, runtime, caller) => {
      await runtime.sleep(Date.now() + 60000, caller)
    },
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})
const directories: string[] = []
const hosts: OpenHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const host of hosts.splice(0)) await host.close()
  for (const directory of directories.splice(0)) await removeTemp(directory)
})
async function commit(path: string, file = 'change.txt') {
  await writeFile(join(path, file), `${file}\n`)
  await git(path, 'add', '.')
  await git(path, 'commit', '-m', file)
  return git(path, 'rev-parse', 'HEAD')
}
async function fixture(isolated = true) {
  const directory = await temp('ultimate-workspace-agent-')
  directories.push(directory)
  const source = join(directory, 'source')
  await mkdir(join(source, 'agents'), { recursive: true })
  await writeFile(
    join(source, 'agents/worker.md'),
    '---\nname: worker\ndescription: Work\nisolate: worktree\n---\nImplement.\n',
  )
  await git(source, 'init', '-b', 'release-candidate')
  await git(source, 'config', 'user.name', 'Test')
  await git(source, 'config', 'user.email', 'test@example.com')
  const base = await commit(source, 'base.txt')
  const prepared = await prepareHarness({
    ultimateRoot: source,
    projectRoot: source,
    home: join(directory, 'state'),
    userHome: directory,
    faux: true,
  })
  let opened: OpenHost
  const restart = vi.fn<ExtensionHost['restart']>(async () => 'Fake hook: no host swap')
  const host = {
    ...prepared,
    harness: () => opened.harness,
    metadata: Metadata,
    projectSettings: async () => ({}),
    restart,
    build: () => ({ id: 'fake-build' }),
    system: () => ({ process: { activationError: 'Fake activation failed' } }),
  } as unknown as ExtensionHost
  prepared.registry.install(CodingTools)
  prepared.registry.install(defineExtension({ name: 'workspace-agent-test', tasks: [Gate] }))
  prepared.registry.install(workspaceExtension(host))
  prepared.registry.install(self(host))
  prepared.registry.install(subagents(host))
  prepared.registry.install(codemode(host))
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    if (last.role === 'user' && text.startsWith('TOOL ')) {
      const { name, args } = JSON.parse(text.slice(5)) as { name: string; args: JsonObject }
      return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage('Finished')
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  hosts.push(opened)
  let main = opened.root
  if (isolated) {
    const workspace = await prepared.workspaces.describe(source, 'main', 'main-request')
    main = await opened.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { cwd: workspace.path, model: { provider: 'faux', modelId: 'faux-1' } },
      },
      context,
    )
    await opened.harness.commit(
      (tx) => prepared.workspaces.prepare(tx, main.id, workspace, 'main', 'main-request'),
      context,
    )
    await prepared.workspaces.ready(main.id, context)
  }
  const own = await prepared.workspaces.snapshot(main.id, context)
  const call = async (name: string, args: object, conversation?: Conversation) => {
    const target = conversation ?? main
    await (
      await target.submit(
        { type: 'input', content: `TOOL ${JSON.stringify({ name, args })}` },
        context,
      )
    ).wait(context)
    const view = await target.viewState(context)
    try {
      const result = view.value.entries.findLast((entry) => entry.kind === 'pi.tool-result')
        ?.model?.[0]
      if (result?.role !== 'toolResult') throw new Error('Missing tool result')
      return result
    } finally {
      view.dispose()
    }
  }
  const gate = async (conversation = main) =>
    opened.harness.commit(
      (tx) =>
        tx.createTask(Gate, null, {
          conversationId: conversation.id,
          ownership: { kind: 'conversation' },
          background: true,
        }),
      context,
    )
  const children = async () =>
    Object.values((await opened.harness.snapshot(Subagents, main.id, context))?.agents ?? {})
  const restartTool = self(host).tools![0]
  const apply = async (caller: TaskId, cwd = own!.path, conversation = main) => {
    const memo = vi.fn<ToolExecutionApi['memo']>(async () => undefined)
    const result = await restartTool.execute(
      { applyHost: true },
      {
        conversationId: conversation.id,
        taskId: caller,
        env: { cwd },
        memo,
      } as unknown as ToolExecutionApi,
      context,
    )
    return { result, memo }
  }
  const sibling = async () => {
    const workspace = await prepared.workspaces.describe(source, 'main', 'sibling-request')
    const conversation = await opened.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { cwd: workspace.path, model: { provider: 'faux', modelId: 'faux-1' } },
      },
      context,
    )
    await opened.harness.commit(
      (tx) =>
        prepared.workspaces.prepare(tx, conversation.id, workspace, 'main', 'sibling-request'),
      context,
    )
    await prepared.workspaces.ready(conversation.id, context)
    return { conversation, workspace }
  }
  const reopen = async () => {
    await opened.close()
    hosts.splice(hosts.indexOf(opened), 1)
    opened = await prepared.open()
    hosts.push(opened)
  }
  return {
    prepared,
    get opened() {
      return opened
    },
    host,
    source,
    base,
    main,
    own,
    restart,
    call,
    gate,
    children,
    apply,
    sibling,
    reopen,
  }
}
const textOf = (result: { content?: { type: string; text?: string }[] }) =>
  (result.content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')

it('lands verified child → isolated main → captured non-main source, then permits deliberate fake-only apply with replay/rollback', async () => {
  const f = await fixture()
  expect(
    textOf(await f.call('subagent', { action: 'start', agent: 'worker', task: 'finish' })),
  ).toContain('Isolate:')
  const child = (await f.children())[0]
  const workspace = (await f.prepared.workspaces.snapshot(child.conversationId, context))!
  expect(workspace.source).toBe(f.own!.path)
  const tip = await commit(workspace.path, 'worker.txt')
  expect(textOf(await f.call('subagent', { action: 'land', id: child.conversationId }))).toContain(
    tip,
  )
  expect(await readFile(join(f.own!.path, 'worker.txt'), 'utf8')).toBe('worker.txt\n')
  expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(f.base)
  const refused = await f.call('restart', { applyHost: true })
  expect(refused.isError).toBe(true)
  expect(textOf(refused)).toContain('has not been landed')
  expect(f.restart).not.toHaveBeenCalled()
  const landed = await f.call('workspace', { action: 'land' })
  expect(landed.isError).not.toBe(true)
  expect(textOf(landed)).toContain(tip)
  expect(await git(f.source, 'symbolic-ref', '--short', 'HEAD')).toBe('release-candidate')
  expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(tip)
  expect(
    JSON.parse(textOf(await f.call('workspace', { action: 'status' }))).workspace,
  ).toMatchObject({
    tip,
    sourceTip: tip,
    landed: tip,
    targetBranch: 'release-candidate',
    sourceBranch: 'release-candidate',
    currentBranch: f.own!.branch,
  })
  expect((await f.call('restart', {})).isError).toBe(true)
  expect(f.restart).not.toHaveBeenCalled()
  vi.stubEnv('ULTIMATE_GENERATION', '1')
  f.restart.mockImplementation(async (approved) => {
    await approved(2)
    return 'Fake hook: no host swap'
  })
  f.prepared.registry.install(
    defineExtension({
      name: 'apply-replay-test',
      tools: [
        {
          name: 'apply-replay',
          description: 'Test fake apply replay',
          parameters: { type: 'object', properties: {} },
          replay: 'safe',
          async execute(_args, api, caller) {
            const tool = self(f.host).tools![0]
            const first = await tool.execute({ applyHost: true }, api, caller)
            vi.stubEnv('ULTIMATE_GENERATION', '2')
            const replay = await tool.execute({ applyHost: true }, api, caller)
            vi.stubEnv('ULTIMATE_GENERATION', '1')
            const rollback = await tool.execute({ applyHost: true }, api, caller)
            return {
              content: [{ type: 'text', text: JSON.stringify({ first, replay, rollback }) }],
            }
          },
        },
      ],
    }),
  )
  const applied = JSON.parse(textOf(await f.call('apply-replay', {})))
  expect(applied.first.isError).toBe(true)
  expect(applied.replay.isError).not.toBe(true)
  expect(applied.replay.details).toMatchObject({ fromGeneration: 1, toGeneration: 2 })
  expect(applied.rollback.details).toMatchObject({
    rolledBack: true,
    error: 'Fake activation failed',
  })
  expect(f.restart).toHaveBeenCalledOnce()
})

it('uses distinct callId lifecycle requests for nested own lands sharing a taskId; replay does not merge again', async () => {
  const f = await fixture()
  const firstTip = await commit(f.own!.path)
  const create = vi.spyOn(f.prepared.workspaces, 'createLifecycle')
  const code =
    'const first = JSON.parse(await tools.workspace({action:"land"})); await tools.bash({command:"echo second > second.txt && git add second.txt && git commit -m second"}); const second = JSON.parse(await tools.workspace({action:"land"})); return {first, second};'
  const result = await f.call('codemode', { code })
  expect(result.isError).not.toBe(true)
  const value = (
    result.details as { value: { first: { landed: string }; second: { landed: string } } }
  ).value
  expect(value.first.landed).toBe(firstTip)
  expect(value.second.landed).not.toBe(firstTip)
  expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(value.second.landed)
  expect(create.mock.calls).toHaveLength(2)
  expect(create.mock.calls[0][4]).toEqual(create.mock.calls[1][4])
  expect(create.mock.calls[0][5]).not.toBe(create.mock.calls[1][5])
  const requests = (await f.opened.harness.snapshot(LifecycleQueue, context))!.requests
  expect(Object.keys(requests)).toHaveLength(2)
  const [, parent, child, operation, ownership, request] = create.mock.calls[0]
  const replay = await f.opened.harness.commit(
    (tx) => f.prepared.workspaces.createLifecycle(tx, parent, child, operation, ownership, request),
    context,
  )
  expect(replay).toBe(requests[request!])
  expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(value.second.landed)
})

it('nested worker lands and final own land share an orchestration task but never a lifecycle request', async () => {
  const f = await fixture()
  await f.call('subagent', { action: 'start', agent: 'worker', task: 'first' })
  await f.call('subagent', { action: 'start', agent: 'worker', task: 'second' })
  const [first, second] = await f.children()
  const a = (await f.prepared.workspaces.snapshot(first.conversationId, context))!
  const b = (await f.prepared.workspaces.snapshot(second.conversationId, context))!
  const firstTip = await commit(a.path, 'first.txt')
  await git(b.path, 'merge', '--ff-only', firstTip)
  const finalTip = await commit(b.path, 'second.txt')
  const create = vi.spyOn(f.prepared.workspaces, 'createLifecycle')
  const result = await f.call('codemode', {
    code: `const first = JSON.parse(await tools.subagent({action:'land', id:${first.conversationId}})); const second = JSON.parse(await tools.subagent({action:'land', id:${second.conversationId}})); const own = JSON.parse(await tools.workspace({action:'land'})); return {first,second,own};`,
  })
  expect(result.isError).not.toBe(true)
  expect((result.details as { value: unknown }).value).toMatchObject({
    first: { landed: firstTip },
    second: { landed: finalTip },
    own: { landed: finalTip },
  })
  expect(create.mock.calls).toHaveLength(3)
  expect(new Set(create.mock.calls.map((call) => call[5])).size).toBe(3)
  expect(create.mock.calls.map((call) => call[4])).toEqual(Array(3).fill(create.mock.calls[0][4]))
  expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(finalTip)
})

it('keeps shared main children → source flow and blocks worker self-land and worker host apply', async () => {
  const f = await fixture(false)
  expect(JSON.parse(textOf(await f.call('workspace', { action: 'status' }))).workspace).toBeNull()
  expect(textOf(await f.call('workspace', { action: 'land' }))).toContain('no workspace')
  await f.call('subagent', { action: 'start', agent: 'worker', task: 'finish' })
  const child = (await f.children())[0]
  const workspace = (await f.prepared.workspaces.snapshot(child.conversationId, context))!
  const tip = await commit(workspace.path)
  const conversation = (await f.opened.harness.conversation(child.conversationId, context))!
  expect(textOf(await f.call('workspace', { action: 'land' }, conversation))).toContain(
    'top-level main',
  )
  const caller = await f.gate(conversation)
  const refused = await f.apply(caller, workspace.path, conversation)
  expect(textOf(refused.result)).toContain('top-level main')
  expect(refused.memo).not.toHaveBeenCalled()
  expect(f.restart).not.toHaveBeenCalled()
  await expect(
    f.opened.harness.commit(
      (tx) =>
        f.prepared.workspaces.createLifecycle(
          tx,
          conversation.id,
          conversation.id,
          'land',
          { kind: 'task', taskId: caller },
          'worker-bypass',
        ),
      context,
    ),
  ).rejects.toThrow('top-level main')
  await f.opened.harness.abortTask(caller, context)
  expect(textOf(await f.call('subagent', { action: 'land', id: child.conversationId }))).toContain(
    tip,
  )
  expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(tip)
})

it.each([
  'dirty own',
  'dirty source',
  'diverged source',
  'other task',
  'queued input',
  'preview',
] as const)('own caller is exempt, but %s remains a landing blocker', async (blocker) => {
  const f = await fixture()
  const tip = await commit(f.own!.path)
  let release: (() => void) | undefined
  if (blocker === 'dirty own') await writeFile(join(f.own!.path, 'dirt'), 'dirty')
  if (blocker === 'dirty source') await writeFile(join(f.source, 'dirt'), 'dirty')
  if (blocker === 'diverged source') await commit(f.source, 'other.txt')
  if (blocker === 'other task') await f.gate()
  if (blocker === 'queued input')
    await f.opened.harness.commit(async (tx) => {
      const input = await tx.createSubmission({
        conversationId: f.opened.root.id,
        type: 'input',
        status: 'queued',
      })
      ;(await tx.doc(InboxDoc, f.opened.root.id)).items.push({
        id: input.id,
        mode: 'followUp',
        content: 'queued verification',
      })
    }, context)
  if (blocker === 'preview') release = await f.prepared.workspaces.hold(f.main.id, context)
  const sourceBefore = await git(f.source, 'rev-parse', 'HEAD')
  try {
    const result = await f.call('workspace', { action: 'land' })
    expect(result.isError).toBe(true)
    const reasons = {
      'dirty own': 'Worktree is dirty',
      'dirty source': 'Target checkout is dirty',
      'diverged source': 'Target moved or diverged',
      'other task': 'running or queued descendant work',
      'queued input': 'queued input',
      preview: 'active preview hold',
    }
    expect(textOf(result)).toContain(reasons[blocker])
    expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(sourceBefore)
    expect(await git(f.own!.path, 'rev-parse', 'HEAD')).toBe(tip)
    expect((await f.prepared.workspaces.snapshot(f.main.id, context))!.landed).toBeUndefined()
    expect(f.restart).not.toHaveBeenCalled()
  } finally {
    release?.()
  }
})

it.each([
  'unlanded',
  'new tip',
  'dirty own',
  'dirty source',
  'source moved',
  'own branch',
  'source branch',
  'detached target',
  'pending',
  'discarded',
  'wrong host',
  'wrong cwd',
  'unknown',
] as const)('refuses isolated apply before restart and memo effects: %s', async (condition) => {
  const f = await fixture()
  await commit(f.own!.path)
  if (condition !== 'unlanded') await f.call('workspace', { action: 'land' })
  const caller = await f.gate()
  if (condition === 'new tip') await commit(f.own!.path, 'new.txt')
  if (condition === 'dirty own') await writeFile(join(f.own!.path, 'dirty'), 'dirt')
  if (condition === 'dirty source') await writeFile(join(f.source, 'dirty'), 'dirt')
  if (condition === 'source moved') await commit(f.source, 'unverified.txt')
  if (condition === 'own branch') await git(f.own!.path, 'switch', '-c', 'wrong-own')
  if (condition === 'source branch') await git(f.source, 'switch', '-c', 'wrong-target')
  if (['detached target', 'pending', 'discarded', 'wrong host'].includes(condition))
    await f.opened.harness.commit(async (tx) => {
      const workspace = (await tx.doc(WorkspaceDoc, f.main.id)).workspace!
      if (condition === 'detached target') workspace.targetBranch = null
      if (condition === 'pending') workspace.preparation = 'pending'
      if (condition === 'discarded') workspace.state = 'discarded'
      if (condition === 'wrong host') workspace.source = f.own!.path
    }, context)
  if (condition === 'unknown')
    await f.opened.harness.commit(async (tx) => {
      delete (await tx.doc(WorkspaceDoc, f.main.id)).workspace
    }, context)
  const { result, memo } = await f.apply(caller, condition === 'wrong cwd' ? f.source : f.own!.path)
  expect(result).toMatchObject({ isError: true, details: { refused: true } })
  expect(memo).not.toHaveBeenCalled()
  expect(f.restart).not.toHaveBeenCalled()
})

it('rechecks proven landing at approval and never writes a memo for a source moved during preparation', async () => {
  const f = await fixture()
  await commit(f.own!.path)
  await f.call('workspace', { action: 'land' })
  const caller = await f.gate()
  f.restart.mockImplementation(async (approved) => {
    await commit(f.source, 'unverified.txt')
    try {
      await approved(2)
      return 'Unexpected approval'
    } catch (error) {
      return String(error)
    }
  })
  const { result, memo } = await f.apply(caller)
  expect(textOf(result)).toContain('Host source moved')
  expect(f.restart).toHaveBeenCalledOnce()
  expect(memo).toHaveBeenCalledTimes(1)
  expect(memo.mock.calls[0]).toHaveLength(2)
})

it('blocks a different actually running source conversation without exempting it alongside the own caller', async () => {
  const f = await fixture()
  const tip = await commit(f.own!.path)
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.prepared.registry.install(
    defineExtension({
      name: 'other-running-test',
      tools: [
        defineTool({
          name: 'other-running',
          description: 'Test actual active run',
          parameters: Type.Object({}),
          async execute() {
            enter()
            await held
            return { content: [{ type: 'text', text: 'released' }] }
          },
        }),
      ],
    }),
  )
  const other = f.call('other-running', {}, f.opened.root)
  await entered
  try {
    const result = await f.call('workspace', { action: 'land' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Child is running')
    expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(f.base)
    expect(await git(f.own!.path, 'rev-parse', 'HEAD')).toBe(tip)
  } finally {
    release()
    await other
  }
})

it('refreshes complete-workflow guidance for main, shared and fork callers without claiming historical landing is applied', async () => {
  const f = await fixture()
  const section = f.prepared.registry.snapshot().extension('workspaces')!.sections![0]
  const render = async (conversation: Conversation) =>
    section.render(
      { conversationId: conversation.id, agent: await conversation.agent(context) } as Parameters<
        typeof section.render
      >[0],
      context,
    )
  const initial = (await render(f.main))!
  expect(initial).toContain(f.source)
  expect(initial).toContain('captured branch: release-candidate')
  expect(initial).toContain('intermediate, not Done')
  expect(initial).toContain('workspace land')
  expect(initial).toContain('applyHost: true if authorized')
  expect(initial).toContain('supervisor-owned rollout')
  expect(initial).toContain('never claim Done at an intermediate workspace')
  await commit(f.own!.path)
  await f.call('workspace', { action: 'land' })
  expect(await render(f.main)).toContain('(historical, not proof of current application)')
  expect(await render(f.opened.root)).toContain('There is no own workspace to land')
  const view = await f.main.viewState(context)
  const at = view.value.entries.at(-1)!.id
  view.dispose()
  const fork = await f.main.fork(at, { ownership: { kind: 'ownerless' } }, context)
  expect(await render(fork)).toBeUndefined()
  expect(textOf(await f.call('workspace', { action: 'land' }, fork))).toContain('top-level main')
  const caller = await f.gate(fork)
  const { result, memo } = await f.apply(caller, f.own!.path, fork)
  expect(textOf(result)).toContain('top-level main')
  expect(memo).not.toHaveBeenCalled()
  expect(f.restart).not.toHaveBeenCalled()
})

it('refuses a same-source sibling landing paused immediately before FF, even while current host tip still matches', async () => {
  const f = await fixture()
  const tip = await commit(f.own!.path)
  await f.call('workspace', { action: 'land' })
  const sibling = await f.sibling()
  const siblingTip = await commit(sibling.workspace.path, 'sibling.txt')
  const realGit = worktree.git
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(worktree, 'git').mockImplementation(async (cwd, ...args) => {
    if (cwd === f.source && args[0] === 'merge' && args[1] === '--ff-only') {
      enter()
      await paused
    }
    return realGit(cwd, ...args)
  })
  const landing = f.prepared.workspaces.runLifecycle(
    sibling.conversation.id,
    sibling.conversation.id,
    'land',
    context,
  )
  await entered
  try {
    expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(tip)
    const caller = await f.gate()
    const { result, memo } = await f.apply(caller)
    expect(textOf(result)).toContain('pending workspace mutation')
    expect(result.isError).toBe(true)
    expect(memo).not.toHaveBeenCalled()
    expect(f.restart).not.toHaveBeenCalled()
    expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(tip)
  } finally {
    release()
    await landing
  }
  expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(siblingTip)
})

it('reserves source and own checkout against new sibling mutations and execution admission throughout preparation and memo approval', async () => {
  const f = await fixture()
  const tip = await commit(f.own!.path)
  await f.call('workspace', { action: 'land' })
  const sibling = await f.sibling()
  await commit(sibling.workspace.path, 'sibling.txt')
  const caller = await f.gate()
  const execute = vi.fn<() => Promise<void>>(async () => {})
  const blocked = async () => {
    await expect(
      f.prepared.workspaces.withAdmission(f.opened.root.id, execute, context),
    ).rejects.toThrow('Host apply reservation')
    await expect(f.prepared.workspaces.withAdmission(f.main.id, execute, context)).rejects.toThrow(
      'Host apply reservation',
    )
    await expect(
      f.prepared.workspaces.runLifecycle(
        sibling.conversation.id,
        sibling.conversation.id,
        'land',
        context,
      ),
    ).rejects.toThrow('Host apply reservation')
    expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(tip)
  }
  f.restart.mockImplementation(async (approved) => {
    await blocked()
    await approved(2)
    expect((await f.opened.harness.snapshot(LifecycleQueue, context))!.hostApply).toMatchObject({
      caller,
      tip,
      handoff: true,
    })
    await blocked()
    return 'Fake preparation failure; no swap'
  })
  const { result, memo } = await f.apply(caller)
  expect(textOf(result)).toContain('Fake preparation failure')
  expect(memo).toHaveBeenCalledTimes(2)
  expect(execute).not.toHaveBeenCalled()
  expect((await f.opened.harness.snapshot(LifecycleQueue, context))!.hostApply).toBeUndefined()
  await f.prepared.workspaces.withAdmission(f.opened.root.id, execute, context)
  expect(execute).toHaveBeenCalledOnce()
})

it('keeps the pinned reservation across storage reopen and releases it through resumed proof', async () => {
  const f = await fixture()
  const tip = await commit(f.own!.path)
  await f.call('workspace', { action: 'land' })
  const caller = await f.gate()
  const proof = await f.prepared.workspaces.proveHostLanding(
    f.main.id,
    caller,
    f.own!.path,
    context,
  )
  await proof.checkpoint(context)
  await f.reopen()
  const execute = vi.fn<() => Promise<void>>(async () => {})
  await expect(
    f.prepared.workspaces.withAdmission(f.opened.root.id, execute, context),
  ).rejects.toThrow('Host apply reservation')
  const resumed = await f.prepared.workspaces.proveHostLanding(
    f.main.id,
    caller,
    f.own!.path,
    context,
  )
  expect(resumed.tip).toBe(tip)
  await resumed.recheck(context)
  await resumed.release(context)
  await f.prepared.workspaces.withAdmission(f.opened.root.id, execute, context)
  expect(execute).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'cancellation releases pre-approval reservation; approved handoff stays pinned until reopen (approved: %s)',
  async (approved) => {
    const f = await fixture()
    await commit(f.own!.path)
    await f.call('workspace', { action: 'land' })
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    f.restart.mockImplementation(async (approve) => {
      if (approved) await approve(2)
      enter()
      return new Promise<string>(() => {})
    })
    const input = await f.main.submit(
      { type: 'input', content: 'TOOL {"name":"restart","args":{"applyHost":true}}' },
      context,
    )
    await entered
    await f.main.abort(context)
    await input.wait(context)
    await f.main.waitForIdle(context)
    const lease = (await f.opened.harness.snapshot(LifecycleQueue, context))!.hostApply
    expect(lease?.handoff).toBe(approved ? true : undefined)
    const execute = vi.fn<() => Promise<void>>(async () => {})
    const admission = await f.prepared.workspaces
      .withAdmission(f.opened.root.id, execute, context)
      .then(
        () => true,
        (error: Error) => error.message,
      )
    expect(admission).toBe(
      approved ? 'Host apply reservation is in progress; execution admission is blocked' : true,
    )
    expect(execute).toHaveBeenCalledTimes(approved ? 0 : 1)
    if (approved) await f.reopen()
    expect((await f.opened.harness.snapshot(LifecycleQueue, context))!.hostApply).toBeUndefined()
  },
)
