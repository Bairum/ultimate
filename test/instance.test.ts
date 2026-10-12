import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, defineExtension, defineTask } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { LifecycleQueue, WorkspaceDoc } from '../server/workspaces/doc.ts'
import instance from '../extensions/instance/server.ts'
import subagents, { Subagents } from '../extensions/subagents/server.ts'
import { git } from '../server/workspaces/worktree.ts'
import { projectSettings } from '../server/project-setup.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { attach, temp, removeTemp, until } from './helpers.ts'

type Preview = { id: string; url: string; home: string; pid: number }
async function assertProject(preview: Preview, path: string, decision: boolean | null) {
  const client = await attach(preview)
  try {
    expect(client.system().execution.defaultCwd).toBe(path)
    expect(client.system().project.decision).toBe(decision)
    expect(client.system().persistence.path).toBe(join(preview.home, 'state.sqlite'))
    expect(client.system().process.pid).toBe(preview.pid)
  } finally {
    await client.close()
  }
  const response = await fetch(`${preview.url}/api/models`)
  expect(response.status).toBe(200)
  expect(await response.json()).toBeTruthy()
}

async function fixture() {
  const root = await temp('ultimate-preview-')
  const checkout = resolve('.')
  const source = join(root, 'source')
  await git(root, 'clone', '--no-hardlinks', checkout, source)
  // Cloning an isolated checkpoint can produce detached HEAD; lifecycle needs a captured branch.
  await git(source, 'switch', '-c', 'preview-source')
  await symlink(join(checkout, 'node_modules'), join(source, 'node_modules'))
  await writeFile(
    join(source, '.ultimate/settings.json'),
    JSON.stringify({
      isolates: { worktree: { setup: [`ln -s '${join(checkout, 'node_modules')}' node_modules`] } },
    }),
  )
  await writeFile(
    join(source, '.gitignore'),
    (await readFile(join(source, '.gitignore'), 'utf8')) + '\n/node_modules\n',
  )
  await git(source, 'add', '.ultimate/settings.json', '.gitignore')
  await git(source, 'commit', '-m', 'Configure preview fixture setup')
  new ProjectTrustStore(join(root, '.ultimate')).set(source, true)
  const prepared = await prepareHarness({
    ultimateRoot: source,
    projectRoot: source,
    home: join(root, 'home'),
    userHome: root,
    faux: true,
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const resources = new Map<string, unknown>()
  const cleanups: (() => Promise<void>)[] = []
  const host = {
    ...prepared,
    projectSettings: () => projectSettings(source, root),
    harness: () => opened.harness,
    metadata: Metadata,
    resource<T>(key: string, create: () => T): T {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onClose(cleanup: () => Promise<void>) {
      cleanups.push(cleanup)
    },
  }
  const extension = instance(host)
  prepared.registry.install(subagents(host))
  prepared.registry.install(extension)
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (
      last.role === 'user' &&
      typeof last.content === 'string' &&
      last.content.startsWith('CALL ')
    ) {
      const { tool, args } = JSON.parse(last.content.slice(5))
      return fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([fauxText('Finished')])
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  async function call(tool: string, args: object, id = opened.root.id) {
    const conversation = (await opened.harness.conversation(id, context))!
    await (
      await conversation.submit(
        { type: 'input', content: `CALL ${JSON.stringify({ tool, args })}` },
        context,
      )
    ).wait(context)
    const view = await conversation.viewState(context)
    const result = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
      ?.model?.[0]
    view.dispose()
    if (result?.role !== 'toolResult') throw new Error('Missing tool result')
    return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
  async function run(
    args: Parameters<NonNullable<typeof extension.tools>[number]['execute']>[0],
    id = opened.root.id,
    ctx = context,
  ) {
    const result = await extension.tools![0].execute(
      args,
      {
        conversationId: id,
        snapshot: opened.harness.snapshot.bind(opened.harness),
        output: () => {},
      } as never,
      ctx,
    )
    if (!result.content) throw new Error('Missing instance result')
    return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
  async function main(request = 'main-preview') {
    const workspace = await prepared.workspaces.describe(source, 'main', request)
    const id = await opened.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await configure(tx, conversation.id, {
        cwd: source,
        model: { provider: 'faux', modelId: 'faux-1' },
      })
      await prepared.workspaces.prepare(tx, conversation.id, workspace, 'main', request)
      return conversation.id
    }, context)
    await prepared.workspaces.ready(id, context)
    return { id, workspace: (await prepared.workspaces.snapshot(id, context))! }
  }
  async function close() {
    const previews = JSON.parse(await run({ action: 'list' })) as Preview[]
    for (const cleanup of cleanups) await cleanup()
    await opened.close()
    for (const preview of previews) await removeTemp(preview.home)
    await removeTemp(root)
  }
  return { root, source, prepared, opened, call, run, main, assertProject, close }
}

it('selects shared, isolated main and owned child checkouts on demand without trusting worktree config', async () => {
  const f = await fixture()
  try {
    expect(await f.call('instance', { action: 'start', subagent: 999999, faux: true })).toContain(
      'Unknown subagent',
    )
    const main = await f.main()
    expect(JSON.parse(await f.run({ action: 'list' }))).toEqual([])
    const own = JSON.parse(
      await f.call('instance', { action: 'start', faux: true }, main.id),
    ) as Preview
    for (const operation of ['land', 'discard'] as const)
      await expect(
        f.prepared.workspaces.runLifecycle(f.opened.root.id, main.id, operation, context),
      ).rejects.toThrow('preview hold')
    expect(
      await f.call(
        'subagent',
        { action: 'start', agent: 'worker', task: 'Finish without tools', isolate: 'worktree' },
        main.id,
      ),
    ).toContain('Isolate:')
    const child = Object.values(
      (await f.opened.harness.snapshot(Subagents, main.id, context))!.agents,
    )[0]
    const childWorkspace = (await f.prepared.workspaces.snapshot(child.conversationId, context))!
    expect(childWorkspace.source).toBe(main.workspace.path)
    expect(
      await f.call('instance', { action: 'start', subagent: child.conversationId, faux: true }),
    ).toContain('Unknown subagent')
    const shared = JSON.parse(await f.call('instance', { action: 'start', faux: true })) as Preview
    const selected = JSON.parse(
      await f.call(
        'instance',
        { action: 'start', subagent: child.conversationId, faux: true },
        main.id,
      ),
    ) as Preview
    expect(new Set([shared.url, own.url, selected.url]).size).toBe(3)
    expect(new Set([shared.home, own.home, selected.home, f.prepared.home]).size).toBe(4)
    await f.assertProject(shared, f.source, true)
    await f.assertProject(own, main.workspace.path, null)
    await f.assertProject(selected, childWorkspace.path, null)
    expect(await f.run({ action: 'start', faux: true })).toContain('At most three')
    for (const operation of ['land', 'discard'] as const)
      await expect(
        f.prepared.workspaces.runLifecycle(main.id, child.conversationId, operation, context),
      ).rejects.toThrow('preview hold')
    await f.run({ action: 'stop', id: selected.id })
    await removeTemp(selected.home)
    for (const preview of [shared, own]) {
      expect(JSON.parse(await f.call('instance', { action: 'stop', id: preview.id }))).toEqual({
        stopped: preview.id,
      })
      await removeTemp(preview.home)
    }
    expect(JSON.parse(await f.run({ action: 'list' }))).toEqual([])
    await f.prepared.workspaces.runLifecycle(main.id, child.conversationId, 'discard', context)
    await f.prepared.workspaces.runLifecycle(f.opened.root.id, main.id, 'discard', context)
    expect(await f.run({ action: 'start', faux: true }, main.id)).toContain('active, ready')
  } finally {
    await f.close()
  }
}, 120000)

it('reserves canonical homes and the three-instance limit across simultaneous starts', async () => {
  const f = await fixture()
  try {
    const hostAlias = join(f.root, 'host-alias')
    await symlink(f.prepared.home, hostAlias)
    for (const home of [f.prepared.home, hostAlias])
      expect(await f.run({ action: 'start', home, faux: true })).toContain('cannot share')
    const home = await temp('ultimate-preview-home-')
    const alias = join(f.root, 'preview-alias')
    await symlink(home, alias)
    const same = await Promise.all([
      f.run({ action: 'start', home, faux: true }),
      f.run({ action: 'start', home: alias, faux: true }),
    ])
    expect(same.filter((text) => text.includes('already owned'))).toHaveLength(1)
    const first = JSON.parse(same.find((text) => !text.includes('already owned'))!) as Preview
    const starts = await Promise.all(
      Array.from({ length: 3 }, () => f.run({ action: 'start', faux: true })),
    )
    expect(starts.filter((text) => text.includes('At most three'))).toHaveLength(1)
    const previews = [
      first,
      ...starts
        .filter((text) => !text.includes('At most three'))
        .map((text) => JSON.parse(text) as Preview),
    ]
    expect(new Set(previews.map((preview) => preview.url)).size).toBe(3)
    expect(new Set(previews.map((preview) => preview.home)).size).toBe(3)
    expect(await f.run({ action: 'start', home: alias, faux: true })).toContain('At most three')
    await f.run({ action: 'stop', id: previews[1].id })
    expect(await f.run({ action: 'start', home: alias, faux: true })).toContain('already owned')
    for (const preview of previews) {
      if (preview !== previews[1]) await f.run({ action: 'stop', id: preview.id })
      await removeTemp(preview.home)
    }
  } finally {
    await f.close()
  }
}, 120000)

it('rejects preparation and lifecycle overlap and releases leases after startup failure, abort and child exit', async () => {
  const f = await fixture()
  try {
    const main = await f.main()
    for (const preparation of ['pending', 'error'] as const) {
      await f.opened.harness.commit(async (tx) => {
        ;(await tx.doc(WorkspaceDoc, main.id)).workspace!.preparation = preparation
      }, context)
      expect(await f.run({ action: 'start', faux: true }, main.id)).toContain('active, ready')
    }
    await f.opened.harness.commit(async (tx) => {
      ;(await tx.doc(WorkspaceDoc, main.id)).workspace!.preparation = 'ready'
    }, context)
    const Gate = defineTask<null, { phase: 'hold' }, null>({
      name: 'test.preview-lifecycle-gate',
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
    f.prepared.registry.install(defineExtension({ name: 'preview-gate', tasks: [Gate] }))
    const gate = await f.opened.harness.commit(async (tx) => {
      const task = await tx.createTask(Gate, null, {
        conversationId: f.opened.root.id,
        ownership: { kind: 'conversation' },
        background: true,
      })
      ;(await tx.doc(LifecycleQueue)).children[String(main.id)] = [task]
      return task
    }, context)
    expect(await f.run({ action: 'start', faux: true }, main.id)).toContain(
      'lifecycle operation is in progress',
    )
    await f.opened.harness.abortTask(gate, context)
    const entry = join(main.workspace.path, 'server/main.ts')
    const original = await readFile(entry, 'utf8')
    await writeFile(entry, "throw new Error('preview startup failure')\n")
    const failedHome = join(f.root, 'failed-home')
    expect(await f.run({ action: 'start', home: failedHome, faux: true }, main.id)).toContain(
      'preview startup failure',
    )
    expect(JSON.parse(await f.run({ action: 'list' }))).toEqual([])
    await writeFile(entry, original)
    await f.prepared.workspaces.runLifecycle(f.opened.root.id, main.id, 'land', context)
    await writeFile(entry, 'setInterval(() => {}, 1000)\n')
    const controller = new AbortController()
    const abort = f.run({ action: 'start', home: failedHome, faux: true }, main.id, {
      ...context,
      abortSignal: controller.signal,
    })
    await until(async () => JSON.parse(await f.run({ action: 'list' })).length === 1)
    controller.abort()
    expect(await abort).toContain('AbortError')
    expect(JSON.parse(await f.run({ action: 'list' }))).toEqual([])
    await writeFile(entry, original)
    await f.prepared.workspaces.runLifecycle(f.opened.root.id, main.id, 'land', context)
    const preview = JSON.parse(
      await f.run({ action: 'start', home: failedHome, faux: true }, main.id),
    ) as Preview
    process.kill(preview.pid, 'SIGTERM')
    await until(async () => JSON.parse(await f.run({ action: 'list' })).length === 0)
    await f.prepared.workspaces.runLifecycle(f.opened.root.id, main.id, 'discard', context)
    expect(JSON.parse(await f.run({ action: 'stop', id: preview.id }))).toEqual({
      stopped: preview.id,
    })
    const reused = JSON.parse(
      await f.run({ action: 'start', home: failedHome, faux: true }),
    ) as Preview
    await f.run({ action: 'stop', id: reused.id })
  } finally {
    await f.close()
  }
}, 120000)
