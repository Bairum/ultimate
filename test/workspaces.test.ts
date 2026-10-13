import { mkdir, readdir, readFile, writeFile, access, symlink, realpath } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, JsonObject, TaskId } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import workspaceExtension, { actions } from '../extensions/workspaces/server.ts'
import { Workspaces, workspaces } from '../extensions/workspaces/workspaces.ts'
import { git, setup } from '../extensions/workspaces/git.ts'
import type { LanderEntry } from '../extensions/workspaces/types.ts'
import { exclusiveSlot } from '../extensions/exclusive-commands/slot.ts'
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
  // As the server: openers run each time the harness opens, cleanups each time it closes.
  const openers: (() => Promise<void>)[] = []
  const closers: (() => Promise<void>)[] = []
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
    onOpen: (callback: () => Promise<void>) => openers.push(callback),
    onClose: (close: () => Promise<void>) => closers.push(close),
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
            return { output: [{ type: 'text', text: 'committed' }] }
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
  for (const open of openers) await open()
  cleanup.push(async () => {
    for (const close of closers) await close()
    await opened.close()
  })
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
      for (const close of closers) await close()
      await opened.close()
      opened = await prepared.open()
      for (const open of openers) await open()
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
      resource: (key, create) => { if (!resources.has(key)) resources.set(key, create()); return resources.get(key) },
      onOpen: () => {}, onClose: () => {} };
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
  expect(result).toMatchObject({
    landed: tip,
    paths: ['change.txt'],
    files: [{ path: 'change.txt', added: 1, removed: 0 }],
  })
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
it('refuses dirty workspaces, changed branches and diverged targets', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'change.txt'), 'dirty')
  await expect(f.service.land(id, context)).rejects.toThrow('Worktree is dirty')
  await git(workspace.path, 'add', '.')
  await git(workspace.path, 'commit', '-m', 'change')
  await writeFile(join(f.projectRoot, 'source.txt'), 'dirty')
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
async function submitted(f: Awaited<ReturnType<typeof fixture>>, id: ConversationId) {
  await until(async () => {
    const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
    return !index.queue.length && !Object.keys(index.landers).length
  })
  const conversation = (await f.opened.harness.conversation(id, context))!
  await conversation.waitForIdle(context)
  const view = await conversation.viewState(context)
  try {
    return view.value.entries
      .filter((entry) => entry.kind === 'pi.user')
      .map((entry) => JSON.stringify(entry.model))
      .filter((text) => text.includes('[lander]'))
  } finally {
    view.dispose()
  }
}
/** The lander conversation of the project source and its `ultimate.lander` log. */
async function landerLog(f: Awaited<ReturnType<typeof fixture>>) {
  const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
  const id = index.landerConversations[await realpath(f.projectRoot)] as ConversationId
  const conversation = (await f.opened.harness.conversation(id, context))!
  const view = await conversation.viewState(context)
  try {
    return {
      id,
      metadata: await f.opened.harness.snapshot(Metadata, id, context),
      cwd: (await conversation.agent(context)).cwd,
      kinds: view.value.entries.map((entry) => entry.kind),
      log: view.value.entries
        .filter((entry) => entry.kind === 'ultimate.lander')
        .map((entry) => entry.data as LanderEntry),
    }
  } finally {
    view.dispose()
  }
}
async function lander(settings: JsonObject, existing?: Awaited<ReturnType<typeof repository>>) {
  const f = await fixture([], existing)
  f.host.projectSettings = async () => ({ lander: settings })
  return f
}
it('lands two submissions in order onto a moved target and reports both', async () => {
  const f = await lander({ checks: ['test -f base.txt'] })
  const first = await f.create()
  const second = await f.create()
  await f.service.ready(first, context)
  await f.service.ready(second, context)
  const one = (await f.service.get(first, context))!
  const two = (await f.service.get(second, context))!
  await commit(one.path, 'one.txt')
  await commit(two.path, 'two.txt')
  await commit(f.projectRoot, 'moved.txt')
  const submittedFirst = await f.call(first, 'workspace', { action: 'submit' })
  expect(JSON.stringify(submittedFirst)).toContain('position')
  await f.service.submit(second, context)
  const [reportOne] = await submitted(f, first)
  const [reportTwo] = await submitted(f, second)
  expect(reportOne).toContain('landed as')
  expect(reportOne).toContain('one.txt')
  expect(reportOne).toContain('Not pushed.')
  expect(reportTwo).toContain('two.txt')
  expect(await git(f.projectRoot, 'log', '--first-parent', '--format=%s', '-3')).toMatch(
    new RegExp(
      `^Merge .* from W${second} into main\nMerge .* from W${first} into main\nmoved.txt$`,
    ),
  )
  expect(await git(f.projectRoot, 'status', '--porcelain')).toBe('')
  for (const name of ['one.txt', 'two.txt', 'moved.txt'])
    expect(await readFile(join(f.projectRoot, name), 'utf8')).toBe(name)
  expect((await f.service.get(second, context))!.landed).toBe(
    await git(f.projectRoot, 'rev-parse', 'HEAD'),
  )
  // Both submissions logged into one lander conversation, each ending with its landed outcome.
  const { id, metadata, cwd, kinds, log } = await landerLog(f)
  expect(metadata).toEqual({ title: 'Lander · main', label: 'lander' })
  expect(cwd).toMatch(/\/lander\/[0-9a-f]{12}$/)
  expect(kinds.every((kind) => kind === 'ultimate.lander')).toBe(true)
  expect(reportOne).toContain(`lander conversation #${id}`)
  const [submissionOne, submissionTwo] = [...new Set(log.map((line) => line.submission))]
  const firstLog = log.filter((line) => line.submission === submissionOne)
  expect(firstLog.map((line) => line.step ?? line.outcome)).toEqual([
    'queued',
    'started',
    'preparing',
    'merging',
    'setting up',
    'checking: test -f base.txt',
    'checked: test -f base.txt',
    'fast-forwarding',
    'landed',
  ])
  expect(firstLog[6].check).toEqual({ command: 'test -f base.txt', result: 'passed' })
  const landedOne = firstLog.at(-1)!
  expect(landedOne).toMatchObject({ conversationId: first, outcome: 'landed' })
  expect(landedOne.commits).toEqual([
    expect.stringContaining(`from W${first} into main`),
    expect.stringContaining('one.txt'),
  ])
  expect(landedOne.paths).toContain('one.txt')
  expect(landedOne.pushed).toBeUndefined()
  expect(log.filter((line) => line.submission === submissionTwo).at(-1)).toMatchObject({
    conversationId: second,
    outcome: 'landed',
    sha: await git(f.projectRoot, 'rev-parse', 'HEAD'),
  })
  const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
  expect(index.results[submissionTwo]).toMatchObject({ outcome: 'landed' })
  // The lander conversation has no workspace and is no main: it can neither submit nor land.
  for (const action of ['submit', 'land'])
    expect(JSON.stringify(await f.call(id, 'workspace', { action }))).toContain(
      'Only a top-level main conversation',
    )
})
it('accepts a second submission while the lander is still landing the first', async () => {
  const f = await lander({ checks: ['sleep 2'] })
  const first = await f.create()
  const second = await f.create()
  await f.service.ready(first, context)
  await f.service.ready(second, context)
  await commit((await f.service.get(first, context))!.path, 'one.txt')
  await commit((await f.service.get(second, context))!.path, 'two.txt')
  const one = await f.service.submit(first, context)
  const index = () => f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
  // While it lands, the queue entry records each step as it happens.
  await until(async () =>
    (await index())!.queue.some(
      (item) => item.state === 'landing' && item.step === 'checking: sleep 2',
    ),
  )
  expect((await index())!.queue[0].steps.map((row) => row.step)).toEqual([
    'queued',
    'started',
    'preparing',
    'merging',
    'setting up',
    'checking: sleep 2',
  ])
  const two = await f.service.submit(second, context)
  expect(two.position).toBe(2)
  expect((await index())!.queue[1]).toMatchObject({
    state: 'queued',
    steps: [{ step: 'queued' }],
  })
  expect((await submitted(f, second))[0]).toContain('landed as')
  // Finished, the steps move into the result, with the check's outcome.
  const results = (await index())!.results
  for (const { id } of [one, two]) {
    expect(results[id].steps.at(-1)).toMatchObject({ step: 'fast-forwarding' })
    expect(results[id].steps).toContainEqual(
      expect.objectContaining({ check: { command: 'sleep 2', result: 'passed' } }),
    )
  }
  // The second was queued while the first landed: its log lines still name their own submission.
  const { log } = await landerLog(f)
  const queuedTwo = log.findIndex((line) => line.submission === two.id)
  expect(log.slice(queuedTwo).some((line) => line.submission === one.id)).toBe(true)
  expect(
    log.filter((line) => line.submission === two.id).map((line) => line.step ?? line.outcome),
  ).toEqual(results[two.id].steps.map((row) => row.step).concat('landed'))
})

