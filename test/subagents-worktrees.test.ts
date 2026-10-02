import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { projectSettings } from '../server/project-setup.ts'
import { mkdir, readFile, rm, writeFile, access, symlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { afterEach, expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { ActionContext } from '../server/actions.ts'
import subagents, { actions, Subagents } from '../extensions/subagents/server.ts'
import { create, git, discard } from '../extensions/subagents/isolates/worktree.ts'
import { temp, until } from './helpers.ts'

const directories: string[] = []
const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
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
    Object.values((await opened.harness.snapshot(Subagents, opened.root.id, context))?.agents ?? {})
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
  'isolates writes, lands once, aborts conflicts cleanly and discards while retaining commits (fork: %s)',
  async (fork) => {
    const f = await fixture()
    expect(await f.call({ action: 'start', agent: 'worker', task: 'write', fork })).toContain(
      'Isolate:',
    )
    const child = (await f.children())[0]
    const workspace = child.isolate!
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
      'Rebase failed: conflict.txt',
    )
    expect(await git(workspace.path, 'status', '--porcelain')).toBe('')
    expect(await git(f.project, 'status', '--porcelain')).toBe('')
    expect(await f.call({ action: 'discard', id: child.conversationId })).toContain(
      `kept branch ${workspace.branch}`,
    )
    await expect(access(workspace.path)).rejects.toThrow('ENOENT')
    expect(await git(f.project, 'branch', '--list', workspace.branch)).toContain(workspace.branch)
    expect((await f.children())[0].isolate?.state).toBe('discarded')
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
  expect((await f.children())[0]).toEqual(before)
  const index = (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!
  const call = Object.keys(index.actions)[0]
  expect((await create(f.project, f.home, 'worker', call)).record).toEqual(before.isolate)
}, 20000)
it('lets the call override the definition isolate and reports omitted parent changes', async () => {
  const f = await fixture()
  await f.call({ action: 'start', agent: 'worker', task: 'inspect', isolate: 'none' })
  expect((await f.children())[0].isolate).toBeUndefined()
  await writeFile(join(f.project, 'uncommitted.txt'), 'parent only')
  expect(await f.call({ action: 'start', agent: 'worker', task: 'inspect' })).toContain(
    'parent has uncommitted changes',
  )
  const isolate = (await f.children())[1].isolate!
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
  expect(await git(f.project, 'worktree', 'list', '--porcelain')).toBe(before)
})
it('reads an isolate with its commits ahead of the parent for the Agents tab', async () => {
  const f = await fixture()
  await f.call({ action: 'start', agent: 'worker', task: 'write' })
  await f.call({ action: 'start', agent: 'worker', task: 'inspect', isolate: 'none' })
  const [child, plain] = await f.children()
  const parent = f.opened.root.id
  const ctx = {
    host: { projectRoot: f.project, ultimateRoot: f.project, harness: () => f.opened.harness },
  } as unknown as ActionContext
  const read = () => actions.isolate({ parent, id: child.conversationId }, ctx)
  expect(await actions.isolate({ parent, id: plain.conversationId }, ctx)).toBeNull()
  await expect(actions.isolate({ id: child.conversationId }, ctx)).rejects.toThrow('required')
  expect(await read()).toEqual({ ...child.isolate, ahead: 0 })
  await git(child.isolate!.path, 'add', '.')
  await git(child.isolate!.path, 'commit', '-m', 'child change')
  expect(await read()).toEqual({ ...child.isolate, ahead: 1 })
  const landed = await actions.land(
    { id: child.conversationId },
    { ...ctx, conversationId: parent },
  )
  expect(await read()).toEqual({ ...child.isolate, landed: landed.landed, ahead: 0 })
  await actions.discard({ id: child.conversationId }, { ...ctx, conversationId: parent })
  await git(f.project, 'branch', '-D', child.isolate!.branch)
  expect(await read()).toMatchObject({ state: 'discarded', ahead: null })
})

it('rechecks queued lifecycle operations and refuses messages during land', async () => {
  const f = await fixture()
  await f.call({ action: 'start', agent: 'worker', task: 'write' })
  await f.call({ action: 'start', agent: 'worker', task: 'inspect' })
  const [first, second] = await f.children()
  await git(first.isolate!.path, 'add', '.')
  await git(first.isolate!.path, 'commit', '-m', 'child change')
  await writeFile(join(f.project, 'parent.txt'), 'parent')
  await git(f.project, 'add', '.')
  await git(f.project, 'commit', '-m', 'parent change')
  const hook = join(await git(f.project, 'rev-parse', '--absolute-git-dir'), 'hooks/pre-rebase')
  const entered = join(f.home, 'entered')
  const release = join(f.home, 'release')
  await writeFile(
    hook,
    `#!/bin/sh\ntouch '${entered}'\nwhile [ ! -f '${release}' ]; do sleep 0.05; done\n`,
  )
  await chmod(hook, 0o755)
  const ctx = {
    host: { projectRoot: f.project, ultimateRoot: f.project, harness: () => f.opened.harness },
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
  await access(second.isolate!.path)
  await child.abort(context)
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
  expect((await f.children())[0].isolate?.landed).toBeUndefined()
})
