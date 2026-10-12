import { mkdir, readFile, writeFile, access, symlink, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import workspaceExtension, { actions } from '../extensions/workspaces/server.ts'
import { workspaces } from '../extensions/workspaces/workspaces.ts'
import { git, setup } from '../extensions/workspaces/git.ts'
import self from '../extensions/self/server.ts'
import subagents, { Subagents } from '../extensions/subagents/server.ts'
import { prepareFauxServer, post, temp, until } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
  vi.unstubAllEnvs()
})
async function repository() {
  const directory = await temp('ultimate-workspaces-')
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
async function fixture(commands: string[] = [], existing?: Awaited<ReturnType<typeof repository>>) {
  const paths = existing ?? (await repository())
  if (!existing) {
    await mkdir(join(paths.projectRoot, 'agents'))
    await writeFile(
      join(paths.projectRoot, 'agents/worker.md'),
      '---\nname: worker\ndescription: Writes\nisolate: worktree\n---\nCommit the assigned change.\n',
    )
    await git(paths.projectRoot, 'add', '.')
    await git(paths.projectRoot, 'commit', '-m', 'worker definition')
  }
  const prepared = await prepareHarness({
    ...paths,
    userHome: paths.directory,
    ultimateRoot: paths.projectRoot,
    faux: true,
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const resources = new Map<string, unknown>()
  const restart = vi.fn<ExtensionHost['restart']>(async () => 'RESTART_CALLED')
  const host = {
    ...prepared,
    harness: () => opened.harness,
    metadata: Metadata,
    projectSettings: async () => ({ isolates: { worktree: { setup: commands } } }),
    extensions: () => [{ name: 'workspaces', enabled: true }],
    resource<T>(key: string, create: () => T): T {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    restart,
    build: () => ({ id: 'test-build' }),
    system: () => ({ process: {} }),
  } as unknown as ExtensionHost
  const service = workspaces(host)
  prepared.registry.install(workspaceExtension(host))
  prepared.registry.install(self(host))
  prepared.registry.install(subagents(host))
  let writes = 0
  prepared.registry.install(
    defineExtension({
      name: 'test-writing',
      tools: [
        defineTool({
          name: 'write_commit',
          description: 'Write and commit a change',
          parameters: Type.Object({}),
          async execute(_args, api) {
            writes++
            const cwd = api.env!.cwd
            await writeFile(join(cwd, 'change.txt'), 'change')
            await git(cwd, 'add', '.')
            await git(cwd, 'commit', '-m', 'workspace change')
            return { content: [{ type: 'text', text: 'committed' }] }
          },
        }),
      ],
    }),
  )
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    if (last.role === 'user' && text.startsWith('CALL ')) {
      const { tool, args } = JSON.parse(text.slice(5))
      return fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: 'toolUse' })
    }
    if (last.role === 'toolResult') return fauxAssistantMessage(text)
    return fauxAssistantMessage('finished')
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  cleanup.push(() => opened.close())
  const create = async () => {
    const result = await actions.create({}, { host } as ActionContext)
    return result.id
  }
  const call = async (id: ConversationId, tool: string, args: object = {}) => {
    const conversation = (await opened.harness.conversation(id, context))!
    await (
      await conversation.submit(
        { type: 'input', content: `CALL ${JSON.stringify({ tool, args })}` },
        context,
      )
    ).wait(context)
    await conversation.waitForIdle(context)
    const view = await conversation.viewState(context)
    try {
      return view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
        ?.model?.[0]
    } finally {
      view.dispose()
    }
  }
  return {
    ...paths,
    prepared,
    host,
    service,
    restart,
    create,
    call,
    get opened() {
      return opened
    },
    get writes() {
      return writes
    },
    reopen: async () => {
      await opened.close()
      opened = await prepared.open()
    },
  }
}
async function commit(path: string, name = 'change.txt') {
  await writeFile(join(path, name), name)
  await git(path, 'add', '.')
  await git(path, 'commit', '-m', name)
  return git(path, 'rev-parse', 'HEAD')
}
it('creates through the action; setup receives ULTIMATE_SOURCE and the first model request waits for ready', async () => {
  const f = await fixture()
  const sourceFile = join(f.directory, 'source-env')
  f.host.projectSettings = async () => ({
    isolates: { worktree: { setup: [`echo "$ULTIMATE_SOURCE" > '${sourceFile}'; sleep 0.3`] } },
  })
  let seen = ''
  f.prepared.faux!.setResponses([
    async () => {
      seen = (await f.service.get(id, context))!.state
      return fauxAssistantMessage('ready')
    },
  ])
  const id = await f.create()
  const pending = (await f.service.get(id, context))!
  expect(pending.state).toBe('preparing')
  expect(pending.path).toBe(join(f.home, 'worktrees', String(id)))
  const conversation = (await f.opened.harness.conversation(id, context))!
  expect((await conversation.agent(context)).cwd).toBe(pending.path)
  await (await conversation.submit({ type: 'input', content: 'go' }, context)).wait(context)
  expect(seen).toBe('ready')
  expect((await readFile(sourceFile, 'utf8')).trim()).toBe(f.projectRoot)
  expect(await git(pending.path, 'branch', '--show-current')).toBe(pending.branch)
  expect(await git(f.projectRoot, 'status', '--porcelain')).toBe('')
})
it('renders workspace preparation before project context in the first composed provider request', async () => {
  const paths = await repository()
  const marker = 'CHECKOUT_RULE_ULT_123: preserve the release manifest.'
  await writeFile(join(paths.projectRoot, 'AGENTS.md'), marker)
  await git(paths.projectRoot, 'add', 'AGENTS.md')
  await git(paths.projectRoot, 'commit', '-m', 'checkout instructions')
  const bin = join(paths.directory, 'bin')
  await mkdir(bin)
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh
if [ "$1 $2" = "worktree add" ]; then sleep 0.3; fi
exec /usr/bin/git "$@"
`,
    { mode: 0o755 },
  )
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  const prepared = await prepareFauxServer({
    ...paths,
    ultimateRoot: join(import.meta.dirname, '..'),
    userHome: paths.directory,
  })
  cleanup.push(() => prepared.close())
  const requests: string[] = []
  prepared.host.faux!.setResponses([
    (transcript) => {
      requests.push(
        JSON.stringify(transcript.messages.filter((message) => message.role === 'system')),
      )
      return fauxAssistantMessage('instructions read')
    },
  ])
  const running = await prepared.go()
  const server = { url: prepared.url }
  const id = (await post(server, '/api/extensions/workspaces/actions/create', { args: {} })).data
    .result.id
  const workspace = (
    await post(server, '/api/extensions/workspaces/actions/info', { args: { id } })
  ).data.result
  await expect(access(join(workspace.path, 'AGENTS.md'))).rejects.toThrow('ENOENT')
  const conversation = (await running.harness.conversation(id, context))!
  await (
    await conversation.submit({ type: 'input', content: 'Read the checkout rules.' }, context)
  ).wait(context)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toContain(marker)
  expect(await readFile(join(workspace.path, 'AGENTS.md'), 'utf8')).toBe(marker)
})
it('setup closes stdin so commands waiting for EOF finish', async () => {
  const paths = await repository()
  await setup(
    paths.projectRoot,
    paths.projectRoot,
    {
      isolates: { worktree: { setup: ['cat >/dev/null; echo eof > eof.txt'] } },
    },
    AbortSignal.timeout(2000),
  )
  expect(await readFile(join(paths.projectRoot, 'eof.txt'), 'utf8')).toBe('eof\n')
})
it('failed setup keeps its output tail, removes its empty branch, and blocks tools rather than writing in the source', async () => {
  const f = await fixture(['echo SETUP_OUTPUT_TAIL >&2; exit 1'])
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  expect(workspace.state).toBe('failed')
  expect(workspace.error).toContain('SETUP_OUTPUT_TAIL')
  expect(await git(f.projectRoot, 'branch', '--list', workspace.branch)).toBe('')
  const result = await f.call(id, 'write_commit')
  expect(result?.role === 'toolResult' && result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('Workspace setup failed:')
  expect(JSON.stringify(result)).toContain('start a new conversation')
  expect(f.writes).toBe(0)
  await expect(access(join(f.projectRoot, 'change.txt'))).rejects.toThrow('ENOENT')
})
it.each(['symlinked home mid-setup', 'branch creation before registration'])(
  'resumes preparation after a process crash: %s',
  async (scenario) => {
    const paths = await repository()
    const physicalHome = join(paths.directory, 'physical-state')
    await mkdir(physicalHome)
    await symlink(physicalHome, paths.home)
    const started = join(paths.directory, 'started')
    const gate = join(paths.directory, 'gate')
    const idFile = join(paths.directory, 'id')
    const commands = [`echo attempt >> '${started}'; while [ ! -f '${gate}' ]; do sleep 0.05; done`]
    const script = `
    import { writeFile } from 'node:fs/promises';
    import { prepareHarness, context } from './server/harness.ts';
    import extension, { actions } from './extensions/workspaces/server.ts';
    const paths = ${JSON.stringify(paths)};
    const prepared = await prepareHarness({ ...paths, ultimateRoot: paths.projectRoot, userHome: paths.directory, faux: true });
    let opened;
    const resources = new Map();
    const host = { ...prepared, harness: () => opened.harness, metadata: (await import('./server/metadata.ts')).Metadata,
      projectSettings: async () => ({ isolates: { worktree: { setup: ${JSON.stringify(commands)} } } }),
      extensions: () => [{ name: 'workspaces', enabled: true }],
      resource: (key, create) => { if (!resources.has(key)) resources.set(key, create()); return resources.get(key) } };
    prepared.registry.install(extension(host));
    opened = await prepared.open();
    await writeFile(${JSON.stringify(idFile)}, String((await actions.create({}, { host })).id));
    setInterval(() => {}, 1000);
  `
    const bin = join(paths.directory, 'bin')
    await mkdir(bin)
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh
if [ "$1 $2" = "worktree add" ]; then
  /usr/bin/git branch "$4" "$6" || exit 1
  echo branch > '${started}'
  while [ ! -f '${gate}' ]; do sleep 0.05; done
fi
exec /usr/bin/git "$@"
`,
      { mode: 0o755 },
    )
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(scenario === 'branch creation before registration'
          ? { PATH: `${bin}:${process.env.PATH}` }
          : {}),
      },
    })
    let output = ''
    child.stderr.on('data', (data) => {
      output += data.toString()
    })
    try {
      await until(async () => {
        if (child.exitCode !== null) throw new Error(output)
        return readFile(started, 'utf8').then(
          () => true,
          () => false,
        )
      })
      child.kill('SIGKILL')
      await once(child, 'exit')
      const id = Number(await readFile(idFile, 'utf8')) as ConversationId
      await writeFile(gate, '')
      const f = await fixture(commands, paths)
      await f.service.ready(id, context)
      const workspace = (await f.service.get(id, context))!
      expect(workspace.state).toBe('ready')
      expect(workspace.path).toBe(join(await realpath(physicalHome), 'worktrees', String(id)))
      expect((await readFile(started, 'utf8')).trim().split('\n')).toHaveLength(2)
      expect(await git(workspace.path, 'branch', '--show-current')).toBe(workspace.branch)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit')
      }
    }
  },
)
it('rejects a detached source and preserves existing paths and branches instead of adopting them', async () => {
  const f = await fixture()
  await git(f.projectRoot, 'switch', '--detach')
  await expect(f.create()).rejects.toThrow('Check out a branch first')
  await git(f.projectRoot, 'switch', 'main')
  for (const existing of ['path', 'branch'] as const) {
    const id = await f.opened.harness.commit(async (tx) => {
      const child = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      const workspace = await f.service.create(tx, child.id, f.projectRoot)
      if (existing === 'path') {
        await git(
          f.projectRoot,
          'worktree',
          'add',
          '-b',
          workspace.branch,
          workspace.path,
          workspace.base,
        )
        await writeFile(join(workspace.path, 'keep.txt'), 'keep')
      } else await git(f.projectRoot, 'branch', workspace.branch, workspace.base)
      return child.id
    }, context)
    await f.service.ready(id, context)
    const workspace = (await f.service.get(id, context))!
    expect(workspace.state).toBe('failed')
    expect(workspace.error).toContain(`Workspace ${existing} already exists`)
    expect(await git(f.projectRoot, 'rev-parse', workspace.branch)).toBe(workspace.base)
    expect(await readFile(join(workspace.path, 'keep.txt'), 'utf8').catch(() => undefined)).toBe(
      existing === 'path' ? 'keep' : undefined,
    )
  }
})
it('lands fast-forward, lists commits and paths, and is idempotent', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const tip = await commit(workspace.path)
  const result = await f.service.land(id, context)
  expect(result).toMatchObject({ landed: tip, paths: ['change.txt'] })
  expect(result.commits).toHaveLength(1)
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(tip)
  expect((await f.service.land(id, context)).text).toBe('Nothing to land.')
  expect((await f.service.get(id, context))!.landed).toBe(tip)
  expect(result.needsRestart).toBeUndefined()
  const alias = join(f.directory, 'running-clone')
  await symlink(f.projectRoot, alias)
  f.host.ultimateRoot = alias
  await mkdir(join(workspace.path, 'server'))
  await commit(workspace.path, 'server/change.ts')
  expect((await f.service.land(id, context)).needsRestart).toBe(true)
})
it('queued landing reads the current record after another workspace lands', async () => {
  const f = await fixture()
  const first = await f.create()
  const second = await f.create()
  await f.service.ready(first, context)
  await f.service.ready(second, context)
  await commit((await f.service.get(first, context))!.path)
  const bin = join(f.directory, 'bin')
  const started = join(f.directory, 'merge-started')
  const gate = join(f.directory, 'merge-gate')
  await mkdir(bin)
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = "merge" ]; then
  touch '${started}'
  while [ ! -f '${gate}' ]; do sleep 0.05; done
fi
exec /usr/bin/git "$@"
`,
    { mode: 0o755 },
  )
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  const landing = f.service.land(first, context)
  await until(() =>
    access(started).then(
      () => true,
      () => false,
    ),
  )
  const queued = f.service.land(second, context).catch((error: Error) => error)
  try {
    await actions.discard({ id: second }, { host: f.host } as ActionContext)
  } finally {
    await writeFile(gate, '')
  }
  await landing
  expect(await queued).toMatchObject({ message: 'Workspace is removed' })
})
it('refuses dirty workspaces, dirty targets, changed branches and diverged targets', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'change.txt'), 'dirty')
  await expect(f.service.land(id, context)).rejects.toThrow('Worktree is dirty')
  await git(workspace.path, 'add', '.')
  await git(workspace.path, 'commit', '-m', 'change')
  await writeFile(join(f.projectRoot, 'source.txt'), 'dirty')
  await expect(f.service.land(id, context)).rejects.toThrow('Target checkout is dirty')
  await git(f.projectRoot, 'add', '.')
  await git(f.projectRoot, 'commit', '-m', 'source')
  await expect(f.service.land(id, context)).rejects.toThrow(
    'update the workspace onto main and verify again',
  )
  await git(f.projectRoot, 'switch', '-c', 'changed')
  await expect(f.service.land(id, context)).rejects.toThrow('Target branch changed')
})
it('refuses another running conversation and queued input; own tool landing skips its own run and inbox', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await commit(workspace.path)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.prepared.faux!.setResponses([
    async () => {
      await gate
      return fauxAssistantMessage('done')
    },
  ])
  const conversation = (await f.opened.harness.conversation(id, context))!
  const submission = await conversation.submit({ type: 'input', content: 'hold' }, context)
  try {
    await expect(f.service.land(id, context)).rejects.toThrow('running')
    await expect(f.service.discard(id, context)).rejects.toThrow('running')
  } finally {
    release()
  }
  await submission.wait(context)
  await conversation.waitForIdle(context)
  f.prepared.faux!.setResponses([
    async () => {
      await conversation.submit(
        { type: 'input', content: 'queued steer', whenBusy: 'steer' },
        context,
      )
      return fauxAssistantMessage(fauxToolCall('workspace', { action: 'land' }), {
        stopReason: 'toolUse',
      })
    },
    fauxAssistantMessage('landed'),
  ])
  const result = await f.call(id, 'workspace', { action: 'land' })
  expect(result?.role === 'toolResult' && result.isError).toBe(false)
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(
    await git(workspace.path, 'rev-parse', 'HEAD'),
  )
})
it('discard refuses dirty, keeps the branch, and blocks removed-workspace tools', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'change.txt'), 'dirty')
  await expect(f.service.discard(id, context)).rejects.toThrow('modified or untracked')
  const tip = await commit(workspace.path)
  await actions.discard({ id }, { host: f.host } as ActionContext)
  expect(await git(f.projectRoot, 'rev-parse', workspace.branch)).toBe(tip)
  const result = await f.call(id, 'write_commit')
  expect(JSON.stringify(result)).toContain('This workspace was removed; start a new conversation')
  expect(f.writes).toBe(0)
  await expect(access(join(f.projectRoot, 'change.txt'))).rejects.toThrow('ENOENT')
})
it('isolated restart refuses before landing and accepts a clean running clone at the landed tip', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  expect(JSON.stringify(await f.call(id, 'restart'))).toContain('land your workspace into')
  expect(f.restart).not.toHaveBeenCalled()
  const workspace = (await f.service.get(id, context))!
  await commit(workspace.path)
  await f.service.land(id, context)
  expect(JSON.stringify(await f.call(id, 'restart'))).toContain('RESTART_CALLED')
  expect(f.restart).toHaveBeenCalledOnce()
  await writeFile(join(f.projectRoot, 'dirty.txt'), 'dirty')
  expect(JSON.stringify(await f.call(id, 'restart'))).toContain('land your workspace into')
  expect(f.restart).toHaveBeenCalledOnce()
})
it('starts a worker isolate, commits in the child and lands it through the parent tool', async () => {
  const f = await fixture()
  const result = await f.call(f.opened.root.id, 'subagent', {
    action: 'start',
    agent: 'worker',
    task: 'CALL {"tool":"write_commit","args":{}}',
    isolate: 'worktree',
  })
  expect(JSON.stringify(result)).toContain('committed')
  const child = Object.values(
    (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.agents,
  )[0]
  const workspace = (await f.service.get(child.conversationId, context))!
  expect(workspace.state).toBe('ready')
  await expect(access(join(f.projectRoot, 'change.txt'))).rejects.toThrow('ENOENT')
  const landed = await f.call(f.opened.root.id, 'subagent', {
    action: 'land',
    id: child.conversationId,
  })
  expect(JSON.stringify(landed)).toContain('Landed commits')
  expect(await readFile(join(f.projectRoot, 'change.txt'), 'utf8')).toBe('change')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(
    await git(workspace.path, 'rev-parse', 'HEAD'),
  )
})