it('reports a conflicting submission and leaves the target untouched', async () => {
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'base.txt'), 'workspace')
  await commit(workspace.path)
  await writeFile(join(f.projectRoot, 'base.txt'), 'target')
  const head = await commit(f.projectRoot)
  await f.service.submit(id, context)
  const [report] = await submitted(f, id)
  expect(report).toContain('conflicts with main in:')
  expect(report).toContain('base.txt')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
  expect((await f.service.get(id, context))!.landed).toBeUndefined()
})
it('reports a failing check with its output, reruns flaky checks, and leaves a failed target untouched', async () => {
  const f = await lander({ checks: ['echo CHECK_OUTPUT_TAIL; test ! -f fail.txt'] })
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const head = await git(f.projectRoot, 'rev-parse', 'HEAD')
  await commit(workspace.path, 'fail.txt')
  await f.service.submit(id, context)
  const [report] = await submitted(f, id)
  expect(report).toContain('check failed twice')
  expect(report).toContain('CHECK_OUTPUT_TAIL')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
  const failed = (await landerLog(f)).log
  expect(failed.filter((line) => line.check).map((line) => line.check!.result)).toEqual(['failed'])
  expect(failed.at(-1)).toMatchObject({
    outcome: 'failed',
    reason: 'check failed twice: echo CHECK_OUTPUT_TAIL; test ! -f fail.txt',
    output: expect.stringContaining('CHECK_OUTPUT_TAIL'),
  })
  expect(failed.at(-1)!.sha).toBeUndefined()
  const marker = join(f.directory, 'flaky')
  f.host.projectSettings = async () => ({
    lander: { checks: [`if [ -f '${marker}' ]; then exit 0; fi; touch '${marker}'; exit 1`] },
  })
  await git(workspace.path, 'rm', '-q', 'fail.txt')
  await git(workspace.path, 'commit', '-qm', 'fix')
  await f.service.submit(id, context)
  const reports = await submitted(f, id)
  expect(reports.at(-1)).toContain('landed as')
  expect(reports.at(-1)).toContain('Flaky: if [')
  const flaky = (await landerLog(f)).log
  expect(flaky.findLast((line) => line.check)!.check).toMatchObject({ result: 'flaky' })
  expect(flaky.at(-1)).toMatchObject({
    outcome: 'landed',
    flaky: [expect.stringContaining('if [')],
  })
})
it('fetches, merges and pushes the target to the configured remote', async () => {
  const paths = await repository()
  const bare = join(paths.directory, 'remote.git')
  await git(paths.directory, 'init', '-q', '--bare', '-b', 'main', bare)
  await git(paths.projectRoot, 'remote', 'add', 'origin', bare)
  await git(paths.projectRoot, 'push', '-q', 'origin', 'main')
  const other = join(paths.directory, 'other')
  await git(paths.directory, 'clone', '-q', bare, other)
  await git(other, 'config', 'user.email', 'test@example.com')
  await git(other, 'config', 'user.name', 'Test')
  const remoteTip = await commit(other, 'remote.txt')
  await git(other, 'push', '-q', 'origin', 'main')
  const f = await lander({ push: 'origin' }, paths)
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path, 'local.txt')
  await f.service.submit(id, context)
  const [report] = await submitted(f, id)
  expect(report).toContain('Pushed to origin/main.')
  expect((await landerLog(f)).log.at(-1)).toMatchObject({
    outcome: 'landed',
    sha: await git(f.projectRoot, 'rev-parse', 'HEAD'),
    pushed: 'origin/main',
  })
  const pushed = await git(bare, 'rev-parse', 'main')
  expect(pushed).toBe(await git(f.projectRoot, 'rev-parse', 'HEAD'))
  await git(bare, 'merge-base', '--is-ancestor', remoteTip, pushed)
  expect(await git(bare, 'show', `${pushed}:local.txt`)).toBe('local.txt')
})
it('lands past unrelated dirty files in the target but not over overlapping ones', async () => {
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(f.projectRoot, 'unrelated.txt'), 'dirty')
  const tip = await commit(workspace.path)
  await f.service.submit(id, context)
  expect((await submitted(f, id))[0]).toContain('landed as')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(tip)
  expect(await readFile(join(f.projectRoot, 'unrelated.txt'), 'utf8')).toBe('dirty')
  await writeFile(join(f.projectRoot, 'overlap.txt'), 'dirty')
  await commit(workspace.path, 'overlap.txt')
  await expect(f.service.land(id, context)).rejects.toThrow('overlap.txt')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(tip)
  await f.service.submit(id, context)
  const reports = await submitted(f, id)
  expect(reports.at(-1)).toContain('refused the fast-forward')
  expect(reports.at(-1)).toContain('overlap.txt')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(tip)
})
it('runs lander checks only while holding the exclusive command slot', async () => {
  const f = await lander({ checks: ['true'] })
  const id = await f.create()
  await f.service.ready(id, context)
  const head = await git(f.projectRoot, 'rev-parse', 'HEAD')
  const tip = await commit((await f.service.get(id, context))!.path)
  const slot = exclusiveSlot(f.host)
  await slot.acquire('pnpm test')
  try {
    await f.service.submit(id, context)
    await until(() => slot.queue.some((waiter) => waiter.command === 'lander: true'))
    const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
    expect(index.queue[0]).toMatchObject({ state: 'landing', step: 'checking: true' })
    expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
  } finally {
    slot.release()
  }
  expect((await submitted(f, id))[0]).toContain('landed as')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(tip)
})
it('counts checkouts by state, commits and uncommitted changes, and measures their disk', async () => {
  const f = await fixture()
  const landed = await f.create()
  const ahead = await f.create()
  const dirty = await f.create()
  const removed = await f.create()
  for (const id of [landed, ahead, dirty, removed]) await f.service.ready(id, context)
  await commit((await f.service.get(landed, context))!.path)
  await f.service.land(landed, context)
  await commit((await f.service.get(ahead, context))!.path, 'ahead.txt')
  await writeFile(join((await f.service.get(dirty, context))!.path, 'dirty.txt'), 'dirty')
  await f.service.discard(removed, context)
  const stats = await actions.stats({}, { host: f.host } as ActionContext)
  expect({ ...stats, bytes: undefined }).toEqual({
    total: 4,
    ready: 3,
    preparing: 0,
    failed: 0,
    removed: 1,
    landed: 1,
    ahead: 1,
    fresh: 1,
    dirty: 1,
    bytes: undefined,
  })
  expect(stats.bytes).toBeGreaterThan(0)
  // Counting never removes anything.
  expect((await f.service.get(landed, context))!.state).toBe('ready')
})
it('kills the whole process group of a running check when the lander is aborted', async () => {
  const f = await fixture()
  const pidFile = join(f.directory, 'child.pid')
  f.host.projectSettings = async () => ({
    lander: { checks: [`sleep 300 & echo $! > '${pidFile}'; wait`] },
  })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, context)
  await until(() =>
    readFile(pidFile, 'utf8').then(
      (text) => text.trim() !== '',
      () => false,
    ),
  )
  const pid = Number(await readFile(pidFile, 'utf8'))
  expect(() => process.kill(pid, 0)).not.toThrow()
  const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
  await f.opened.harness.abortTask(Object.values(index.landers)[0] as TaskId, context)
  await until(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, 5000)
  expect(exclusiveSlot(f.host).command).toBeUndefined()
})
it('runs worktree setup on the merged revision before the checks of every submission', async () => {
  const f = await fixture()
  await writeFile(join(f.projectRoot, '.gitignore'), 'have.txt\n')
  await writeFile(join(f.projectRoot, 'want.txt'), 'one')
  await git(f.projectRoot, 'add', '.')
  await git(f.projectRoot, 'commit', '-qm', 'setup inputs')
  f.host.projectSettings = async () => ({
    isolates: { worktree: { setup: ['cp want.txt have.txt'] } },
    lander: { checks: ['cmp want.txt have.txt'] },
  })
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await commit(workspace.path, 'first.txt')
  await f.service.submit(id, context)
  expect((await submitted(f, id))[0]).toContain('landed as')
  await writeFile(join(workspace.path, 'want.txt'), 'two')
  await git(workspace.path, 'commit', '-qam', 'needs setup')
  await f.service.submit(id, context)
  const reports = await submitted(f, id)
  expect(reports.at(-1)).toContain('landed as')
  expect(reports.at(-1)).not.toContain('Flaky')
})
it('fast-forwards the target inside the worktree that has it checked out', async () => {
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await git(f.projectRoot, 'switch', '-q', '-c', 'other')
  const elsewhere = join(f.directory, 'elsewhere')
  await git(f.projectRoot, 'worktree', 'add', '-q', elsewhere, 'main')
  await f.service.submit(id, context)
  expect((await submitted(f, id))[0]).toContain('landed as')
  expect(await readFile(join(elsewhere, 'change.txt'), 'utf8')).toBe('change.txt')
  expect(await git(elsewhere, 'status', '--porcelain')).toBe('')
  expect(await git(elsewhere, 'rev-parse', 'HEAD')).toBe(
    await git(f.projectRoot, 'rev-parse', 'main'),
  )
  expect(await git(f.projectRoot, 'status', '--porcelain')).toBe('')
})
async function withRemote() {
  const paths = await repository()
  const bare = join(paths.directory, 'remote.git')
  await git(paths.directory, 'init', '-q', '--bare', '-b', 'main', bare)
  await git(paths.projectRoot, 'remote', 'add', 'origin', bare)
  await git(paths.projectRoot, 'push', '-q', 'origin', 'main')
  return { paths, bare }
}
/** Git without a PATH wrapper that holds commands. */
const realGit = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd })
async function holdGit(directory: string, command: string) {
  const bin = join(directory, 'bin')
  const started = join(directory, `${command}-started`)
  const gate = join(directory, `${command}-gate`)
  await mkdir(bin, { recursive: true })
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = "${command}" ] && [ ! -f '${gate}' ]; then
  touch '${started}'
  while [ ! -f '${gate}' ]; do sleep 0.05; done
