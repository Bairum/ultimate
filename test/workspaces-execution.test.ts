import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentDoc, defineExtension, defineTask } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { git } from '../server/workspaces/worktree.ts'
import * as worktree from '../server/workspaces/worktree.ts'
import { fauxServer, post, sourceCopy, temp, until } from './helpers.ts'

const Gate = defineTask<null, { phase: 'hold' }, null>({
  name: 'test.actual-checkout-execution',
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
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).toReversed()) await close()
})
async function fixture() {
  const directory = await temp('ultimate-actual-execution-')
  const source = await sourceCopy(directory)
  const extension = join(source, '.ultimate/extensions/exec-checkout')
  await mkdir(extension, { recursive: true })
  await writeFile(
    join(extension, 'server.ts'),
    `export default { name: 'exec-checkout' }
export const actions = {
  global: () => ({ aggregate: true }),
  pwd: async (args, ctx) => (await ctx.exec('pwd', [], args ?? {})).stdout.trim(),
  fail: async (args, ctx) => ctx.exec(process.execPath, ['-e', 'process.exit(7)'], args ?? {}),
  wait: async (args, ctx) => ctx.exec(process.execPath, ['--input-type=module', '-e', \`import {writeFileSync,existsSync} from 'node:fs'; writeFileSync(\${JSON.stringify(args.entered)}, process.cwd()); while (!existsSync(\${JSON.stringify(args.release)})) await new Promise(resolve=>setTimeout(resolve,20))\`], {cwd: args.cwd}),
}`,
  )
  await git(source, 'init', '-b', 'release-candidate')
  await git(source, 'config', 'user.email', 'test@example.com')
  await git(source, 'config', 'user.name', 'Test')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'actual execution fixture')
  const server = await fauxServer({
    ultimateRoot: source,
    projectRoot: source,
    userHome: directory,
    home: join(directory, 'state'),
  })
  cleanups.push(() => server.close())
  server.host.registry.install(defineExtension({ name: 'actual-execution-test', tasks: [Gate] }))
  // Unscoped execution must not infer its checkout from the root conversation.
  const elsewhere = join(directory, 'elsewhere')
  await mkdir(elsewhere)
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(AgentDoc, server.root.id)).cwd = elsewhere
  }, context)
  const spawn = async (requestId: string) => {
    const created = await post(server, '/api/conversations', { isolate: 'worktree', requestId })
    expect(created.status).toBe(201)
    const id = created.data.id as ConversationId
    await server.host.workspaces.ready(id, context)
    return { id, workspace: (await server.host.workspaces.snapshot(id, context))! }
  }
  const main = await spawn('main')
  await writeFile(join(main.workspace.path, 'verified.txt'), 'verified')
  await git(main.workspace.path, 'add', '.')
  await git(main.workspace.path, 'commit', '-m', 'verified main')
  await server.host.workspaces.runLifecycle(main.id, main.id, 'land', context)
  const caller = await server.harness.commit(
    (tx) =>
      tx.createTask(Gate, null, {
        conversationId: main.id,
        ownership: { kind: 'conversation' },
        background: true,
      }),
    context,
  )
  const action = (name: string, args: unknown = {}, id?: ConversationId) =>
    post(server, `/api/extensions/exec-checkout/actions/${name}`, {
      args,
      ...(id === undefined ? {} : { conversationId: id }),
    })
  const prove = () =>
    server.host.workspaces.proveHostLanding(main.id, caller, main.workspace.path, context)
  return { directory, source, server, main, caller, spawn, action, prove }
}

