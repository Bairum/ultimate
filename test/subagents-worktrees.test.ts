import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { projectSettings } from '../server/project-setup.ts'
import { mkdir, readFile, writeFile, access, symlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, defineExtension, defineTask, LiveDoc } from '@earendil-works/pi-durable'
import type { TaskId, ConversationId, EntryId, TaskDefinition } from '@earendil-works/pi-durable'
import { lifecycle } from '../server/workspaces/lifecycle.ts'
import { LifecycleQueue } from '../server/workspaces/doc.ts'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { afterEach, expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { ActionContext } from '../server/actions.ts'
import subagents, { actions, Subagents } from '../extensions/subagents/server.ts'
import { create, git, discard } from '../server/workspaces/worktree.ts'
import { temp, removeTemp, until } from './helpers.ts'

const Gate = defineTask<null, { phase: 'hold' }, null>({
  name: 'test.lifecycle-gate',
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
const directories: string[] = []
const hosts: OpenHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
  for (const path of directories.splice(0)) await removeTemp(path)
})
async function fixture() {
  const root = await temp('ultimate-worktrees-')
  directories.push(root)
  const project = join(root, 'project')
  await mkdir(join(project, 'agents'), { recursive: true })
  await writeFile(
    join(project, 'agents/worker.md'),
    '---\nname: worker\ndescription: Work\nisolate: worktree\n---\nImplement.\n',
  )
  await writeFile(join(project, 'conflict.txt'), 'base\n')
  await git(project, 'init', '-b', 'main')
  await git(project, 'config', 'user.email', 'test@example.com')
  await git(project, 'config', 'user.name', 'Test')
  await git(project, 'add', '.')
  await git(project, 'commit', '-m', 'base')
  const home = join(root, 'home')
  const prepared = await prepareHarness({
    ultimateRoot: project,
    projectRoot: project,
    home,
    userHome: root,
    faux: true,
  })
  prepared.registry.install(CodingTools)
  prepared.registry.install(defineExtension({ name: 'lifecycle-test', tasks: [Gate] }))
  let opened: OpenHost
  prepared.registry.install(
    subagents({
      projectSettings: () => projectSettings(project, root),
      ...prepared,
      harness: () => opened.harness,
      metadata: Metadata,
    }),
  )
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    if (last.role === 'user' && text.startsWith('CALL '))
      return fauxAssistantMessage([fauxToolCall('subagent', JSON.parse(text.slice(5)))], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && text === 'write')
      return fauxAssistantMessage(
        [fauxToolCall('write', { path: 'child.txt', content: 'child\n' })],
        { stopReason: 'toolUse' },
      )
    if (last.role === 'user' && text === 'slow')
      return fauxAssistantMessage([fauxText('Working '.repeat(700))])
    return fauxAssistantMessage([fauxText('Finished')])
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  hosts.push(opened)
  const call = async (args: object) => {
    await (
      await opened.root.submit({ type: 'input', content: `CALL ${JSON.stringify(args)}` }, context)
    ).wait(context)
    const view = await opened.root.viewState(context)
    const result = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
      ?.model?.[0]
    view.dispose()
    if (result?.role !== 'toolResult') throw new Error('Missing tool result')
    return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
  const children = async () =>
    Promise.all(
      Object.values(
        (await opened.harness.snapshot(Subagents, opened.root.id, context))?.agents ?? {},
      ).map(async (child) => ({
        ...child,
        workspace: await prepared.workspaces.snapshot(child.conversationId, context),
      })),
    )
  return {
    project,
    home,
    prepared,
    get opened() {
      return opened
    },
    set opened(value: OpenHost) {
      opened = value
    },
    call,
    children,
  }
}
it.each([false, true])(
  'isolates writes, lands once, refuses divergence without mutation and discards while retaining commits (fork: %s)',
  async (fork) => {
    const f = await fixture()
    expect(await f.call({ action: 'start', agent: 'worker', task: 'write', fork })).toContain(
      'Isolate:',
    )
    const child = (await f.children())[0]
    const workspace = child.workspace!
    expect(await readFile(join(workspace.path, 'child.txt'), 'utf8')).toBe('child\n')
    await expect(access(join(f.project, 'child.txt'))).rejects.toThrow('ENOENT')
    expect(await f.call({ action: 'land', id: child.conversationId })).toContain(
      'Worktree is dirty:',
    )
    expect(await f.call({ action: 'land', id: child.conversationId })).toContain('child.txt')
    await git(workspace.path, 'add', '.')
    await git(workspace.path, 'commit', '-m', 'child change')
    expect(await f.call({ action: 'land', id: child.conversationId })).toContain('Landed commits')
    expect(await readFile(join(f.project, 'child.txt'), 'utf8')).toBe('child\n')
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(
      await git(workspace.path, 'rev-parse', 'HEAD'),
    )
    expect(await f.call({ action: 'land', id: child.conversationId })).toContain('Nothing to land')
    await writeFile(join(workspace.path, 'conflict.txt'), 'child\n')
    await git(workspace.path, 'add', '.')
    await git(workspace.path, 'commit', '-m', 'child conflict')
    await writeFile(join(f.project, 'conflict.txt'), 'parent\n')
    await git(f.project, 'add', '.')
    await git(f.project, 'commit', '-m', 'parent conflict')
    expect(await f.call({ action: 'land', id: child.conversationId })).toContain(
      'Target moved or diverged',
    )
    expect(await git(workspace.path, 'status', '--porcelain')).toBe('')
    expect(await git(f.project, 'status', '--porcelain')).toBe('')
    expect(await f.call({ action: 'discard', id: child.conversationId })).toContain(
      `kept branch ${workspace.branch}`,
    )
    await expect(access(workspace.path)).rejects.toThrow('ENOENT')
    expect(await git(f.project, 'branch', '--list', workspace.branch)).toContain(workspace.branch)
    expect((await f.children())[0].workspace?.state).toBe('discarded')
    expect(
      await f.call({ action: 'message', id: child.conversationId, text: 'inspect' }),
    ).toContain("Child's worktree was discarded; start a new child")
  },
)
it('replays an interrupted start with the same child and worktree', async () => {
  const f = await fixture()
  await f.opened.root.submit(
    { type: 'input', content: 'CALL {"action":"start","agent":"worker","task":"slow"}' },
    context,
  )
  await until(async () => {
    const [child] = await f.children()
    return (
      child !== undefined &&
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run !== undefined
    )
  })
  const before = (await f.children())[0]
  await f.opened.close()
  hosts.splice(hosts.indexOf(f.opened), 1)
  f.opened = await f.prepared.open()
  hosts.push(f.opened)
  await f.opened.root.waitForIdle(context)
  expect(await f.children()).toHaveLength(1)
  expect((await f.children())[0]).toEqual({ ...before, reported: expect.any(Array) })
  expect((await f.children())[0].reported).toHaveLength(1)
  const index = (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!
  const call = Object.keys(index.actions)[0]
  expect((await create(f.project, f.home, 'worker', call)).record).toEqual(before.workspace)
}, 20000)
it('lets the call override the definition isolate and reports omitted parent changes', async () => {
  const f = await fixture()
  await f.call({ action: 'start', agent: 'worker', task: 'inspect', isolate: 'none' })
  expect((await f.children())[0].workspace).toBeUndefined()
  await writeFile(join(f.project, 'uncommitted.txt'), 'parent only')
  expect(await f.call({ action: 'start', agent: 'worker', task: 'inspect' })).toContain(
    'parent has uncommitted changes',
  )
  const isolate = (await f.children())[1].workspace!
  await expect(access(join(isolate.path, 'uncommitted.txt'))).rejects.toThrow('ENOENT')
})
it('refuses lifecycle operations while the child is running', async () => {
  const f = await fixture()
  await f.call({ action: 'start', agent: 'worker', task: 'slow', background: true })
  const [child] = await f.children()
  expect(await f.call({ action: 'land', id: child.conversationId })).toContain('Child is running')
  expect(await f.call({ action: 'discard', id: child.conversationId })).toContain(
    'Child is running',
  )
  await f.call({ action: 'stop', id: child.conversationId })
  expect(await f.call({ action: 'discard', id: child.conversationId })).toContain('kept branch')
})
it('persists one background preparation failure report across reopen without submitting child model input', async () => {
  const f = await fixture()
  new ProjectTrustStore(join(f.prepared.userHome, '.ultimate')).set(f.project, true)
  await mkdir(join(f.project, '.ultimate'))
  await writeFile(
    join(f.project, '.ultimate/settings.json'),
    JSON.stringify({
      isolates: { worktree: { setup: ['echo background-setup-failed >&2; exit 1'] } },
    }),
  )
  const gate = await f.opened.harness.commit(
    (tx) =>
      tx.createTask(Gate, null, {
        conversationId: f.opened.root.id,
        ownership: { kind: 'conversation' },
        background: true,
      }),
    context,
  )
  const phases = f.prepared.registry
    .snapshot()
    .extension('subagents')!
    .tasks!.find((task) => task.definition.name === 'ultimate.subagent-reporter')!.definition
    .phases as TaskDefinition<
    { conversationId: ConversationId; text: string; steer: boolean },
    { phase: 'deliver' } | { phase: 'report'; report?: string; answer?: EntryId },
    null,
    object
  >['phases']
  const delayed = vi.spyOn(phases, 'report').mockImplementationOnce(async (task, runtime, ctx) => {
    await runtime.commit(
      () => ({
        status: 'waiting',
        on: [gate],
        policy: 'allSettled',
        checkpoint: task.state.checkpoint,
      }),
      ctx,
    )
  })
  await f.call({
    action: 'start',
    agent: 'worker',
    task: 'must not reach the child model',
    background: true,
  })
  const child = (await f.children())[0]
  const reporter = Object.values(
    (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.actions,
  )[0].reporter!
  await until(
    async () => (await f.opened.harness.getTask(reporter, context))?.state.status === 'waiting',
  )
  expect((await f.opened.harness.getTask(reporter, context))!.state).toMatchObject({
    checkpoint: { phase: 'report', report: expect.stringContaining('background-setup-failed') },
  })
  expect((await f.prepared.workspaces.snapshot(child.conversationId, context))!.preparation).toBe(
    'error',
  )
  expect(
    Object.values(
      (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.actions,
    )[0].status,
  ).toBe('failed')
  delayed.mockRestore()
  await f.opened.close()
  hosts.splice(hosts.indexOf(f.opened), 1)
  f.opened = await f.prepared.open()
  hosts.push(f.opened)
  await f.opened.harness.abortTask(gate, context)
  expect((await f.opened.harness.waitForTask(reporter, context)).state.outcome.status).toBe(
    'completed',
  )
  await f.opened.root.waitForIdle(context)
  await f.opened.close()
  hosts.splice(hosts.indexOf(f.opened), 1)
  f.opened = await f.prepared.open()
  hosts.push(f.opened)
  const parentView = await f.opened.root.viewState(context)
  expect(
    parentView.value.entries.filter(
      (entry) =>
        entry.kind === 'pi.user' &&
        JSON.stringify(entry.model).includes(`[subagent ${child.conversationId} failed:`),
    ),
  ).toHaveLength(1)
  parentView.dispose()
  const childView = await (await f.opened.harness.conversation(
    child.conversationId,
    context,
  ))!.viewState(context)
  expect(childView.value.entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(0)
  childView.dispose()
})
it.each(['pending', 'failed'] as const)(
  'explicit child stop during %s preparation suppresses the reporter across failure and reopen',
  async (phase) => {
    const f = await fixture()
    new ProjectTrustStore(join(f.prepared.userHome, '.ultimate')).set(f.project, true)
    await mkdir(join(f.project, '.ultimate'))
    const release = join(f.home, 'release-failed-setup')
    await writeFile(
      join(f.project, '.ultimate/settings.json'),
      JSON.stringify({
        isolates: {
          worktree: {
            setup: [
              `while [ ! -f '${release}' ]; do sleep 0.05; done; echo stopped-setup-failed >&2; exit 1`,
            ],
          },
        },
      }),
    )
    const gate = await f.opened.harness.commit(
      (tx) =>
        tx.createTask(Gate, null, {
          conversationId: f.opened.root.id,
          ownership: { kind: 'conversation' },
          background: true,
        }),
      context,
    )
    const phases = f.prepared.registry
      .snapshot()
      .extension('subagents')!
      .tasks!.find((task) => task.definition.name === 'ultimate.subagent-reporter')!.definition
      .phases as TaskDefinition<
      { conversationId: ConversationId; text: string; steer: boolean },
      { phase: 'deliver' } | { phase: 'report'; report?: string; answer?: EntryId },
      null,
      object
    >['phases']
    const delayed = vi
      .spyOn(phases, 'report')
      .mockImplementationOnce(async (task, runtime, ctx) => {
        await runtime.commit(
          () => ({
            status: 'waiting',
            on: [gate],
            policy: 'allSettled',
            checkpoint: task.state.checkpoint,
          }),
          ctx,
        )
      })
    await f.call({
      action: 'start',
      agent: 'worker',
      task: 'never deliver this input',
      background: true,
    })
    const child = (await f.children())[0]
    const reporter = Object.values(
      (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.actions,
    )[0].reporter!
    if (phase === 'failed') {
      await writeFile(release, '')
      await until(
        async () => (await f.opened.harness.getTask(reporter, context))?.state.status === 'waiting',
      )
    }
    expect((await f.prepared.workspaces.snapshot(child.conversationId, context))!.preparation).toBe(
      phase === 'pending' ? 'pending' : 'error',
    )
    expect((await f.opened.harness.getTask(reporter, context))!.state).toMatchObject({
      checkpoint: { phase: phase === 'pending' ? 'deliver' : 'report' },
    })
    expect(await f.call({ action: 'stop', id: child.conversationId })).toContain(
      `Stopped ${child.conversationId}`,
    )
    expect((await f.opened.harness.waitForTask(reporter, context)).state.outcome.status).toBe(
      'aborted',
    )
    await writeFile(release, '')
    await until(
      async () =>
        (await f.prepared.workspaces.snapshot(child.conversationId, context))?.preparation ===
        'error',
    )
    expect(delayed).toHaveBeenCalledTimes(phase === 'pending' ? 0 : 1)
    delayed.mockRestore()
    await f.opened.harness.abortTask(gate, context)
    await f.opened.close()
    hosts.splice(hosts.indexOf(f.opened), 1)
    f.opened = await f.prepared.open()
    hosts.push(f.opened)
    await f.opened.root.waitForIdle(context)
    const parentView = await f.opened.root.viewState(context)
    expect(
      parentView.value.entries.filter(
        (entry) =>
          entry.kind === 'pi.user' &&
          JSON.stringify(entry.model).includes(`[subagent ${child.conversationId} failed:`),
      ),
    ).toHaveLength(0)
    parentView.dispose()
    const childView = await (await f.opened.harness.conversation(
      child.conversationId,
      context,
    ))!.viewState(context)
    expect(childView.value.entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(0)
    childView.dispose()
    expect(
      Object.values(
        (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.actions,
      )[0].status,
    ).toBe('unanswered')
  },
)
it('runs setup once with source env and removes a failed worktree', async () => {
  const f = await fixture()
  await mkdir(join(f.project, '.ultimate'))
  const settings = join(f.project, '.ultimate/settings.json')
  await writeFile(
    settings,
    JSON.stringify({
      isolates: {
        worktree: {
          setup: [
            'printf "%s" "$ULTIMATE_SOURCE" > source.txt',
            'echo run >> "$ULTIMATE_SOURCE/runs.txt"',
          ],
        },
      },
    }),
  )
  const userHome = join(f.home, '..')
  const readSettings = () => projectSettings(f.project, userHome)
  await writeFile(settings, JSON.stringify({ isolates: { worktree: { setup: ['touch PWNED'] } } }))
  const untrusted = await create(f.project, f.home, 'worker', 'untrusted', readSettings)
  await expect(access(join(untrusted.cwd, 'PWNED'))).rejects.toThrow('ENOENT')
  new ProjectTrustStore(join(userHome, '.ultimate')).set(f.project, true)
  const trusted = await create(f.project, f.home, 'worker', 'trusted', readSettings)
  await access(join(trusted.cwd, 'PWNED'))
  await writeFile(
    settings,
    JSON.stringify({
      isolates: {
        worktree: {
          setup: [
            'printf "%s" "$ULTIMATE_SOURCE" > source.txt',
            'echo run >> "$ULTIMATE_SOURCE/runs.txt"',
          ],
        },
      },
    }),
  )
  const { record: workspace } = await create(f.project, f.home, 'worker', 'setup', readSettings)
  expect(await readFile(join(workspace.path, 'source.txt'), 'utf8')).toBe(f.project)
  expect((await create(f.project, f.home, 'worker', 'setup', readSettings)).record).toEqual(
    workspace,
  )
  expect(await readFile(join(f.project, 'runs.txt'), 'utf8')).toBe('run\n')
  await writeFile(
    settings,
    JSON.stringify({ isolates: { worktree: { setup: ['echo setup-broken >&2; exit 1'] } } }),
  )
  const before = await git(f.project, 'worktree', 'list', '--porcelain')
  await expect(create(f.project, f.home, 'worker', 'failed', readSettings)).rejects.toThrow(
    'setup-broken',
  )
  // Clean failed setup is removed without force; its branch is retained.
  expect(await git(f.project, 'worktree', 'list', '--porcelain')).toBe(before)
})
it('reads an isolate with its commits ahead of the parent for the Agents tab', async () => {
  const f = await fixture()
  await f.call({ action: 'start', agent: 'worker', task: 'write' })
  await f.call({ action: 'start', agent: 'worker', task: 'inspect', isolate: 'none' })
  const [child, plain] = await f.children()
  const parent = f.opened.root.id
  const ctx = {
    host: {
      projectRoot: f.project,
      ultimateRoot: f.project,
      harness: () => f.opened.harness,
      workspaces: f.prepared.workspaces,
    },
  } as unknown as ActionContext
  const read = () => actions.isolate({ parent, id: child.conversationId }, ctx)
  expect(await actions.isolate({ parent, id: plain.conversationId }, ctx)).toBeNull()
  await expect(actions.isolate({ id: child.conversationId }, ctx)).rejects.toThrow('required')
  expect(await read()).toEqual({ ...child.workspace, ahead: 0 })
  await git(child.workspace!.path, 'add', '.')
  await git(child.workspace!.path, 'commit', '-m', 'child change')
  expect(await read()).toEqual({ ...child.workspace, ahead: 1 })
  const landed = await actions.land(
    { id: child.conversationId },
    { ...ctx, conversationId: parent },
  )
  expect(await read()).toEqual({ ...child.workspace, landed: landed.landed, ahead: 0 })
  await actions.discard({ id: child.conversationId }, { ...ctx, conversationId: parent })
  await git(f.project, 'branch', '-D', child.workspace!.branch)
  expect(await read()).toMatchObject({ state: 'discarded', ahead: null })
})

it('rechecks queued lifecycle operations and refuses messages during land', async () => {
  const f = await fixture()
  await f.call({ action: 'start', agent: 'worker', task: 'write' })
  await f.call({ action: 'start', agent: 'worker', task: 'inspect' })
  const [first, second] = await f.children()
  await git(first.workspace!.path, 'add', '.')
  await git(first.workspace!.path, 'commit', '-m', 'child change')
  const hook = join(
    await git(f.project, 'rev-parse', '--absolute-git-dir'),
    'hooks/reference-transaction',
  )
  const entered = join(f.home, 'entered')
  const release = join(f.home, 'release')
  await writeFile(
    hook,
    `#!/bin/sh\ntouch '${entered}'\nwhile [ ! -f '${release}' ]; do sleep 0.05; done\n`,
  )
  await chmod(hook, 0o755)
  const ctx = {
    host: {
      projectRoot: f.project,
      ultimateRoot: f.project,
      harness: () => f.opened.harness,
      workspaces: f.prepared.workspaces,
    },
    conversationId: f.opened.root.id,
  } as unknown as ActionContext
  const waitingHook = await readFile(hook, 'utf8')
  await writeFile(hook, '#!/bin/sh\necho original-hook-failure >&2\nexit 1\n')
  await expect(actions.land({ id: first.conversationId }, ctx)).rejects.toThrow(
    'original-hook-failure',
  )
  await writeFile(hook, waitingHook)
  const landing = actions.land({ id: first.conversationId }, ctx)
  await until(async () =>
    access(entered).then(
      () => true,
      () => false,
    ),
  )
  expect(await f.call({ action: 'message', id: first.conversationId, text: 'inspect' })).toContain(
    'lifecycle operation is in progress',
  )
  const dropping = actions.discard({ id: second.conversationId }, ctx)
  const refused = dropping.catch((error: Error) => error)
  const child = (await f.opened.harness.conversation(second.conversationId, context))!
  await child.submit({ type: 'input', content: 'slow' }, context)
  await until(
    async () => !!(await f.opened.harness.snapshot(LiveDoc, second.conversationId, context))?.run,
  )
  await writeFile(release, '')
  await landing
  expect(await refused).toMatchObject({ message: 'Child is running; wait or stop it first' })
  await access(second.workspace!.path)
  await child.abort(context)
})
async function holdCheckout(f: Awaited<ReturnType<typeof fixture>>) {
  return f.opened.harness.commit(async (tx) => {
    const queueOwner = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, queueOwner.id, { cwd: f.home })
    const gate = await tx.createTask(Gate, null, {
      conversationId: queueOwner.id,
      ownership: { kind: 'conversation' },
      background: true,
    })
    ;(await tx.doc(LifecycleQueue)).checkouts[f.project] = gate
    return gate
  }, context)
}
function lifecycleContext(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    host: {
      projectRoot: f.project,
      ultimateRoot: f.project,
      harness: () => f.opened.harness,
      workspaces: f.prepared.workspaces,
    },
    conversationId: f.opened.root.id,
  } as unknown as ActionContext
}
it('resumes a queued land after closing the harness and reopening its store', async () => {
  const f = await fixture()
  await f.call({ action: 'start', agent: 'worker', task: 'write' })
  const [child] = await f.children()
  await git(child.workspace!.path, 'add', '.')
  await git(child.workspace!.path, 'commit', '-m', 'durable child')
  const tip = await git(child.workspace!.path, 'rev-parse', 'HEAD')
  const gate = await holdCheckout(f)
  const landing = actions
    .land({ id: child.conversationId }, lifecycleContext(f))
    .catch(() => undefined)
  let task: TaskId = gate
  await until(async () => {
    task = (await f.opened.harness.snapshot(LifecycleQueue, context))!.checkouts[f.project]
    return (
      task !== gate && (await f.opened.harness.getTask(task, context))?.state.status === 'waiting'
    )
  })
  await f.opened.close()
  await landing
  hosts.splice(hosts.indexOf(f.opened), 1)
  f.opened = await f.prepared.open()
  hosts.push(f.opened)
  await f.opened.harness.abortTask(gate, context)
  const outcome = (await f.opened.harness.waitForTask(task, context)).state.outcome
  expect(outcome.status).toBe('completed')
  expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(tip)
  expect((await f.children())[0].workspace?.landed).toBe(tip)
})
it('queues two lands on the same checkout with the second waiting on the first', async () => {
  const f = await fixture()
  await f.call({ action: 'start', agent: 'worker', task: 'inspect' })
  await f.call({ action: 'start', agent: 'worker', task: 'inspect' })
  const children = await f.children()
  for (const [i, child] of children.entries()) {
    await writeFile(join(child.workspace!.path, `land-${i}.txt`), `${i}`)
    await git(child.workspace!.path, 'add', '.')
    await git(child.workspace!.path, 'commit', '-m', `land ${i}`)
  }
  const gate = await holdCheckout(f)
  const first = actions.land({ id: children[0].conversationId }, lifecycleContext(f))
  let firstTask: TaskId = gate
  await until(async () => {
    firstTask = (await f.opened.harness.snapshot(LifecycleQueue, context))!.checkouts[f.project]
    return (
      firstTask !== gate &&
      (await f.opened.harness.getTask(firstTask, context))?.state.status === 'waiting'
    )
  })
  const second = actions
    .land({ id: children[1].conversationId }, lifecycleContext(f))
    .catch((error: Error) => error)
  let secondTask: TaskId = gate
  await until(async () => {
    secondTask = (await f.opened.harness.snapshot(LifecycleQueue, context))!.checkouts[f.project]
    return (
      secondTask !== firstTask &&
      secondTask !== gate &&
      (await f.opened.harness.getTask(secondTask, context))?.state.status === 'waiting'
    )
  })
  expect((await f.opened.harness.getTask(secondTask, context))?.state).toMatchObject({
    on: [firstTask],
    policy: 'allSettled',
  })
  expect(
    await f.call({ action: 'message', id: children[1].conversationId, text: 'inspect' }),
  ).toContain('lifecycle operation is in progress')
  await f.opened.harness.abortTask(gate, context)
  expect((await first).text).toContain('Landed commits')
  expect(await second).toMatchObject({
    message: expect.stringContaining('Target moved or diverged'),
  })
  await git(children[1].workspace!.path, 'rebase', 'main')
  expect(
    (await actions.land({ id: children[1].conversationId }, lifecycleContext(f))).text,
  ).toContain('Landed commits')
  expect(await readFile(join(f.project, 'land-0.txt'), 'utf8')).toBe('0')
  expect(await readFile(join(f.project, 'land-1.txt'), 'utf8')).toBe('1')
  expect(await git(f.project, 'rev-parse', 'HEAD')).toBe((await f.children())[1].workspace?.landed)
})
it('creates, replays and discards through a symlinked home without marking an empty branch landed', async () => {
  const f = await fixture()
  const alias = `${f.home}-alias`
  await symlink(f.home, alias)
  const created = await create(f.project, alias, 'worker', 'symlink')
  expect((await create(f.project, alias, 'worker', 'symlink')).record).toEqual(created.record)
  await discard(f.project, created.record)
  await expect(access(created.cwd)).rejects.toThrow('ENOENT')
  expect(await git(f.project, 'worktree', 'list', '--porcelain')).not.toContain(created.cwd)
  await f.call({ action: 'start', agent: 'worker', task: 'inspect' })
  const [child] = await f.children()
  expect(await f.call({ action: 'land', id: child.conversationId })).toContain('Nothing to land')
  expect((await f.children())[0].workspace?.landed).toBeUndefined()
})

it.each(['land', 'discard'] as const)(
  'cancelling a queued %s preserves the active fast-forward and successor serialization',
  async (operation) => {
    const f = await fixture()
    await f.call({ action: 'start', agent: 'worker', task: 'write' })
    await f.call({ action: 'start', agent: 'worker', task: 'inspect' })
    const [first, successor] = await f.children()
    await git(first.workspace!.path, 'add', '.')
    await git(first.workspace!.path, 'commit', '-m', 'active child')
    await writeFile(join(successor.workspace!.path, 'successor.txt'), 'successor')
    await git(successor.workspace!.path, 'add', '.')
    await git(successor.workspace!.path, 'commit', '-m', 'successor child')
    const successorTip = await git(successor.workspace!.path, 'rev-parse', 'HEAD')
    const head = await git(f.project, 'rev-parse', 'HEAD')
    const hook = join(
      await git(f.project, 'rev-parse', '--absolute-git-dir'),
      'hooks/reference-transaction',
    )
    const entered = join(f.home, 'rebase-entered')
    const release = join(f.home, 'rebase-release')
    await writeFile(
      hook,
      `#!/bin/sh\ntouch '${entered}'\nwhile [ ! -f '${release}' ]; do sleep 0.05; done\n`,
    )
    await chmod(hook, 0o755)
    const active = actions.land({ id: first.conversationId }, lifecycleContext(f))
    await until(async () =>
      access(entered).then(
        () => true,
        () => false,
      ),
    )
    const activeTask = (await f.opened.harness.snapshot(LifecycleQueue, context))!.checkouts[
      f.project
    ]
    const firstTip = await git(first.workspace!.path, 'rev-parse', 'HEAD')
    const cancelled = actions[operation]({ id: first.conversationId }, lifecycleContext(f)).catch(
      (error: Error) => error,
    )
    const queued = async (previous: TaskId) => {
      let id = previous
      await until(async () => {
        id = (await f.opened.harness.snapshot(LifecycleQueue, context))!.checkouts[f.project]
        return (
          id !== previous &&
          (await f.opened.harness.getTask(id, context))?.state.status === 'waiting'
        )
      })
      return id
    }
    const cancelledTask = await queued(activeTask)
    const next = actions
      .land({ id: successor.conversationId }, lifecycleContext(f))
      .catch((error: Error) => error)
    const nextTask = await queued(cancelledTask)
    await f.opened.harness.abortTask(cancelledTask, context)
    expect(await cancelled).toMatchObject({
      message: 'Child worktree lifecycle operation was aborted',
    })
    await until(async () => {
      const state = (await f.opened.harness.getTask(nextTask, context))?.state
      return state?.status === 'waiting' && state.on[0] === activeTask
    })
    expect(await git(first.workspace!.path, 'rev-parse', 'HEAD')).toBe(firstTip)
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(head)
    expect(await git(successor.workspace!.path, 'rev-parse', 'HEAD')).toBe(successorTip)
    await writeFile(release, '')
    expect((await active).text).toContain('Landed commits')
    expect(await next).toMatchObject({
      message: expect.stringContaining('Target moved or diverged'),
    })
    expect(await readFile(join(f.project, 'child.txt'), 'utf8')).toBe('child\n')
    expect(await git(successor.workspace!.path, 'rev-parse', 'HEAD')).toBe(successorTip)
  },
)
it.each(['unchanged', 'target', 'workspace', 'branch'] as const)(
  'resumes a pinned merge checkpoint with %s movement',
  async (movement) => {
    const f = await fixture()
    await f.call({ action: 'start', agent: 'worker', task: 'write' })
    const [child] = await f.children()
    await git(child.workspace!.path, 'add', '.')
    await git(child.workspace!.path, 'commit', '-m', 'durable child')
    const head = await git(f.project, 'rev-parse', 'HEAD')
    const original = lifecycle({
      projectRoot: f.project,
      ultimateRoot: f.project,
      guard: async () => {},
    }).definition
    let pause = true
    let entered = false
    const taskKind = defineTask({
      ...original,
      name: 'test.lifecycle-merge-restart',
      phases: {
        ...original.phases,
        merge: async (task, runtime, ctx) => {
          if (pause) {
            entered = true
            await runtime.sleep(Date.now() + 60000, ctx)
          }
          await original.phases.merge(task, runtime, ctx)
        },
      },
    })
    f.prepared.registry.install(defineExtension({ name: 'merge-restart-test', tasks: [taskKind] }))
    const task = await f.opened.harness.commit(
      (tx) =>
        tx.createTask(
          taskKind,
          { parent: f.opened.root.id, child: child.conversationId, operation: 'land' as const },
          {
            conversationId: f.opened.root.id,
            ownership: { kind: 'conversation' },
            background: true,
          },
        ),
      context,
    )
    await until(async () => entered)
    const tip = await git(child.workspace!.path, 'rev-parse', 'HEAD')
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(head)
    expect((await f.opened.harness.getTask(task, context))?.state.checkpoint).toMatchObject({
      phase: 'merge',
    })
    if (movement === 'branch')
      await git(child.workspace!.path, 'switch', '-c', 'same-sha-other-branch')
    if (movement === 'target' || movement === 'workspace') {
      const checkout = movement === 'target' ? f.project : child.workspace!.path
      await writeFile(join(checkout, 'moved.txt'), 'changed after verification')
      await git(checkout, 'add', '.')
      await git(checkout, 'commit', '-m', 'moved after verification')
    }
    const targetTip = await git(f.project, 'rev-parse', 'HEAD')
    const workspaceTip = await git(child.workspace!.path, 'rev-parse', 'HEAD')
    await f.opened.close()
    hosts.splice(hosts.indexOf(f.opened), 1)
    pause = false
    f.opened = await f.prepared.open()
    hosts.push(f.opened)
    const outcome = (await f.opened.harness.waitForTask(task, context)).state.outcome
    const expectedError = {
      unchanged: '',
      target: 'Target moved; update and reverify before landing',
      workspace: 'Workspace changed after verification; reverify before landing',
      branch: 'Workspace branch changed',
    }[movement]
    expect(outcome.status).toBe(movement === 'unchanged' ? 'completed' : 'failed')
    expect('error' in outcome ? outcome.error?.message : '').toBe(expectedError)
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(
      movement === 'unchanged' ? tip : targetTip,
    )
    expect(await git(child.workspace!.path, 'rev-parse', 'HEAD')).toBe(workspaceTip)
    expect((await f.children())[0].workspace?.landed).toBe(
      movement === 'unchanged' ? tip : undefined,
    )
  },
)