fi
exec /usr/bin/git "$@"
`,
    { mode: 0o755 },
  )
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  return {
    started: () =>
      until(() =>
        access(started).then(
          () => true,
          () => false,
        ),
      ),
    release: () => writeFile(gate, ''),
  }
}
it('pushes the checked commit even when the target advances before the push', async () => {
  const { paths, bare } = await withRemote()
  const f = await lander({ push: 'origin' }, paths)
  const submitter = await f.create()
  const other = await f.create()
  await f.service.ready(submitter, context)
  await f.service.ready(other, context)
  await commit((await f.service.get(submitter, context))!.path, 'submitted.txt')
  const push = await holdGit(f.directory, 'push')
  await f.service.submit(submitter, context)
  await push.started()
  const integrated = await git(f.projectRoot, 'rev-parse', 'main')
  await commit((await f.service.get(other, context))!.path, 'later.txt')
  await git((await f.service.get(other, context))!.path, 'merge', '-q', integrated)
  const later = (await f.service.land(other, context)).landed!
  expect(later).not.toBe(integrated)
  await push.release()
  expect((await submitted(f, submitter))[0]).toContain('Pushed to origin/main.')
  expect(await git(bare, 'rev-parse', 'main')).toBe(integrated)
})
it('resumes a landing interrupted before its push: pushes and reports what it landed', async () => {
  const { paths, bare } = await withRemote()
  const f = await lander({ push: 'origin' }, paths)
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path, 'landed.txt')
  const push = await holdGit(f.directory, 'push')
  const { id: submission } = await f.service.submit(id, context)
  await push.started()
  // Fast-forwarded, push pending: the lander task ends here, as one faulted by a reload of its code does.
  const index = () => f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
  const landed = await git(f.projectRoot, 'rev-parse', 'main')
  expect((await index())!.queue[0].landed).toMatchObject({
    sha: landed,
    commits: [expect.stringContaining('landed.txt')],
  })
  const first = Object.values((await index())!.landers)[0] as TaskId
  await f.opened.harness.abortTask(first, context)
  await until(
    async () =>
      (await f.opened.harness.commit((tx) => tx.task(first), context))!.state.status === 'terminal',
  )
  await push.release()
  expect(await git(bare, 'rev-parse', 'main')).not.toBe(landed)
  expect((await index())!.queue).toMatchObject([{ id: submission, state: 'queued' }])
  // Opening starts a lander for the queue left behind, without a new submit.
  await f.reopen()
  const [report] = await submitted(f, id)
  expect(report).toContain(`landed as ${landed.slice(0, 7)} on main.`)
  expect(report).toContain('landed.txt')
  expect(report).toContain('Pushed to origin/main.')
  expect(report).not.toContain('nothing new')
  expect(await git(bare, 'rev-parse', 'main')).toBe(landed)
  const result = (await index())!.results[submission]
  expect(result).toMatchObject({ outcome: 'landed', sha: landed, pushed: 'origin/main' })
  // The resumed task merged and checked nothing again: it pushed what had landed.
  const steps = result.steps.map((row) => row.step)
  expect(steps.slice(steps.lastIndexOf('started'))).toEqual(['started', 'pushing to origin'])
})
it('starts a lander for queued submissions left by a lander task that ended', async () => {
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path, 'left.txt')
  // A held check keeps the first task landing; then it ends without draining its queue.
  const gate = join(f.directory, 'gate')
  f.host.projectSettings = async () => ({
    lander: { checks: [`while [ ! -f '${gate}' ]; do sleep 0.05; done`] },
  })
  await f.service.submit(id, context)
  const index = () => f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
  await until(async () => (await index())!.queue[0]?.state === 'landing')
  const first = Object.values((await index())!.landers)[0] as TaskId
  await f.opened.harness.abortTask(first, context)
  await until(
    async () =>
      (await f.opened.harness.commit((tx) => tx.task(first), context))!.state.status === 'terminal',
  )
  expect((await index())!.queue).toMatchObject([{ state: 'queued' }])
  await writeFile(gate, '')
  await f.reopen()
  const second = Object.values((await index())!.landers)[0]
  expect(second).not.toBe(first)
  expect((await submitted(f, id))[0]).toContain('landed as')
  expect(await readFile(join(f.projectRoot, 'left.txt'), 'utf8')).toBe('left.txt')
  // Opening again with nothing queued starts nothing.
  await f.reopen()
  expect((await index())!.landers).toEqual({})
})
it('reports a local landing whose push retry conflicts as landed locally', async () => {
  const { paths, bare } = await withRemote()
  const f = await lander({ push: 'origin' }, paths)
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'base.txt'), 'workspace')
  const tip = await commit(workspace.path)
  const push = await holdGit(f.directory, 'push')
  await f.service.submit(id, context)
  await push.started()
  // The remote moves with a conflicting change while the lander pushes; real git avoids the hold.
  const other = join(f.directory, 'other')
  realGit(f.directory, 'clone', '-q', bare, other)
  await writeFile(join(other, 'base.txt'), 'remote')
  realGit(other, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qam', 'remote')
  realGit(other, 'push', '-q', 'origin', 'main')
  await push.release()
  const [report] = await submitted(f, id)
  const landed = await git(f.projectRoot, 'rev-parse', 'main')
  expect(report).toContain(`landed locally as ${landed.slice(0, 7)} on main.`)
  expect(report).toContain('Push failed: origin/main conflicts with local main in:')
  expect(report).not.toContain('was not landed')
  expect(
    await git(f.projectRoot, 'merge-base', '--is-ancestor', tip, landed).then(() => true),
  ).toBe(true)
  expect((await f.service.get(id, context))!.landed).toBe(landed)
})
it('resumes checks after a restart without rerunning passed ones and keeps flaky notes', async () => {
  const f = await fixture()
  const log = join(f.directory, 'runs')
  const marker = join(f.directory, 'failed-once')
  const gate = join(f.directory, 'rerun-gate')
  f.host.projectSettings = async () => ({
    lander: {
      checks: [
        `echo first >> '${log}'`,
        `echo second >> '${log}'; if [ ! -f '${marker}' ]; then touch '${marker}'; exit 1; fi; while [ ! -f '${gate}' ]; do sleep 0.05; done`,
      ],
    },
  })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, context)
  const runs = () => readFile(log, 'utf8').catch(() => '')
  await until(async () => (await runs()) === 'first\nsecond\nsecond\n')
  const merged = await git(
    join(f.home, 'lander', (await readdir(join(f.home, 'lander')))[0]),
    'rev-parse',
    'HEAD',
  )
  await f.reopen()
  await writeFile(gate, '')
  const [report] = await submitted(f, id)
  expect(await runs()).toBe('first\nsecond\nsecond\nsecond\n')
  expect(report).toContain('landed as')
  expect(report).toContain(`Flaky: echo second`)
  expect(await git(f.projectRoot, 'rev-parse', 'main')).toBe(merged)
})