it('admits the actual source lazily for unscoped exec and explicit override, including canonical aliases/subdirectories, without admitting non-exec globals', async () => {
  const f = await fixture()
  const sibling = await f.spawn('sibling')
  const alias = join(f.directory, 'source-alias')
  await symlink(f.source, alias)
  await mkdir(join(f.source, 'subdir'))
  await writeFile(join(f.source, 'subdir/.gitignore'), '*\n')
  // Keep source clean while testing a real subdirectory cwd.
  await git(f.source, 'add', 'subdir/.gitignore', '-f')
  await git(f.source, 'commit', '-m', 'subdirectory fixture')
  await git(f.main.workspace.path, 'merge', '--ff-only', await git(f.source, 'rev-parse', 'HEAD'))
  await f.server.harness.abortTask(f.caller, context)
  await f.server.harness.waitForTask(f.caller, context)
  await f.server.host.workspaces.runLifecycle(f.main.id, f.main.id, 'land', context)
  const caller = await f.server.harness.commit(
    (tx) =>
      tx.createTask(Gate, null, {
        conversationId: f.main.id,
        ownership: { kind: 'conversation' },
        background: true,
      }),
    context,
  )
  const proof = await f.server.host.workspaces.proveHostLanding(
    f.main.id,
    caller,
    f.main.workspace.path,
    context,
  )
  try {
    expect((await f.action('pwd')).data.error).toContain('Host apply reservation')
    expect((await f.action('pwd', { cwd: f.source }, sibling.id)).data.error).toContain(
      'Host apply reservation',
    )
    expect(
      (await f.action('pwd', { cwd: join(alias, 'subdir') }, sibling.id)).data.error,
    ).toContain('Host apply reservation')
    expect((await f.action('pwd', {}, sibling.id)).data.result).toBe(sibling.workspace.path)
    expect((await f.action('global', {}, 999999 as ConversationId)).data.result).toEqual({
      aggregate: true,
    })
  } finally {
    await proof.release(context)
  }
  expect((await f.action('pwd')).data.result).toBe(f.source)
  expect((await f.action('pwd', { cwd: join(alias, 'subdir') }, sibling.id)).data.result).toBe(
    join(f.source, 'subdir'),
  )
})

it.each(['unscoped', 'override'] as const)(
  'an in-flight %s command leases the actual checkout against land/proof and releases on success, failure and abort',
  async (mode) => {
    const f = await fixture()
    const sibling = await f.spawn('sibling')
    const entered = join(f.directory, 'entered')
    const release = join(f.directory, 'release')
    const scoped = mode === 'override' ? sibling.id : undefined
    const args = { entered, release, ...(scoped === undefined ? {} : { cwd: f.source }) }
    const running = f.action('wait', args, scoped)
    try {
      await until(() =>
        access(entered).then(
          () => true,
          () => false,
        ),
      )
      expect(await readFile(entered, 'utf8')).toBe(f.source)
      await expect(f.prove()).rejects.toThrow('execution admission')
      await expect(
        f.server.host.workspaces.runLifecycle(sibling.id, sibling.id, 'land', context),
      ).rejects.toThrow('execution admission')
    } finally {
      await writeFile(release, '')
    }
    expect((await running).status).toBe(200)
    const success = await f.prove()
    await success.release(context)
    expect(
      (await f.action('fail', scoped === undefined ? {} : { cwd: f.source }, scoped)).status,
    ).toBe(500)
    const failed = await f.prove()
    await failed.release(context)
    const abortedEntered = join(f.directory, 'aborted-entered')
    const abortedRelease = join(f.directory, 'aborted-release')
    const controller = new AbortController()
    const aborted = f.server.extensions.invoke(
      'exec-checkout',
      'wait',
      {
        entered: abortedEntered,
        release: abortedRelease,
        ...(scoped === undefined ? {} : { cwd: f.source }),
      },
      controller.signal,
      scoped,
    )
    const outcome = aborted.then(
      () => undefined,
      (error: Error) => error,
    )
    try {
      await until(() =>
        access(abortedEntered).then(
          () => true,
          () => false,
        ),
      )
      await expect(f.prove()).rejects.toThrow('execution admission')
    } finally {
      controller.abort()
      await writeFile(abortedRelease, '')
    }
    expect((await outcome)?.message).toContain('aborted')
    const released = await f.prove()
    await released.release(context)
  },
)

