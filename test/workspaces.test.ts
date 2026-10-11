import { mkdir, writeFile, readFile, access, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  configure,
  AgentDoc,
} from '@earendil-works/pi-durable'
import { awaitWithContext } from '@earendil-works/chord/context'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ActionContext } from '../server/actions.ts'
import automations, {
  actions as automationActions,
  Automations,
} from '../extensions/automations/server.ts'
import type { Automation } from '../extensions/automations/server.ts'
import type { ConversationId, EntryId, TaskId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import { WorkspaceDoc, LifecycleQueue } from '../server/workspaces/doc.ts'
import { Metadata } from '../server/metadata.ts'
import subagents, { Subagents } from '../extensions/subagents/server.ts'
import { git, create } from '../server/workspaces/worktree.ts'
import { fauxServer, post, temp, removeTemp, until, attach } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
async function repository() {
  const directory = await temp('ultimate-core-workspaces-')
  cleanup.push(() => removeTemp(directory))
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.email', 'test@example.com')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await writeFile(join(projectRoot, 'base.txt'), 'base')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'base')
  return { directory, projectRoot, home: join(directory, 'state') }
}
async function fixture() {
  const paths = await repository()
  const prepared = await prepareHarness({
    ...paths,
    userHome: paths.directory,
    ultimateRoot: paths.projectRoot,
    faux: true,
  })
  let opened = await prepared.open()
  cleanup.push(() => opened.close())
  const spawn = async (request: string) => {
    const workspace = await prepared.workspaces.describe(paths.projectRoot, 'test', request)
    const id = await opened.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await configure(tx, conversation.id, { cwd: paths.projectRoot })
      await prepared.workspaces.prepare(tx, conversation.id, workspace, 'test', request)
      return conversation.id
    }, context)
    await prepared.workspaces.ready(id, context)
    return { id, workspace: (await prepared.workspaces.snapshot(id, context))! }
  }
  return {
    ...paths,
    prepared,
    spawn,
    get opened() {
      return opened
    },
    reopen: async () => {
      await opened.close()
      opened = await prepared.open()
    },
  }
}
it('main isolated creation is opt-in, deduplicated and shares the core lifecycle; shared drafts stay shared', async () => {
  const paths = await repository()
  const extension = join(paths.projectRoot, '.ultimate/extensions/exec-test')
  await mkdir(extension, { recursive: true })
  await writeFile(join(extension, 'README.md'), 'Test action cwd.')
  await writeFile(
    join(extension, 'server.ts'),
    `export default { name: 'exec-test' }; export const actions = { pwd: async (args, ctx) => (await ctx.exec('pwd', [], args ?? {})).stdout.trim() }`,
  )
  await git(paths.projectRoot, 'add', '.')
  await git(paths.projectRoot, 'commit', '-m', 'test action')
  const server = await fauxServer({
    ...paths,
    userHome: paths.directory,
    ultimateRoot: resolve('.'),
  })
  cleanup.push(() => server.close())
  const client = await attach(server)
  expect(client.system().execution.workspaces).toBe(true)
  await client.close()
  expect(
    (await post(server, '/api/extensions/exec-test/actions/pwd', { args: {} })).data.result,
  ).toBe(paths.projectRoot)
  expect(
    (
      await post(server, '/api/extensions/exec-test/actions/pwd', {
        args: {},
        conversationId: 999999,
      })
    ).data.error,
  ).toContain('Unknown conversation')
  expect((await post(server, '/api/conversations', { isolate: 'worktree' })).status).toBe(400)
  expect((await post(server, '/api/conversations', { isolate: 'remote' })).status).toBe(400)
  const shared = (await post(server, '/api/conversations', {})).data.id as ConversationId
  expect(await server.host.workspaces.snapshot(shared, context)).toBeUndefined()
  const request = { isolate: 'worktree', requestId: 'main-draft' }
  const first = await post(server, '/api/conversations', request)
  expect(first.status).toBe(201)
  expect((await post(server, '/api/conversations', request)).data.id).toBe(first.data.id)
  const id = first.data.id as ConversationId
  await server.host.workspaces.ready(id, context)
  const workspace = (await server.host.workspaces.snapshot(id, context))!
  await until(
    () =>
      server.api.conversations().find((item) => item.id === id)?.workspace?.preparation === 'ready',
  )
  expect((await (await server.harness.conversation(id, context))!.agent(context)).cwd).toBe(
    workspace.path,
  )
  expect(
    (await post(server, '/api/extensions/exec-test/actions/pwd', { args: {}, conversationId: id }))
      .data.result,
  ).toBe(workspace.path)
  expect(
    (
      await post(server, '/api/extensions/exec-test/actions/pwd', {
        args: { cwd: paths.projectRoot },
        conversationId: id,
      })
    ).data.result,
  ).toBe(paths.projectRoot)
  await writeFile(join(workspace.path, 'main.txt'), 'isolated')
  await git(workspace.path, 'add', '.')
  await git(workspace.path, 'commit', '-m', 'main isolated work')
  const sha = await git(workspace.path, 'rev-parse', 'HEAD')
  await server.host.workspaces.runLifecycle(server.root.id, id, 'land', context)
  expect(await git(paths.projectRoot, 'rev-parse', 'HEAD')).toBe(sha)
  await server.host.workspaces.runLifecycle(server.root.id, id, 'discard', context)
  const refused = await post(server, `/api/conversations/${id}/submit`, { text: 'do not run' })
  expect(refused.status).toBe(409)
  expect(refused.data.error).toContain('discarded')
})
it('pending and failed preparation fail closed and survive restart without another identity', async () => {
  const paths = await repository()
  await mkdir(join(paths.projectRoot, '.ultimate'))
  const release = join(paths.directory, 'release-setup')
  await writeFile(
    join(paths.projectRoot, '.ultimate/settings.json'),
    JSON.stringify({
      isolates: {
        worktree: {
          setup: [
            `while [ ! -f '${release}' ]; do sleep 0.05; done; echo failed-setup >&2; exit 1`,
          ],
        },
      },
    }),
  )
  const server = await fauxServer({
    ...paths,
    userHome: paths.directory,
    ultimateRoot: resolve('.'),
  })
  cleanup.push(() => server.close())
  // Setup waits in the temporary repository so pending is externally visible.
  const id = (await post(server, '/api/conversations', { isolate: 'worktree', requestId: 'fail' }))
    .data.id as ConversationId
  expect((await server.host.workspaces.snapshot(id, context))!.preparation).toBe('pending')
  expect((await post(server, `/api/conversations/${id}/submit`, { text: 'no' })).status).toBe(409)
  await writeFile(release, '')
  await expect(server.host.workspaces.ready(id, context)).rejects.toThrow('failed-setup')
  expect((await server.host.workspaces.snapshot(id, context))!.preparation).toBe('error')
  expect((await post(server, `/api/conversations/${id}/submit`, { text: 'no' })).status).toBe(409)
  await server.close()
  cleanup.pop()
  const resumed = await fauxServer({
    ...paths,
    userHome: paths.directory,
    ultimateRoot: resolve('.'),
  })
  cleanup.push(() => resumed.close())
  expect((await resumed.host.workspaces.snapshot(id, context))!.preparation).toBe('error')
  expect(
    (await post(resumed, '/api/conversations', { isolate: 'worktree', requestId: 'fail' })).data.id,
  ).toBe(id)
})
it('admits action exec only at execution time, never falls back during preparation or after removal, and leases running commands', async () => {
  const paths = await repository()
  const extension = join(paths.projectRoot, '.ultimate/extensions/exec-test')
  await mkdir(extension, { recursive: true })
  await writeFile(
    join(extension, 'server.ts'),
    `export default { name: 'exec-test' }
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { writeFile } from 'node:fs/promises'
const write = ctx => ctx.exec(process.execPath, ['-e', "require('node:fs').writeFileSync('action.txt', process.cwd())"])
export const actions = {
  status: async (_args, ctx) => ctx.host.workspaces.snapshot(ctx.conversationId, context),
  write: async (_args, ctx) => write(ctx),
  afterReady: async (args, ctx) => { await writeFile(args.started, ''); await ctx.host.workspaces.ready(ctx.conversationId, context); return write(ctx) },
  wait: async (args, ctx) => ctx.exec(process.execPath, ['--input-type=module', '-e', \`import { writeFileSync, existsSync } from 'node:fs'; writeFileSync(\${JSON.stringify(args.entered)}, ''); while (!existsSync(\${JSON.stringify(args.release)})) await new Promise(resolve => setTimeout(resolve, 20))\`]),
  discard: async (_args, ctx) => ctx.host.workspaces.runLifecycle(ctx.conversationId, ctx.conversationId, 'discard', context)
}`,
  )
  const releaseSetup = join(paths.directory, 'release-setup')
  const failSetup = join(paths.directory, 'fail-setup')
  await writeFile(
    join(paths.projectRoot, '.ultimate/settings.json'),
    JSON.stringify({
      isolates: {
        worktree: {
          setup: [
            `while [ ! -f '${releaseSetup}' ]; do sleep 0.05; done; if [ -f '${failSetup}' ]; then echo action-setup-failed >&2; exit 1; fi`,
          ],
        },
      },
    }),
  )
  const server = await fauxServer({
    ...paths,
    userHome: paths.directory,
    ultimateRoot: resolve('.'),
  })
  cleanup.push(() => server.close())
  const id = (
    await post(server, '/api/conversations', { isolate: 'worktree', requestId: 'action-execution' })
  ).data.id as ConversationId
  const action = (name: string, conversationId = id, args: unknown = null) =>
    post(server, `/api/extensions/exec-test/actions/${name}`, { args, conversationId })
  expect((await action('status')).data.result.preparation).toBe('pending')
  expect((await action('write')).data.error).toContain('preparation is pending')
  await expect(access(join(paths.projectRoot, 'action.txt'))).rejects.toThrow('ENOENT')
  // The action starts with source cwd, waits for setup, then must resolve its cwd afresh.
  const started = join(paths.directory, 'action-started')
  const delayed = action('afterReady', id, { started })
  await until(async () =>
    access(started).then(
      () => true,
      () => false,
    ),
  )
  expect((await server.host.workspaces.snapshot(id, context))!.preparation).toBe('pending')
  await writeFile(releaseSetup, '')
  expect((await delayed).status).toBe(200)
  const workspace = (await server.host.workspaces.snapshot(id, context))!
  expect(await readFile(join(workspace.path, 'action.txt'), 'utf8')).toBe(workspace.path)
  await expect(access(join(paths.projectRoot, 'action.txt'))).rejects.toThrow('ENOENT')
  await git(workspace.path, 'add', '.')
  await git(workspace.path, 'commit', '-m', 'isolated action output')
  const entered = join(paths.directory, 'entered-action')
  const release = join(paths.directory, 'release-action')
  const running = action('wait', id, { entered, release })
  try {
    await until(async () =>
      access(entered).then(
        () => true,
        () => false,
      ),
    )
    await expect(
      server.host.workspaces.runLifecycle(server.root.id, id, 'land', context),
    ).rejects.toThrow('execution admission')
  } finally {
    await writeFile(release, '')
  }
  expect((await running).status).toBe(200)
  expect((await action('discard')).status).toBe(200)
  expect((await action('status')).data.result.state).toBe('discarded')
  expect((await action('write')).data.error).toContain('discarded')
  await expect(access(join(workspace.path, 'action.txt'))).rejects.toThrow('ENOENT')
  await expect(access(join(paths.projectRoot, 'action.txt'))).rejects.toThrow('ENOENT')
  await writeFile(failSetup, '')
  const failed = (
    await post(server, '/api/conversations', { isolate: 'worktree', requestId: 'action-error' })
  ).data.id as ConversationId
  await expect(server.host.workspaces.ready(failed, context)).rejects.toThrow('action-setup-failed')
  expect((await action('status', failed)).data.result.preparation).toBe('error')
  expect((await action('write', failed)).data.error).toContain('preparation is error')
  await expect(access(join(paths.projectRoot, 'action.txt'))).rejects.toThrow('ENOENT')
})
it('preview leases block cleanup, cleanup refuses dirty output and retains the branch', async () => {
  const f = await fixture()
  const { id, workspace } = await f.spawn('lease')
  const shared = await f.opened.harness.commit(async (tx) => {
    const record = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, record.id, { cwd: workspace.path })
    return record.id
  }, context)
  const release = await f.prepared.workspaces.hold(id, context)
  await expect(
    f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'discard', context),
  ).rejects.toThrow('preview hold')
  release()
  release()
  await writeFile(join(workspace.path, 'uncommitted'), 'valuable')
  await expect(
    f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'discard', context),
  ).rejects.toThrow('untracked files')
  expect(await readFile(join(workspace.path, 'uncommitted'), 'utf8')).toBe('valuable')
  await git(workspace.path, 'add', '.')
  await git(workspace.path, 'commit', '-m', 'keep output')
  await f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'discard', context)
  await expect(access(workspace.path)).rejects.toThrow('ENOENT')
  expect(await git(f.projectRoot, 'branch', '--list', workspace.branch)).toContain(workspace.branch)
  await expect(
    f.prepared.workspaces.submit(shared, { type: 'input', content: 'do not fall back' }, context),
  ).rejects.toThrow('Workspace was discarded')
})
it.each(['workspace-subdir', 'workspace-alias', 'source-subdir', 'source-alias'])(
  'guards ownerless %s tasks and submits through canonical checkout identity',
  async (mode) => {
    const f = await fixture()
    const { id, workspace } = await f.spawn(`identity-${mode}`)
    const root = mode.startsWith('workspace') ? workspace.path : f.projectRoot
    await mkdir(join(root, 'src'))
    const alias = join(f.directory, 'alias')
    await symlink(root, alias, 'dir')
    const cwd = join(mode.endsWith('alias') ? alias : root, 'src')
    const Gate = defineTask<null, { phase: 'hold' }, null>({
      name: 'test.workspace-identity-gate',
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
    f.prepared.registry.install(defineExtension({ name: 'identity-gate', tasks: [Gate] }))
    const { conversationId, active: activeTask } = await f.opened.harness.commit(async (tx) => {
      const record = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await configure(tx, record.id, { cwd })
      const active = await tx.createTask(Gate, null, {
        conversationId: record.id,
        ownership: { kind: 'conversation' },
        background: true,
      })
      return { conversationId: record.id, active }
    }, context)
    await expect(
      f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'land', context),
    ).rejects.toThrow('running or queued')
    await expect(
      f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'discard', context),
    ).rejects.toThrow('running or queued')
    await f.opened.harness.abortTask(activeTask, context)
    await f.opened.harness.waitForTask(activeTask, context)
    const predecessor = await f.opened.harness.commit(async (tx) => {
      const unrelated = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await configure(tx, unrelated.id, { cwd: f.directory })
      const gate = await tx.createTask(Gate, null, {
        conversationId: unrelated.id,
        ownership: { kind: 'conversation' },
        background: true,
      })
      ;(await tx.doc(LifecycleQueue)).checkouts[workspace.source] = gate
      return gate
    }, context)
    const land = await f.opened.harness.commit(
      (tx) =>
        f.prepared.workspaces.createLifecycle(tx, f.opened.root.id, id, 'land', {
          kind: 'conversation',
        }),
      context,
    )
    await until(
      async () => (await f.opened.harness.getTask(land, context))?.state.status === 'waiting',
    )
    await f.reopen()
    await expect(
      f.prepared.workspaces.submit(
        conversationId,
        { type: 'input', content: 'must not execute' },
        context,
      ),
    ).rejects.toThrow('lifecycle operation')
    await expect(
      f.prepared.workspaces.withAdmission(
        conversationId,
        async () => {
          throw new Error('Command must not start')
        },
        context,
      ),
    ).rejects.toThrow('lifecycle operation')
    await f.opened.harness.abortTask(predecessor, context)
    expect((await f.opened.harness.waitForTask(land, context)).state.outcome.status).toBe(
      'completed',
    )
    await f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'discard', context)
    const afterRemoval = mode.startsWith('workspace')
      ? await f.prepared.workspaces
          .submit(conversationId, { type: 'input', content: 'removed alias' }, context)
          .then(
            () => 'admitted',
            (error) => String(error),
          )
      : await f.opened.harness
          .commit((tx) => f.prepared.workspaces.assertAdmission(tx, conversationId), context)
          .then(() => 'admitted')
    expect(afterRemoval.includes('discarded')).toBe(mode.startsWith('workspace'))
    const view = await (await f.opened.harness.conversation(conversationId, context))!.viewState(
      context,
    )
    expect(view.value.entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(0)
    view.dispose()
  },
)
it('retains the original target checkout and branch, refusing dirty targets and branch switches', async () => {
  const f = await fixture()
  const { id, workspace } = await f.spawn('target')
  await writeFile(join(workspace.path, 'change'), 'work')
  await git(workspace.path, 'add', '.')
  await git(workspace.path, 'commit', '-m', 'work')
  await f.opened.root.configure({ cwd: workspace.path }, context)
  await writeFile(join(f.projectRoot, 'dirty'), 'not ours')
  await expect(
    f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'land', context),
  ).rejects.toThrow('Target checkout is dirty')
  await git(f.projectRoot, 'add', '.')
  await git(f.projectRoot, 'commit', '-m', 'target moved')
  await git(f.projectRoot, 'switch', '-c', 'other')
  await expect(
    f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'land', context),
  ).rejects.toThrow('Target branch changed')
  expect((await f.prepared.workspaces.snapshot(id, context))!.source).toBe(f.projectRoot)
})
it('guards queued descendant tasks and admission while a lifecycle is queued, including across restart', async () => {
  const f = await fixture()
  const { id } = await f.spawn('descendant')
  const Gate = defineTask<null, { phase: 'hold' }, null>({
    name: 'test.workspace-gate',
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
  f.prepared.registry.install(defineExtension({ name: 'gate', tasks: [Gate] }))
  const gate = await f.opened.harness.commit(async (tx) => {
    const task = await tx.createTask(Gate, null, {
      conversationId: id,
      ownership: { kind: 'conversation' },
      background: true,
    })
    await tx.createConversation({ ownership: { kind: 'task', taskId: task } })
    return task
  }, context)
  await expect(
    f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'discard', context),
  ).rejects.toThrow('descendant work')
  await f.opened.harness.abortTask(gate, context)
  const checkoutGate = await f.opened.harness.commit(async (tx) => {
    const queueOwner = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, queueOwner.id, { cwd: f.home })
    const task = await tx.createTask(Gate, null, {
      conversationId: queueOwner.id,
      ownership: { kind: 'conversation' },
      background: true,
    })
    ;(await tx.doc(LifecycleQueue)).checkouts[f.projectRoot] = task
    return task
  }, context)
  const task = await f.opened.harness.commit(
    (tx) =>
      f.prepared.workspaces.createLifecycle(tx, f.opened.root.id, id, 'discard', {
        kind: 'conversation',
      }),
    context,
  )
  await expect(
    f.prepared.workspaces.submit(id, { type: 'input', content: 'no' }, context),
  ).rejects.toThrow('lifecycle operation')
  await f.reopen()
  await expect(
    f.prepared.workspaces.submit(id, { type: 'input', content: 'no' }, context),
  ).rejects.toThrow('lifecycle operation')
  await f.opened.harness.abortTask(checkoutGate, context)
  expect((await f.opened.harness.waitForTask(task, context)).state.outcome.status).toBe('completed')
})
it('allows dormant automation scheduling, defers a due firing across lifecycle/reopen, and guards the actual run', async () => {
  const f = await fixture()
  const { id, workspace } = await f.spawn('automation-target')
  let release: (() => void) | undefined
  let observedHead: string | undefined
  const Gate = defineTask<null, { phase: 'hold' }, null>({
    name: 'test.automation-checkout-gate',
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
  f.prepared.registry.install(
    defineExtension({
      name: 'automation-test',
      tasks: [Gate],
      tools: [
        defineTool({
          name: 'automation-hold',
          description: 'Hold a real automation run',
          replay: 'safe',
          parameters: Type.Object({}),
          execute: async (_args, _api, ctx) => {
            observedHead = await git(f.projectRoot, 'rev-parse', 'HEAD')
            await awaitWithContext(
              new Promise<void>((complete) => {
                release = complete
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
    ...f.prepared,
    harness: () => f.opened.harness,
    metadata: Metadata,
    extensions: () => [{ name: 'subagents', enabled: true }],
  } as unknown as Parameters<typeof automations>[0]
  f.prepared.registry.install(automations(host))
  await f.opened.root.configure(
    {
      tools: f.prepared.registry.snapshot().extension('automation-test')!.tools!,
      extensions: [{ name: 'automation-test' }],
    },
    context,
  )
  const route: FauxResponseFactory = (transcript) => {
    f.prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    return last.role === 'user'
      ? fauxAssistantMessage([fauxToolCall('automation-hold', {})], { stopReason: 'toolUse' })
      : fauxAssistantMessage([fauxText('Automation finished')])
  }
  f.prepared.faux!.setResponses([route])
  const actionContext = { host } as unknown as ActionContext
  const future = (await automationActions.create(
    { name: 'Future', prompt: 'future', schedule: 'in 1h' },
    actionContext,
  )) as unknown as Automation
  await until(
    async () =>
      (
        (await f.opened.harness.getTask(future.scheduler!, context))!.state as {
          checkpoint?: { phase: string }
        }
      ).checkpoint?.phase === 'sleep',
  )
  await writeFile(join(workspace.path, 'first.txt'), 'first')
  await git(workspace.path, 'add', '.')
  await git(workspace.path, 'commit', '-m', 'land with a dormant scheduler')
  const first = await git(workspace.path, 'rev-parse', 'HEAD')
  await f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'land', context)
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(first)
  await writeFile(join(workspace.path, 'second.txt'), 'second')
  await git(workspace.path, 'add', '.')
  await git(workspace.path, 'commit', '-m', 'land before scheduled work')
  const second = await git(workspace.path, 'rev-parse', 'HEAD')
  const predecessor = await f.opened.harness.commit(async (tx) => {
    const unrelated = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, unrelated.id, { cwd: f.directory })
    const gate = await tx.createTask(Gate, null, {
      conversationId: unrelated.id,
      ownership: { kind: 'conversation' },
      background: true,
    })
    ;(await tx.doc(LifecycleQueue)).checkouts[workspace.source] = gate
    return gate
  }, context)
  const land = await f.opened.harness.commit(
    (tx) =>
      f.prepared.workspaces.createLifecycle(tx, f.opened.root.id, id, 'land', {
        kind: 'conversation',
      }),
    context,
  )
  const due = (await automationActions.create(
    { name: 'Due during land', prompt: 'scheduled hold', schedule: 'in 1s' },
    actionContext,
  )) as unknown as Automation
  await until(
    async () =>
      (await f.opened.harness.getTask(due.scheduler!, context))?.state.status === 'waiting',
  )
  expect(
    (await f.opened.harness.snapshot(Automations, context))!.automations[due.id].runs,
  ).toHaveLength(0)
  expect(release).toBeUndefined()
  await f.reopen()
  await f.opened.harness.abortTask(predecessor, context)
  expect((await f.opened.harness.waitForTask(land, context)).state.outcome.status).toBe('completed')
  await until(() => !!release)
  expect(observedHead).toBe(second)
  const records = async () =>
    (await f.opened.harness.snapshot(Automations, context))!.automations[due.id].runs
  expect((await records())[0].status).toBe('running')
  await expect(
    f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'land', context),
  ).rejects.toThrow('running')
  release!()
  await until(async () => (await records())[0].status === 'done')
  await f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'land', context)
  await f.reopen()
  expect(await records()).toHaveLength(1)
  expect((await records())[0].answer).toBe('Automation finished')
  const child = await f.opened.harness.conversation((await records())[0].conversationId!, context)
  const view = await child!.viewState(context)
  expect(view.value.entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
  view.dispose()
})
it('migrates actual persisted legacy isolates once before resume, retaining landed and discarded identities', async () => {
  const f = await fixture()
  const legacy = defineDoc<{
    agents: Record<
      string,
      {
        isolate?: Omit<
          import('../shared/protocol.ts').Workspace,
          'source' | 'targetBranch' | 'preparation'
        >
      }
    >
  }>({
    kind: 'ultimate.subagents',
    version: 1,
    scope: 'conversation',
    history: 'latest',
    fork: 'initial',
    initial: () => ({ agents: {} }),
  })
  const target = await create(f.projectRoot, f.home, 'parent', 'legacy-parent')
  await f.opened.root.configure({ cwd: target.cwd }, context)
  const old = await create(target.cwd, f.home, 'old', 'legacy')
  const id = await f.opened.harness.commit(async (tx) => {
    const child = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const {
      source: _source,
      targetBranch: _target,
      preparation: _preparation,
      ...record
    } = old.record
    ;(await tx.doc(legacy, f.opened.root.id)).agents[String(child.id)] = {
      isolate: { ...record, landed: record.base, state: 'discarded' },
    }
    return child.id
  }, context)
  await f.reopen()
  expect(await f.prepared.workspaces.snapshot(id, context)).toEqual({
    ...old.record,
    landed: old.record.base,
    state: 'discarded',
  })
  expect(
    (await f.opened.harness.snapshot(legacy, f.opened.root.id, context))!.agents[String(id)]
      .isolate,
  ).toBeUndefined()
  await f.reopen()
  expect((await f.prepared.workspaces.snapshot(id, context))!.branch).toBe(old.record.branch)
  expect((await f.opened.harness.snapshot(AgentDoc, f.opened.root.id, context))!.cwd).toBe(
    target.cwd,
  )
  expect((await f.opened.harness.snapshot(WorkspaceDoc, id, context))!.workspace!.landed).toBe(
    old.record.base,
  )
})
it.each(['active', 'discarded'] as const)(
  'adopts legacy %s identities from a detached source without guessing a target branch',
  async (state) => {
    const f = await fixture()
    const old = await create(f.projectRoot, f.home, 'legacy', `legacy-detached-${state}`)
    const Legacy = defineDoc<{
      agents: Record<
        string,
        {
          isolate?: Omit<
            import('../shared/protocol.ts').Workspace,
            'source' | 'targetBranch' | 'preparation'
          >
        }
      >
    }>({
      kind: 'ultimate.subagents',
      version: 1,
      scope: 'conversation',
      history: 'latest',
      fork: 'initial',
      initial: () => ({ agents: {} }),
    })
    if (state === 'discarded') await git(f.projectRoot, 'worktree', 'remove', old.cwd)
    await git(f.projectRoot, 'switch', '--detach', old.record.base)
    const id = await f.opened.harness.commit(async (tx) => {
      const child = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await configure(tx, child.id, { cwd: old.cwd })
      const {
        source: _source,
        targetBranch: _targetBranch,
        preparation: _preparation,
        ...isolate
      } = old.record
      ;(await tx.doc(Legacy, f.opened.root.id)).agents[String(child.id)] = {
        isolate: { ...isolate, state, landed: old.record.base },
      }
      return child.id
    }, context)
    await f.reopen()
    expect(await f.prepared.workspaces.snapshot(id, context)).toEqual({
      ...old.record,
      state,
      landed: old.record.base,
      targetBranch: null,
      targetHead: old.record.base,
    })
    expect(
      (await f.opened.harness.snapshot(Legacy, f.opened.root.id, context))!.agents[String(id)]
        .isolate,
    ).toBeUndefined()
    await f.reopen()
    expect((await f.prepared.workspaces.snapshot(id, context))!.targetBranch).toBeNull()
    await git(f.projectRoot, 'switch', 'main')
    await expect(
      f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'land', context),
    ).rejects.toThrow(state === 'active' ? 'captured detached' : 'Workspace is discarded')
    await f.prepared.workspaces.runLifecycle(f.opened.root.id, id, 'discard', context)
    expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(old.record.base)
    expect(await git(f.projectRoot, 'branch', '--list', old.record.branch)).toContain(
      old.record.branch,
    )
  },
)
it.each(['deliver', 'report'] as const)(
  'adopts an active legacy workspace and resumes a background reporter from %s without duplicate delivery',
  async (checkpoint) => {
    const f = await fixture()
    const old = await create(f.projectRoot, f.home, 'legacy', `legacy-background-${checkpoint}`)
    const Legacy = defineDoc<{
      agents: Record<
        string,
        {
          conversationId: ConversationId
          agent: string
          background: boolean
          reported: EntryId[]
          anchor: TaskId
          isolate?: Omit<
            import('../shared/protocol.ts').Workspace,
            'source' | 'targetBranch' | 'preparation'
          >
        }
      >
      actions: Record<string, { conversationId: ConversationId; reporter: TaskId }>
    }>({
      kind: 'ultimate.subagents',
      version: 1,
      scope: 'conversation',
      history: 'latest',
      fork: 'initial',
      initial: () => ({ agents: {}, actions: {} }),
    })
    const Gate = defineTask<null, { phase: 'hold' }, null>({
      name: 'test.legacy-background-gate',
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
    let gate: TaskId
    type Input = { conversationId: ConversationId; text: string; steer: boolean }
    type State = { phase: 'deliver' } | { phase: 'report'; report?: string; answer?: EntryId }
    // The legacy input/checkpoint shapes are unchanged; neither contains a callId.
    const Reporter = defineTask<Input, State, null>({
      name: 'ultimate.subagent-reporter',
      version: 1,
      initial: () => ({ phase: 'deliver' }),
      phases: {
        deliver: async (task, runtime, ctx) => {
          const child = (await runtime.conversation(task.input.conversationId, ctx))!
          const settled = await (
            await child.submit(
              {
                type: 'input',
                content: task.input.text,
                whenBusy: task.input.steer ? 'steer' : 'followUp',
                requestId: `subagent:${task.id}`,
              },
              ctx,
            )
          ).wait(ctx)
          if (settled.status !== 'done' || settled.type !== 'input')
            throw new Error('Legacy child did not answer')
          await runtime.commit(async (tx) => {
            if (checkpoint === 'deliver')
              return {
                status: 'waiting',
                on: [gate],
                policy: 'allSettled',
                checkpoint: { phase: 'deliver' },
              }
            ;(await tx.doc(Legacy, runtime.conversationId)).agents[String(child.id)].reported.push(
              settled.answer,
            )
            return {
              status: 'running',
              checkpoint: {
                phase: 'report',
                report: `[subagent ${child.id} (legacy) answered] Legacy child answer`,
                answer: settled.answer,
              },
            }
          }, ctx)
        },
        report: async (task, runtime, ctx) => {
          const parent = (await runtime.conversation(runtime.conversationId, ctx))!
          await (
            await parent.submit(
              {
                type: 'input',
                content: task.state.checkpoint.report!,
                whenBusy: 'steer',
                requestId: `subagent-answer:${task.state.checkpoint.answer}`,
              },
              ctx,
            )
          ).wait(ctx)
          await runtime.commit(
            () => ({
              status: 'waiting',
              on: [gate],
              policy: 'allSettled',
              checkpoint: task.state.checkpoint,
            }),
            ctx,
          )
        },
      },
      abort: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
    })
    f.prepared.registry.install(defineExtension({ name: 'legacy-background-gate', tasks: [Gate] }))
    f.prepared.registry.install(defineExtension({ name: 'subagents', tasks: [Reporter] }))
    f.prepared.faux!.setResponses([
      fauxAssistantMessage([fauxText('Legacy child answer')]),
      fauxAssistantMessage([fauxText('Report received')]),
    ])
    const rootAgent = await f.opened.root.agent(context)
    const { child: childId, reporter: reporterId } = await f.opened.harness.commit(async (tx) => {
      gate = await tx.createTask(Gate, null, {
        conversationId: f.opened.root.id,
        ownership: { kind: 'conversation' },
        background: true,
      })
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId: gate } })
      await configure(tx, child.id, {
        cwd: old.cwd,
        model: rootAgent.model,
        thinkingLevel: rootAgent.thinkingLevel,
        tools: [],
        extensions: [],
      })
      const state = await tx.doc(Legacy, f.opened.root.id)
      const {
        source: _source,
        targetBranch: _targetBranch,
        preparation: _preparation,
        ...isolate
      } = old.record
      state.agents[String(child.id)] = {
        conversationId: child.id,
        anchor: gate,
        agent: 'legacy',
        background: true,
        reported: [],
        isolate,
      }
      const reporter = await tx.createTask(
        Reporter,
        { conversationId: child.id, text: 'legacy background input', steer: false },
        { conversationId: f.opened.root.id, ownership: { kind: 'conversation' }, background: true },
      )
      state.actions['legacy-background-call'] = { conversationId: child.id, reporter }
      return { child: child.id, reporter }
    }, context)
    await until(
      async () => (await f.opened.harness.getTask(reporterId, context))?.state.status === 'waiting',
    )
    expect((await f.opened.harness.getTask(reporterId, context))!.input).toEqual({
      conversationId: childId,
      text: 'legacy background input',
      steer: false,
    })
    f.prepared.registry.install(
      subagents({
        ...f.prepared,
        projectSettings: async () => ({}),
        harness: () => f.opened.harness,
        metadata: Metadata,
      }),
    )
    await f.reopen()
    expect(await f.prepared.workspaces.snapshot(childId, context)).toEqual(old.record)
    expect(
      (await f.opened.harness.snapshot(Legacy, f.opened.root.id, context))!.agents[String(childId)]
        .isolate,
    ).toBeUndefined()
    await f.opened.harness.abortTask(gate!, context)
    expect((await f.opened.harness.waitForTask(reporterId, context)).state.outcome.status).toBe(
      'completed',
    )
    await f.opened.root.waitForIdle(context)
    await f.reopen()
    expect((await f.opened.harness.getTask(reporterId, context))!.state.status).toBe('terminal')
    const index = (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!
    expect(index.actions['legacy-background-call'].reporter).toBe(reporterId)
    expect(index.agents[String(childId)].reported).toHaveLength(1)
    const childView = await (await f.opened.harness.conversation(childId, context))!.viewState(
      context,
    )
    expect(childView.value.entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
    childView.dispose()
    const parentView = await f.opened.root.viewState(context)
    expect(
      parentView.value.entries.filter(
        (entry) =>
          entry.kind === 'pi.user' && JSON.stringify(entry.model).includes(`[subagent ${childId}`),
      ),
    ).toHaveLength(1)
    parentView.dispose()
  },
)
it('lets the own-workspace orchestration tool finish child-to-workspace-to-original-checkout integration', async () => {
  const f = await fixture()
  const own = await f.spawn('own')
  const childWorkspace = await f.prepared.workspaces.describe(
    own.workspace.path,
    'child',
    'own-child',
  )
  const child = await f.opened.harness.commit(async (tx) => {
    const record = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, record.id, { cwd: own.workspace.path })
    await f.prepared.workspaces.prepare(tx, record.id, childWorkspace, 'child', 'own-child')
    return record.id
  }, context)
  await f.prepared.workspaces.ready(child, context)
  await mkdir(join(childWorkspace.path, 'server'))
  await writeFile(join(childWorkspace.path, 'server/change.ts'), '// core change')
  await writeFile(join(childWorkspace.path, 'child.txt'), 'child to original')
  await git(childWorkspace.path, 'add', '.')
  await git(childWorkspace.path, 'commit', '-m', 'child work')
  const tip = await git(childWorkspace.path, 'rev-parse', 'HEAD')
  const childLand = await f.prepared.workspaces.runLifecycle(own.id, child, 'land', context)
  expect(childLand.needsRestart).toBeUndefined()
  expect(await git(own.workspace.path, 'rev-parse', 'HEAD')).toBe(tip)
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).not.toBe(tip)
  f.prepared.registry.install(
    defineExtension({
      name: 'self-land-test',
      tools: [
        defineTool({
          name: 'land-self',
          description: 'Test own land',
          parameters: Type.Object({}),
          execute: async (_args, api, ctx) => {
            const task = await api.commit(
              (tx) =>
                f.prepared.workspaces.createLifecycle(
                  tx,
                  api.conversationId,
                  api.conversationId,
                  'land',
                  { kind: 'task', taskId: api.taskId },
                ),
              ctx,
            )
            const outcome = (await api.waitForTask(task, ctx)).state.outcome
            expect(outcome).toMatchObject({ status: 'completed', result: { needsRestart: true } })
            return { content: [{ type: 'text', text: 'Integrated original checkout' }] }
          },
        }),
      ],
    }),
  )
  f.prepared.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('land-self', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Done')]),
  ])
  const conversation = (await f.opened.harness.conversation(own.id, context))!
  await conversation.configure({ model: { provider: 'faux', modelId: 'faux-1' } }, context)
  await (
    await f.prepared.workspaces.submit(own.id, { type: 'input', content: 'integrate' }, context)
  ).wait(context)
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(tip)
  expect(await readFile(join(f.projectRoot, 'child.txt'), 'utf8')).toBe('child to original')
  expect((await f.prepared.workspaces.snapshot(own.id, context))!.landed).toBe(tip)
  await writeFile(join(f.projectRoot, 'later.txt'), 'later target work')
  await git(f.projectRoot, 'add', '.')
  await git(f.projectRoot, 'commit', '-m', 'target advanced after integration')
  const targetTip = await git(f.projectRoot, 'rev-parse', 'HEAD')
  const repeated = await f.prepared.workspaces.runLifecycle(own.id, own.id, 'land', context)
  expect(repeated).toEqual({ text: 'Nothing to land.', landed: tip })
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(targetTip)
})
it('refuses migration until live legacy lifecycle tasks settle, without deleting old identity', async () => {
  const f = await fixture()
  const old = await create(f.projectRoot, f.home, 'legacy', 'legacy-active')
  const Legacy = defineDoc<{ agents: Record<string, { isolate?: typeof old.record }> }>({
    kind: 'ultimate.subagents',
    version: 1,
    scope: 'conversation',
    history: 'latest',
    fork: 'initial',
    initial: () => ({ agents: {} }),
  })
  const Gate = defineTask<null, { phase: 'hold' }, null>({
    name: 'ultimate.isolate-lifecycle',
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
  f.prepared.registry.install(defineExtension({ name: 'legacy-test', tasks: [Gate] }))
  const { id, gate } = await f.opened.harness.commit(async (tx) => {
    const record = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    ;(await tx.doc(Legacy, f.opened.root.id)).agents[String(record.id)] = { isolate: old.record }
    const legacyTask = await tx.createTask(Gate, null, {
      conversationId: f.opened.root.id,
      ownership: { kind: 'conversation' },
      background: true,
    })
    return { id: record.id, gate: legacyTask }
  }, context)
  await expect(f.prepared.workspaces.migrate(context)).rejects.toThrow(
    'must finish before workspace migration',
  )
  expect(await f.prepared.workspaces.snapshot(id, context)).toBeUndefined()
  expect(
    (await f.opened.harness.snapshot(Legacy, f.opened.root.id, context))!.agents[String(id)]
      .isolate!.branch,
  ).toBe(old.record.branch)
  await f.opened.harness.abortTask(gate, context)
  await f.opened.harness.waitForTask(gate, context)
  await f.reopen()
  expect((await f.prepared.workspaces.snapshot(id, context))!.branch).toBe(old.record.branch)
  expect(
    (await f.opened.harness.snapshot(Legacy, f.opened.root.id, context))!.agents[String(id)]
      .isolate,
  ).toBeUndefined()
})
it('blocks cross-destination lifecycle races and refuses removal of idle dependent workspaces', async () => {
  const f = await fixture()
  const own = await f.spawn('nested-parent')
  const workspace = await f.prepared.workspaces.describe(
    own.workspace.path,
    'child',
    'nested-child',
  )
  const child = await f.opened.harness.commit(async (tx) => {
    const record = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, record.id, { cwd: own.workspace.path })
    await f.prepared.workspaces.prepare(tx, record.id, workspace, 'child', 'nested-child')
    return record.id
  }, context)
  await f.prepared.workspaces.ready(child, context)
  await expect(
    f.prepared.workspaces.runLifecycle(own.id, own.id, 'discard', context),
  ).rejects.toThrow('active dependent workspace')
  const Gate = defineTask<null, { phase: 'hold' }, null>({
    name: 'test.nested-queue-gate',
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
  f.prepared.registry.install(defineExtension({ name: 'nested-gate', tasks: [Gate] }))
  const gate = await f.opened.harness.commit(async (tx) => {
    const record = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, record.id, { cwd: f.home })
    const task = await tx.createTask(Gate, null, {
      conversationId: record.id,
      ownership: { kind: 'conversation' },
      background: true,
    })
    const queue = await tx.doc(LifecycleQueue)
    queue.checkouts[own.workspace.path] = task
    queue.checkouts[f.projectRoot] = task
    return task
  }, context)
  const childLand = await f.opened.harness.commit(
    (tx) =>
      f.prepared.workspaces.createLifecycle(tx, own.id, child, 'land', { kind: 'conversation' }),
    context,
  )
  await expect(f.prepared.workspaces.runLifecycle(own.id, own.id, 'land', context)).rejects.toThrow(
    'Dependent workspace lifecycle',
  )
  await f.opened.harness.abortTask(childLand, context)
  await f.opened.harness.waitForTask(childLand, context)
  const ownLand = await f.opened.harness.commit(
    (tx) =>
      f.prepared.workspaces.createLifecycle(tx, own.id, own.id, 'land', { kind: 'conversation' }),
    context,
  )
  await expect(f.prepared.workspaces.runLifecycle(own.id, child, 'land', context)).rejects.toThrow(
    'Dependent workspace lifecycle',
  )
  await f.opened.harness.abortTask(ownLand, context)
  await f.opened.harness.waitForTask(ownLand, context)
  await f.opened.harness.abortTask(gate, context)
  await f.opened.harness.waitForTask(gate, context)
  await f.prepared.workspaces.runLifecycle(own.id, child, 'discard', context)
  await f.prepared.workspaces.runLifecycle(own.id, own.id, 'discard', context)
  await expect(access(own.workspace.path)).rejects.toThrow('ENOENT')
})
