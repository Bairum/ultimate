import { access, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ActionContext } from '../server/actions.ts'
import type { JsonValue } from '@earendil-works/chord'
import type { ExtensionHost } from '../server/extensions.ts'
import workspaceExtension, { actions } from '../extensions/workspaces/server.ts'
import { git } from '../server/workspaces/worktree.ts'
import { fauxServer, post, temp } from './helpers.ts'
import { context } from '../server/harness.ts'

it('fails at factory initialization on absent or partial core service before creating resources', () => {
  for (const service of [
    undefined,
    {},
    { doc: {}, info: vi.fn<() => void>() },
    { doc: {}, runLifecycle: vi.fn<() => void>() },
    {
      doc: {},
      info: vi.fn<() => void>(),
      runLifecycle: vi.fn<() => void>(),
      snapshot: vi.fn<() => void>(),
    },
    {
      doc: {},
      info: vi.fn<() => void>(),
      runLifecycle: vi.fn<() => void>(),
      createLifecycle: vi.fn<() => void>(),
    },
  ]) {
    const host = { workspaces: service } as unknown as ExtensionHost
    expect(() => workspaceExtension(host)).toThrow('upgrade and restart the Ultimate core')
  }
})

it('validates ids and explicit discard confirmation, delegates info and lifecycle only to core', async () => {
  const service = {
    doc: {},
    createLifecycle: vi.fn<() => void>(),
    snapshot: vi.fn<() => void>(),
    info: vi.fn<(...args: unknown[]) => Promise<null>>().mockResolvedValue(null),
    runLifecycle: vi
      .fn<(...args: unknown[]) => Promise<{ ok: boolean }>>()
      .mockResolvedValue({ ok: true }),
  }
  const ctx = { host: { workspaces: service }, conversationId: 7 } as unknown as ActionContext
  expect(workspaceExtension(ctx.host).name).toBe('workspaces')
  for (const args of [
    null,
    {},
    { id: 0 },
    { id: -1 },
    { id: 1.5 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { id: '2' },
  ] as JsonValue[]) {
    expect(() => actions.info(args, ctx)).toThrow('Expected a workspace conversation id')
  }
  expect(() => actions.discard({ id: 9 }, ctx)).toThrow('Confirm clean-only discard')
  expect(service.runLifecycle).not.toHaveBeenCalled()
  await actions.info({ id: 9 }, ctx)
  await actions.land({ id: 9 }, ctx)
  await actions.discard({ id: 9, confirm: true }, ctx)
  expect(service.info.mock.calls[0][0]).toBe(9)
  expect(service.runLifecycle.mock.calls.map((call) => call.slice(0, 3))).toEqual([
    [7, 9, 'land'],
    [7, 9, 'discard'],
  ])
})

it('uses real core action guards, keeps branch/history on removal and shows factual last landing after a new tip', async () => {
  const directory = await temp('ultimate-workspace-actions-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.email', 'test@example.com')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await writeFile(join(projectRoot, 'base.txt'), 'base')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'base')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: directory,
    home: join(directory, 'state'),
  })
  try {
    const created = await post(server, '/api/conversations', {
      isolate: 'worktree',
      requestId: 'workspace-action-test',
    })
    expect(created.status).toBe(201)
    const id = created.data.id
    await server.host.workspaces.ready(id, context)
    const workspace = (await server.host.workspaces.info(id, context))!
    const action = (name: string, extra = {}) =>
      post(server, `/api/extensions/workspaces/actions/${name}`, {
        args: { id, ...extra },
        conversationId: id,
      })
    expect((await action('info')).data.result).toMatchObject(workspace)
    const noConfirmation = await action('discard')
    expect(noConfirmation.status).toBe(500)
    expect(noConfirmation.data.error).toContain('Confirm clean-only discard')
    await access(workspace.path)
    await writeFile(join(workspace.path, 'change.txt'), 'one')
    const dirty = await action('discard', { confirm: true })
    expect(dirty.status).toBe(500)
    expect(dirty.data.error).toContain('contains modified or untracked files')
    await git(workspace.path, 'add', '.')
    await git(workspace.path, 'commit', '-m', 'first tip')
    const firstTip = await git(workspace.path, 'rev-parse', 'HEAD')
    expect((await action('land')).status).toBe(200)
    expect(await git(projectRoot, 'rev-parse', 'HEAD')).toBe(firstTip)
    await writeFile(join(workspace.path, 'later.txt'), 'two')
    await git(workspace.path, 'add', '.')
    await git(workspace.path, 'commit', '-m', 'later tip')
    const laterTip = await git(workspace.path, 'rev-parse', 'HEAD')
    const updated = (await action('info')).data.result
    expect(updated).toMatchObject({
      landed: firstTip,
      ahead: 1,
      preparation: 'ready',
      state: 'active',
    })
    expect(laterTip).not.toBe(firstTip)
    expect((await action('discard', { confirm: true })).status).toBe(200)
    await expect(access(workspace.path)).rejects.toThrow('ENOENT')
    expect(await git(projectRoot, 'rev-parse', workspace.branch)).toBe(laterTip)
    expect((await action('info')).data.result).toMatchObject({
      state: 'discarded',
      landed: firstTip,
    })
    const conversation = await server.harness.conversation(id, context)
    expect(conversation).toBeDefined()
    const view = await conversation!.viewState(context)
    expect(
      view.value.entries.filter(
        (entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant',
      ),
    ).toHaveLength(0)
    view.dispose()
  } finally {
    await server.close()
  }
})