it('preserves scoped caller readiness even when its explicit execution cwd is a healthy source', async () => {
  const f = await fixture()
  await f.server.harness.abortTask(f.caller, context)
  await f.server.harness.waitForTask(f.caller, context)
  await f.server.host.workspaces.runLifecycle(f.main.id, f.main.id, 'discard', context)
  expect((await f.action('pwd', { cwd: f.source }, f.main.id)).data.error).toContain('discarded')
  expect((await f.action('pwd')).data.result).toBe(f.source)
})

it('blocks both dispatcher paths during a real source lifecycle paused before FF', async () => {
  const f = await fixture()
  const sibling = await f.spawn('queued-source')
  await writeFile(join(sibling.workspace.path, 'queued.txt'), 'queued')
  await git(sibling.workspace.path, 'add', '.')
  await git(sibling.workspace.path, 'commit', '-m', 'queued source mutation')
  const realGit = worktree.git
  let enter!: () => void
  let release!: () => void
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
  const landing = f.server.host.workspaces.runLifecycle(sibling.id, sibling.id, 'land', context)
  await entered
  try {
    expect((await f.action('pwd')).data.error).toContain('lifecycle operation')
    expect((await f.action('pwd', { cwd: f.source }, f.main.id)).data.error).toContain(
      'lifecycle operation',
    )
  } finally {
    release()
    await landing
  }
  expect((await f.action('pwd')).data.result).toBe(f.source)
})

it('leases an explicitly selected own checkout against discard without relying on the caller cwd', async () => {
  const f = await fixture()
  const entered = join(f.directory, 'own-entered')
  const release = join(f.directory, 'own-release')
  const running = f.action('wait', { entered, release, cwd: f.main.workspace.path })
  try {
    await until(() =>
      access(entered).then(
        () => true,
        () => false,
      ),
    )
    expect(await readFile(entered, 'utf8')).toBe(f.main.workspace.path)
    await expect(
      f.server.host.workspaces.runLifecycle(f.main.id, f.main.id, 'discard', context),
    ).rejects.toThrow('execution admission')
  } finally {
    await writeFile(release, '')
  }
  expect((await running).status).toBe(200)
  await f.server.harness.abortTask(f.caller, context)
  await f.server.harness.waitForTask(f.caller, context)
  await f.server.host.workspaces.runLifecycle(f.main.id, f.main.id, 'discard', context)
  expect((await f.action('pwd', { cwd: f.main.workspace.path })).data.error).toContain('discarded')
})

it('admits actual override targets only after real preparation, even for a ready scoped caller or unscoped action', async () => {
  const f = await fixture()
  const sibling = await f.spawn('ready-caller')
  const entered = join(f.directory, 'setup-entered')
  const release = join(f.directory, 'setup-release')
  await writeFile(
    join(f.source, '.ultimate/settings.json'),
    JSON.stringify({
      isolates: {
        worktree: {
          setup: [`touch '${entered}'; while [ ! -f '${release}' ]; do sleep 0.05; done`],
        },
      },
    }),
  )
  const created = await post(f.server, '/api/conversations', {
    isolate: 'worktree',
    requestId: 'pending-actual',
  })
  const id = created.data.id as ConversationId
  try {
    expect(created.status).toBe(201)
    await until(() =>
      access(entered).then(
        () => true,
        () => false,
      ),
    )
    const workspace = (await f.server.host.workspaces.snapshot(id, context))!
    expect(workspace.preparation).toBe('pending')
    expect((await f.action('pwd', { cwd: workspace.path })).data.error).toContain(
      'preparation is pending',
    )
    expect((await f.action('pwd', { cwd: workspace.path }, sibling.id)).data.error).toContain(
      'preparation is pending',
    )
    expect((await f.action('pwd', { cwd: f.source }, id)).data.error).toContain(
      'preparation is pending',
    )
  } finally {
    await writeFile(release, '')
    await f.server.host.workspaces.ready(id, context)
  }
  const workspace = (await f.server.host.workspaces.snapshot(id, context))!
  expect((await f.action('pwd', { cwd: workspace.path }, sibling.id)).data.result).toBe(
    workspace.path,
  )
})
