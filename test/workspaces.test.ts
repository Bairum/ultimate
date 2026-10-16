import {
  cp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  access,
  symlink,
  realpath,
} from 'node:fs/promises'
import { join } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import type { ConversationId, JsonObject, TaskId } from '@earendil-works/pi-durable'
import { afterAll, expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import workspaceExtension, {
  actions,
  order as workspacesOrder,
} from '../extensions/workspaces/server.ts'
import { Workspaces, workspaces } from '../extensions/workspaces/workspaces.ts'
import { git, setup } from '../extensions/workspaces/git.ts'
import type { LanderEntry, WorkspaceIndex } from '../extensions/workspaces/types.ts'
import { createLander } from '../extensions/workspaces/lander.ts'
import lineage, { leaveNote, rootOf, Roots, startRoot } from '../extensions/lineage/server.ts'
import { subject } from '../extensions/conversations/server.ts'
import type { ConversationsService } from '../extensions/conversations/server.ts'
import { Summaries } from '../extensions/conversations/summary.ts'
import self from '../extensions/self/server.ts'
import promptExtension, { order as promptOrder } from '../extensions/prompt/server.ts'
import subagents, { Subagents } from '../extensions/subagents/server.ts'
import { temp, until } from './helpers.ts'

// Every test has its own repository and harness, so they all run concurrently; fixtures close when the file ends.
vi.setConfig({ maxConcurrency: 16 })
const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
})
/** A repository with base.txt and a worktree `worker` definition, made once and copied for each test. */
let template: Promise<string> | undefined
async function repository() {
  template ??= (async () => {
    const path = join(await temp('ultimate-workspaces-template-'), 'project')
    await mkdir(join(path, 'agents'), { recursive: true })
    await git(path, 'init', '-b', 'main')
    await git(path, 'config', 'user.email', 'test@example.com')
    await git(path, 'config', 'user.name', 'Test')
    await writeFile(join(path, 'base.txt'), 'base')
    await writeFile(
      join(path, 'agents/worker.md'),
      '---\nname: worker\ndescription: Writes\nisolate: worktree\n---\nCommit the assigned change.\n',
    )
    await git(path, 'add', '.')
    await git(path, 'commit', '-m', 'base')
    return path
  })()
  const directory = await temp('ultimate-workspaces-')
  const projectRoot = join(directory, 'project')
  await cp(await template, projectRoot, { recursive: true })
  return { directory, projectRoot, home: join(directory, 'state') }
}
type Answer = (text: string) => ReturnType<typeof fauxAssistantMessage>
const noIdea: Answer = () => fauxAssistantMessage('no idea')
async function fixture(commands: string[] = [], existing?: Awaited<ReturnType<typeof repository>>) {
  const paths = existing ?? (await repository())
  const prepared = await prepareHarness({
    ...paths,
    userHome: paths.directory,
    ultimateRoot: paths.projectRoot,
    faux: true,
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const resources = new Map<string, unknown>()
  const services = new Map<string, unknown>()
  const restart = vi.fn<ExtensionHost['restart']>(async () => 'RESTART_CALLED')
  // As the server: openers run each time the harness opens, cleanups each time it closes.
  const openers: (() => Promise<void>)[] = []
  const closers: (() => Promise<void>)[] = []
  const host = {
    ...prepared,
    harness: () => opened.harness,
    metadata: Metadata,
    provide: (name: string, value: unknown) => {
      services.set(name, value)
    },
    use: (name: string) =>
      services.get(name) ??
      (name === 'lineage' && host.extensions().some((e) => e.name === 'lineage' && e.enabled)
        ? {
            rootOf: (id: number, ctx: typeof context) => rootOf(host, id, ctx),
            leaveNote: (
              to: number | 'root',
              text: string,
              source: Parameters<typeof leaveNote>[3],
            ) => leaveNote(host, to, text, source),
          }
        : undefined),
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
  prepared.registry.install(CodingTools)
  /** How the faux model answers the lander's failure prompt; the default says it found nothing. */
  let landerAnswer: Answer = noIdea
  /** How the faux model continues the lander's failure run after a tool result; by default it echoes the result. */
  let landerAfterTool: Answer | undefined
  let writes = 0
  /** Requests a user's `ASK …` question started. */
  const asked: Parameters<FauxResponseFactory>[0][] = []
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
    // The lander task's question to its model; the submitter's report starts alike but names no mode.
    if (last.role === 'user' && text.startsWith('[lander] Submission') && text.includes('\nMode: '))
      return landerAnswer(text)
    if (last.role === 'user' && text.startsWith('ASK ')) {
      asked.push(transcript)
      return fauxAssistantMessage('Nothing landed yet.')
    }
    if (last.role === 'user' && text.startsWith('CALL ')) {
      const { tool, args } = JSON.parse(text.slice(5))
      return fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: 'toolUse' })
    }
    if (last.role === 'toolResult') {
      const prompt = transcript.messages.findLast((message) => message.role === 'user')
      if (landerAfterTool && JSON.stringify(prompt?.content).includes('\\nMode: '))
        return landerAfterTool(text)
      return fauxAssistantMessage(text)
    }
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
    asked,
    answerLander(answer: Answer, afterTool?: Answer) {
      landerAnswer = answer
      landerAfterTool = afterTool
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
/**
 * Hold the first `git <command>` in the repository at `path` (and its worktrees) at its first ref update, with a
 * reference-transaction hook, until `release`; with `fail`, that update then fails, after the command changed the files.
 */
async function holdGit(path: string, command: string, fail = false) {
  const started = join(path, `.git/${command}-started`)
  const gate = join(path, `.git/${command}-gate`)
  await writeFile(
    join(path, '.git/hooks/reference-transaction'),
    `#!/bin/sh
cat >/dev/null
[ "$1" = prepared ] && [ ! -f '${started}' ] || exit 0
case "$(tr '\\0' ' ' < /proc/$PPID/cmdline)" in "git ${command} "*) ;; *) exit 0 ;; esac
touch '${started}'
while [ ! -f '${gate}' ]; do sleep 0.02; done
${fail ? 'exit 1' : ''}
`,
    { mode: 0o755 },
  )
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
it.concurrent('creates through the action; setup receives ULTIMATE_SOURCE and the first model request waits for ready', async () => {
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
it.concurrent('renders workspace preparation before project context in the first composed provider request', async () => {
  const paths = await repository()
  const marker = 'CHECKOUT_RULE_ULT_123: preserve the release manifest.'
  await writeFile(join(paths.projectRoot, 'AGENTS.md'), marker)
  await git(paths.projectRoot, 'add', 'AGENTS.md')
  await git(paths.projectRoot, 'commit', '-m', 'checkout instructions')
  const f = await fixture([], paths)
  f.host.build = () =>
    ({ id: 'test-build', generation: 1, core: 'core', extensions: {}, changed: [] }) as never
  // As the server orders them: the workspace section waits for preparation before project context renders.
  f.prepared.extensionOrders.set('workspaces', workspacesOrder)
  f.prepared.extensionOrders.set('prompt', promptOrder)
  f.prepared.registry.install(promptExtension(f.host))
  const requests: string[] = []
  f.prepared.faux!.setResponses([
    (transcript) => {
      requests.push(
        JSON.stringify(transcript.messages.filter((message) => message.role === 'system')),
      )
      return fauxAssistantMessage('instructions read')
    },
  ])
  const worktree = await holdGit(f.projectRoot, 'worktree')
  const id = await f.create()
  const workspace = (await f.service.get(id, context))!
  await worktree.started()
  await expect(access(join(workspace.path, 'AGENTS.md'))).rejects.toThrow('ENOENT')
  const conversation = (await f.opened.harness.conversation(id, context))!
  const submission = await conversation.submit(
    { type: 'input', content: 'Read the checkout rules.' },
    context,
  )
  expect((await f.service.get(id, context))!.state).toBe('preparing')
  await worktree.release()
  await submission.wait(context)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toContain(marker)
  expect(await readFile(join(workspace.path, 'AGENTS.md'), 'utf8')).toBe(marker)
})
it.concurrent('setup closes stdin so commands waiting for EOF finish', async () => {
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
it.concurrent('failed setup keeps its output tail, removes its empty branch, and blocks tools rather than writing in the source', async () => {
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
it.concurrent('runs shared-only until a fresh repository has its first commit, then stands its lander without a reopen', async () => {
  const directory = await temp('ultimate-workspaces-fresh-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  const f = await fixture([], { directory, projectRoot, home: join(directory, 'state') })
  const isolation = () => actions.isolation({}, { host: f.host } as ActionContext)
  const landers = async () =>
    Object.keys(
      (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        .landerConversations,
    )
  expect(await isolation()).toEqual({ reason: 'Isolation needs a Git repository', empty: true })
  await git(projectRoot, 'init', '-b', 'main')
  await f.reopen()
  expect(await isolation()).toEqual({ reason: 'Isolation needs a first commit', empty: true })
  await writeFile(join(projectRoot, 'README.md'), 'app\n')
  expect(await isolation()).toEqual({ reason: 'Isolation needs a first commit', empty: false })
  await expect(actions.setupGit({}, { host: f.host } as ActionContext)).rejects.toThrow(
    'This folder has files',
  )
  await expect(f.create()).rejects.toThrow('Isolation needs a first commit')
  expect(await landers()).toEqual([])
  await git(projectRoot, 'config', 'user.email', 'test@example.com')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await commit(projectRoot)
  expect(await isolation()).toEqual({})
  expect(await landers()).toEqual([await realpath(projectRoot)])
  await f.service.ready(await f.create(), context)
})
it.concurrent('sets up Git in an empty folder with a first commit and its lander', async () => {
  const directory = await temp('ultimate-workspaces-empty-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  const f = await fixture([], { directory, projectRoot, home: join(directory, 'state') })
  await actions.setupGit({}, { host: f.host } as ActionContext)
  expect(await git(projectRoot, 'log', '--format=%s')).toBe('Initial commit')
  expect(await actions.isolation({}, { host: f.host } as ActionContext)).toEqual({})
  expect(
    Object.keys(
      (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        .landerConversations,
    ),
  ).toEqual([await realpath(projectRoot)])
  await f.service.ready(await f.create(), context)
})
it.concurrent('rejects a detached source and preserves existing paths and branches instead of adopting them', async () => {
  const f = await fixture()
  await git(f.projectRoot, 'switch', '--detach')
  await expect(f.create()).rejects.toThrow('Isolation needs a checked-out branch')
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
it.concurrent('lands fast-forward, lists commits and paths, and is idempotent', async () => {
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
it.concurrent('queued landing reads the current record after another workspace lands', async () => {
  const f = await fixture()
  const first = await f.create()
  const second = await f.create()
  await f.service.ready(first, context)
  await f.service.ready(second, context)
  await commit((await f.service.get(first, context))!.path)
  const merge = await holdGit(f.projectRoot, 'merge')
  const landing = f.service.land(first, context)
  await merge.started()
  const queued = f.service.land(second, context).catch((error: Error) => error)
  try {
    await actions.discard({ id: second }, { host: f.host } as ActionContext)
  } finally {
    await merge.release()
  }
  await landing
  expect(await queued).toMatchObject({ message: 'Workspace is removed' })
})
it.concurrent('refuses dirty workspaces, overlapping dirty targets, changed branches and diverged targets', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'change.txt'), 'dirty')
  await expect(f.service.land(id, context)).rejects.toThrow('Worktree is dirty')
  await git(workspace.path, 'add', '.')
  await git(workspace.path, 'commit', '-m', 'change')
  await writeFile(join(f.projectRoot, 'change.txt'), 'dirty')
  await expect(f.service.land(id, context)).rejects.toThrow('change.txt')
  await writeFile(join(f.projectRoot, 'source.txt'), 'dirty')
  await git(f.projectRoot, 'add', '.')
  await git(f.projectRoot, 'commit', '-m', 'source')
  await expect(f.service.land(id, context)).rejects.toThrow(
    'update the workspace onto main and verify again',
  )
  await git(f.projectRoot, 'switch', '-c', 'changed')
  await expect(f.service.land(id, context)).rejects.toThrow('Target branch changed')
})
it.concurrent('refuses another running conversation and queued input; own tool landing skips its own run and inbox', async () => {
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
it.concurrent('discard refuses dirty, keeps the branch, and blocks removed-workspace tools', async () => {
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
it.concurrent('isolated restart refuses before landing and accepts a clean running clone at the landed tip', async () => {
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
it.concurrent('starts a worker isolate, commits in the child and lands it through the parent tool', async () => {
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
    const reports = view.value.entries.filter((entry) => entry.kind === 'workspaces.lander-report')
    for (const report of reports) {
      const { id: submission, outcome } = report.data as {
        id: string
        outcome: WorkspaceIndex['results'][string]
      }
      const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
      expect(outcome).toEqual(index.results[submission])
      expect(outcome.lander).toBeGreaterThan(0)
      expect(outcome.steps.length).toBeGreaterThan(0)
    }
    return reports.map((entry) => JSON.stringify(entry.model))
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
async function rootNotes(f: Awaited<ReturnType<typeof fixture>>) {
  const root = (await f.opened.harness.conversation(ROOT_CONVERSATION_ID, context))!
  const view = await root.viewState(context)
  try {
    return view.value.entries.filter((entry) => entry.kind === 'lineage.note')
  } finally {
    view.dispose()
  }
}

it.concurrent('notes the root once for a landing even when its report phase is replayed', async () => {
  const f = await lander({})
  f.host.extensions = () =>
    [
      { name: 'workspaces', enabled: true },
      { name: 'lineage', enabled: true },
    ] as ReturnType<ExtensionHost['extensions']>
  const task = createLander(f.host, Workspaces, (_source, operation) => operation())
  const report = task.definition.phases.report
  let replays = 0
  f.prepared.registry.install(
    defineExtension({
      ...workspaceExtension(f.host),
      tasks: [
        ...(workspaceExtension(f.host).tasks ?? []).filter(
          (item) => item.definition.name !== task.definition.name,
        ),
        {
          definition: {
            ...task.definition,
            phases: {
              ...task.definition.phases,
              report: async (...args: Parameters<typeof report>) => {
                const [current, runtime, ctx] = args
                // Simulate resuming the persisted report checkpoint after its deliveries, before advancing.
                await report(current, { ...runtime, commit: async () => undefined }, ctx)
                replays++
                await report(current, runtime, ctx)
              },
            },
          },
        },
      ],
    }),
  )
  // The submitter is a branch of the root, so its landing is the root's tally.
  const at = await f.opened.harness.commit(
    async (tx) =>
      (await tx.appendEntry(f.opened.root.id, { kind: 'test.branch-point', data: {} })).id,
    context,
  )
  const { id } = await f.opened.root.fork(at, { ownership: { kind: 'ownerless' } }, context)
  await f.opened.harness.commit((tx) => f.service.create(tx, id, f.projectRoot), context)
  await f.service.ready(id, context)
  const sha = await commit((await f.service.get(id, context))!.path, 'landed.txt')
  f.host.provide('conversations', {
    subject: (conversation, ctx) => subject(f.host, conversation, ctx),
  } satisfies ConversationsService)
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, id)).title = 'Write the feature'
    Object.assign(await tx.doc(Summaries, id), {
      summary: 'Adds the landed file.',
      feature: 'Landing',
    })
  }, context)
  const { id: submission } = await f.service.submit(id, context)
  // A retitle after submitting does not rename what lands.
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, id)).title = 'Renamed later'
  }, context)
  expect(await submitted(f, id)).toHaveLength(1)
  const featureOf = {
    title: 'Write the feature',
    summary: 'Adds the landed file.',
    feature: 'Landing',
  }
  expect(
    (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.results[
      submission
    ],
  ).toMatchObject({ conversationId: id, subject: featureOf })
  expect(
    (await landerLog(f)).log.filter((line) => line.step === 'started' || line.outcome),
  ).toEqual([
    expect.objectContaining({ subject: featureOf }),
    expect.objectContaining({ subject: featureOf }),
  ])
  expect(replays).toBe(1)
  // A crash after admitting the note but before memoizing it reuses the same write request.
  await leaveNote(f.host, 'root', 'duplicate delivery', {
    source: 'lander',
    from: id,
    requestId: `lander-root:${submission}`,
  })
  const notes = await rootNotes(f)
  expect(notes).toHaveLength(1)
  expect(notes[0].data).toMatchObject({
    source: 'lander',
    from: id,
    sha,
    target: 'main',
    title: 'Write the feature',
    summary: 'Adds the landed file.',
    feature: 'Landing',
    commits: [{ sha: sha.slice(0, 7), subject: 'landed.txt' }],
    paths: ['landed.txt'],
  })
  expect((notes[0].data as { text: string }).text).toContain(
    `Landed ${sha.slice(0, 7)} on main from #${id} Write the feature (Landing):\nAdds the landed file.`,
  )
  await f.reopen()
  expect(await rootNotes(f)).toHaveLength(1)
})

it.concurrent('delivers a persisted version-one report without outcome as plain input once', async () => {
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  const task = createLander(f.host, Workspaces, (_source, operation) => operation())
  const report = task.definition.phases.report
  const replayed = Promise.withResolvers<void>()
  const seeded = {
    definition: {
      ...task.definition,
      initial: () => ({
        phase: 'report' as const,
        id: 'old-report',
        conversationId: id,
        text: 'Old landing report',
      }),
      phases: {
        ...task.definition.phases,
        report: async (...args: Parameters<typeof report>) => {
          const [current, runtime, ctx] = args
          await report(current, { ...runtime, commit: async () => undefined }, ctx)
          await report(current, runtime, ctx)
          replayed.resolve()
        },
      },
    },
  }
  f.prepared.registry.install(
    defineExtension({
      ...workspaceExtension(f.host),
      tasks: [
        ...(workspaceExtension(f.host).tasks ?? []).filter(
          (item) => item.definition.name !== task.definition.name,
        ),
        seeded,
      ],
    }),
  )
  await f.opened.harness.commit(
    (tx) =>
      tx.createTask(
        seeded,
        { source: f.projectRoot },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      ),
    context,
  )
  await replayed.promise
  const conversation = (await f.opened.harness.conversation(id, context))!
  await until(async () =>
    (await conversation.context(context)).entries.some((entry) =>
      JSON.stringify(entry.model).includes('Old landing report'),
    ),
  )
  await conversation.waitForIdle(context)
  const entries = (await conversation.context(context)).entries
  const reports = entries.filter((entry) =>
    entry.model?.some(
      (message) => message.role === 'user' && message.content === 'Old landing report',
    ),
  )
  expect(reports).toHaveLength(1)
  expect(reports[0].kind).not.toBe('workspaces.lander-report')
})

it.concurrent('does not note the root about its own submission', async () => {
  const f = await lander({})
  f.host.extensions = () =>
    [
      { name: 'lineage', enabled: true },
      { name: 'workspaces', enabled: true },
    ] as ReturnType<ExtensionHost['extensions']>
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(id)
  }, context)
  await f.service.submit(id, context)
  expect((await submitted(f, id))[0]).toContain('landed as')
  const view = await (await f.opened.harness.conversation(id, context))!.viewState(context)
  expect(view.value.entries.filter((entry) => entry.kind === 'lineage.note')).toHaveLength(0)
  view.dispose()
  expect(await rootNotes(f)).toHaveLength(0)
})

it.concurrent('notes the root of the submitter’s tree and skips a conversation outside any tree', async () => {
  const f = await lander({})
  f.host.extensions = () =>
    [
      { name: 'lineage', enabled: true },
      { name: 'workspaces', enabled: true },
    ] as ReturnType<ExtensionHost['extensions']>
  // A second root, and a branch of it that lands; an unrooted conversation lands too.
  const other = await f.opened.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const at = await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(other.id)
    return (await tx.appendEntry(other.id, { kind: 'test.branch-point', data: {} })).id
  }, context)
  const branch = await other.fork(at, { ownership: { kind: 'ownerless' } }, context)
  await f.opened.harness.commit((tx) => f.service.create(tx, branch.id, f.projectRoot), context)
  await f.service.ready(branch.id, context)
  await commit((await f.service.get(branch.id, context))!.path, 'branch.txt')
  await f.service.submit(branch.id, context)
  expect((await submitted(f, branch.id))[0]).toContain('landed as')
  const unrooted = await f.create()
  await f.service.ready(unrooted, context)
  await commit((await f.service.get(unrooted, context))!.path, 'unrooted.txt')
  await f.service.submit(unrooted, context)
  expect((await submitted(f, unrooted))[0]).toContain('landed as')
  const notes = async (id: ConversationId) => {
    const view = await (await f.opened.harness.conversation(id, context))!.viewState(context)
    try {
      return view.value.entries.filter((entry) => entry.kind === 'lineage.note')
    } finally {
      view.dispose()
    }
  }
  expect((await notes(other.id)).map((note) => (note.data as { from: number }).from)).toEqual([
    branch.id,
  ])
  expect(await rootNotes(f)).toHaveLength(0)
})

async function lander(settings: JsonObject, existing?: Awaited<ReturnType<typeof repository>>) {
  const f = await fixture([], existing)
  f.host.projectSettings = async () => ({ lander: settings })
  return f
}
it.concurrent('lets an ownerless history fork submit its own workspace', async () => {
  const f = await lander({ checks: ['test -f base.txt'] })
  const entry = await f.opened.harness.commit(
    (tx) => tx.appendEntry(f.opened.root.id, { kind: 'test.branch-point', data: {} }),
    context,
  )
  const fork = await f.opened.root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
  await f.opened.harness.commit((tx) => f.service.create(tx, fork.id, f.projectRoot), context)
  await f.service.ready(fork.id, context)
  await commit((await f.service.get(fork.id, context))!.path, 'branch.txt')
  const result = await f.call(fork.id, 'workspace', { action: 'submit' })
  expect(JSON.stringify(result)).toContain('position')
  const [report] = await submitted(f, fork.id)
  expect(report).toContain('landed as')
  expect(await readFile(join(f.projectRoot, 'branch.txt'), 'utf8')).toBe('branch.txt')
})
it.concurrent('lands and reports a submission without a lineage provider', async () => {
  const f = await lander({ checks: ['test -f base.txt'] })
  expect(f.host.use('lineage')).toBeUndefined()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await commit(workspace.path, 'no-lineage.txt')
  await f.service.submit(id, context)
  const [report] = await submitted(f, id)
  expect(report).toContain('landed as')
  expect(await readFile(join(f.projectRoot, 'no-lineage.txt'), 'utf8')).toBe('no-lineage.txt')
  expect(await rootNotes(f)).toHaveLength(0)
})
it.concurrent('lands two submissions in order onto a moved target and reports both', async () => {
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
      `^Merge .* from #${second} into main\nMerge .* from #${first} into main\nmoved.txt$`,
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
  expect(reportOne).toContain(`Submission ${submissionOne} (#${first}, `)
  expect(reportTwo).toContain(`Submission ${submissionTwo} (#${second}, `)
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
    expect.stringContaining(`from #${first} into main`),
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
  // Lineage is disabled in this fixture: landings leave no root note.
  expect(await rootNotes(f)).toHaveLength(0)
  // The lander conversation has no workspace and is no main: it can neither submit nor land.
  for (const action of ['submit', 'land'])
    expect(JSON.stringify(await f.call(id, 'workspace', { action }))).toContain(
      'Only a top-level main conversation',
    )
})
it.concurrent('runs a check group concurrently and records each summary', async () => {
  const f = await fixture()
  /** Marks itself, then waits for the other: run one after the other, both would fail. */
  const meet = (name: string, other: string) =>
    `touch '${join(f.directory, name)}'; for i in $(seq 100); do [ -f '${join(f.directory, other)}' ] && break; sleep 0.01; done; test -f '${join(f.directory, other)}' && printf 'log\\n\\033[32m${name} met\\033[0m\\n\\n'`
  const group = [meet('one', 'two'), meet('two', 'one')]
  f.host.projectSettings = async () => ({ lander: { checks: ['true', group] } })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, context)
  const [report] = await submitted(f, id)
  expect(report).toContain('landed as')
  expect(report).not.toContain('Flaky')
  const checks = (await landerLog(f)).log.flatMap((line) => (line.check ? [line.check] : []))
  expect(checks[0]).toEqual({ command: 'true', result: 'passed' })
  // ANSI stripped, trailing blank lines skipped.
  expect(checks.slice(1)).toEqual(
    expect.arrayContaining(
      ['one met', 'two met'].map((summary) =>
        expect.objectContaining({ result: 'passed', summary }),
      ),
    ),
  )
  expect(checks).toHaveLength(3)
})
it.concurrent('reruns only the failing command of a group, reports its output twice failed, and lands a flaky one', async () => {
  const f = await lander({
    checks: [['echo PASSING_SUMMARY', 'echo CHECK_OUTPUT_TAIL; test ! -f fail.txt']],
  })
  f.host.extensions = () =>
    [
      { name: 'lineage', enabled: true },
      { name: 'workspaces', enabled: true },
    ] as ReturnType<ExtensionHost['extensions']>
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
  expect(
    failed.filter((line) => line.step?.startsWith('rerunning:')).map((line) => line.step),
  ).toEqual(['rerunning: echo CHECK_OUTPUT_TAIL; test ! -f fail.txt'])
  expect(failed.filter((line) => line.check).map((line) => line.check)).toEqual(
    expect.arrayContaining([
      { command: 'echo PASSING_SUMMARY', result: 'passed', summary: 'PASSING_SUMMARY' },
      { command: 'echo CHECK_OUTPUT_TAIL; test ! -f fail.txt', result: 'failed' },
    ]),
  )
  expect(failed.at(-1)).toMatchObject({
    outcome: 'failed',
    reason: 'check failed twice: echo CHECK_OUTPUT_TAIL; test ! -f fail.txt',
    output: expect.stringContaining('CHECK_OUTPUT_TAIL'),
  })
  expect(failed.at(-1)!.sha).toBeUndefined()
  // A failed landing leaves no note in the root.
  expect(await rootNotes(f)).toHaveLength(0)
  const marker = join(f.directory, 'flaky')
  f.host.projectSettings = async () => ({
    lander: {
      checks: [
        ['true', `if [ -f '${marker}' ]; then echo ok; exit 0; fi; touch '${marker}'; exit 1`],
      ],
    },
  })
  await git(workspace.path, 'rm', '-q', 'fail.txt')
  await git(workspace.path, 'commit', '-qm', 'fix')
  await f.service.submit(id, context)
  const reports = await submitted(f, id)
  expect(reports.at(-1)).toContain('landed as')
  expect(reports.at(-1)).toContain('Flaky: if [')
  const flaky = (await landerLog(f)).log
  expect(flaky.findLast((line) => line.check)!.check).toMatchObject({
    result: 'flaky',
    summary: 'ok',
  })
  expect(flaky.at(-1)).toMatchObject({
    outcome: 'landed',
    flaky: [expect.stringContaining('if [')],
  })
})
it.concurrent('fast-forwards the worktree that has the target checked out, past unrelated dirty files but not over overlapping ones', async () => {
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  // The target lives in another worktree than the project checkout.
  await git(f.projectRoot, 'switch', '-q', '-c', 'other')
  const elsewhere = join(f.directory, 'elsewhere')
  await git(f.projectRoot, 'worktree', 'add', '-q', elsewhere, 'main')
  await writeFile(join(elsewhere, 'unrelated.txt'), 'dirty')
  const tip = await commit(workspace.path)
  await f.service.submit(id, context)
  expect((await submitted(f, id))[0]).toContain('landed as')
  expect(await git(elsewhere, 'rev-parse', 'HEAD')).toBe(tip)
  expect(await readFile(join(elsewhere, 'change.txt'), 'utf8')).toBe('change.txt')
  expect(await readFile(join(elsewhere, 'unrelated.txt'), 'utf8')).toBe('dirty')
  expect(await git(f.projectRoot, 'status', '--porcelain')).toBe('')
  await writeFile(join(elsewhere, 'overlap.txt'), 'dirty')
  await commit(workspace.path, 'overlap.txt')
  await f.service.submit(id, context)
  const reports = await submitted(f, id)
  expect(reports.at(-1)).toContain('refused the fast-forward')
  expect(reports.at(-1)).toContain('overlap.txt')
  expect(await git(elsewhere, 'rev-parse', 'HEAD')).toBe(tip)
})
it.concurrent('counts checkouts by state, commits and uncommitted changes, and measures their disk once a minute', async () => {
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
  expect(stats).toEqual({
    total: 4,
    ready: 3,
    preparing: 0,
    failed: 0,
    removed: 1,
    landed: 1,
    ahead: 1,
    fresh: 1,
    dirty: 1,
  })
  const disk = await actions.disk({}, { host: f.host } as ActionContext)
  expect(disk.bytes).toBeGreaterThan(0)
  expect(await actions.disk({}, { host: f.host } as ActionContext)).toBe(disk)
  // Counting never removes anything.
  expect((await f.service.get(landed, context))!.state).toBe('ready')
})
it.concurrent('kills the whole process group of a running check when the lander is aborted', async () => {
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
})
it.concurrent('runs worktree setup on the merged revision before the checks', async () => {
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
  // The check passes only when setup copies the merged want.txt, not the target's.
  await writeFile(join(workspace.path, 'want.txt'), 'two')
  await git(workspace.path, 'commit', '-qam', 'needs setup')
  await f.service.submit(id, context)
  const [report] = await submitted(f, id)
  expect(report).toContain('landed as')
  expect(report).not.toContain('Flaky')
})
async function withRemote() {
  const paths = await repository()
  const bare = join(paths.directory, 'remote.git')
  await git(paths.directory, 'init', '-q', '--bare', '-b', 'main', bare)
  await git(paths.projectRoot, 'remote', 'add', 'origin', bare)
  await git(paths.projectRoot, 'push', '-q', 'origin', 'main')
  return { paths, bare }
}
/** Hold the lander's pushes from the project checkout with a pre-push hook until `release`. */
async function holdPush(f: Awaited<ReturnType<typeof fixture>>) {
  const started = join(f.directory, 'push-started')
  const gate = join(f.directory, 'push-gate')
  await writeFile(
    join(f.projectRoot, '.git/hooks/pre-push'),
    `#!/bin/sh\ncat >/dev/null\ntouch '${started}'\nwhile [ ! -f '${gate}' ]; do sleep 0.02; done\n`,
    { mode: 0o755 },
  )
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
it.concurrent('resumes a landing interrupted before its push: pushes and reports what it landed, not the moved target', async () => {
  const { paths, bare } = await withRemote()
  const f = await lander({ push: 'origin' }, paths)
  const id = await f.create()
  const other = await f.create()
  await f.service.ready(id, context)
  await f.service.ready(other, context)
  await commit((await f.service.get(id, context))!.path, 'landed.txt')
  const push = await holdPush(f)
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
  // The target advances past the landing before its push.
  const later = (await f.service.get(other, context))!.path
  await git(later, 'merge', '-q', landed)
  await commit(later, 'later.txt')
  expect((await f.service.land(other, context)).landed).not.toBe(landed)
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
it.concurrent('reports a local landing whose push retry conflicts as landed locally', async () => {
  const { paths, bare } = await withRemote()
  const f = await lander({ push: 'origin' }, paths)
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'base.txt'), 'workspace')
  const tip = await commit(workspace.path)
  const push = await holdPush(f)
  await f.service.submit(id, context)
  await push.started()
  // The remote moves with a conflicting change while the lander pushes.
  const other = join(f.directory, 'other')
  await git(f.directory, 'clone', '-q', bare, other)
  await writeFile(join(other, 'base.txt'), 'remote')
  await git(other, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qam', 'remote')
  await git(other, 'push', '-q', 'origin', 'main')
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
it.concurrent('resumes checks after a restart without rerunning passed ones and keeps flaky notes', async () => {
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
it.concurrent('starts a lander for queued submissions left by a lander task that ended', async () => {
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
/** A `lander` definition in the user's agents, as an override of a project would be. */
async function landerDefinition(
  f: Awaited<ReturnType<typeof fixture>>,
  onFailure: 'fix' | 'diagnose',
) {
  await mkdir(join(f.directory, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(f.directory, '.ultimate/agents/lander.md'),
    `---\nname: lander\ndescription: Lands\ntools: [read, bash]\nonFailure: ${onFailure}\n---\nLand it.\n`,
  )
  await f.reopen()
}
/** A workspace whose change to base.txt conflicts with the target's; returns the target's head. */
async function conflicting(f: Awaited<ReturnType<typeof fixture>>, id: ConversationId) {
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'base.txt'), 'workspace')
  await commit(workspace.path)
  await writeFile(join(f.projectRoot, 'base.txt'), 'target')
  return commit(f.projectRoot)
}
it.concurrent('diagnose: the lander model explains a conflict, which the report carries; the target stays', async () => {
  const f = await lander({})
  await landerDefinition(f, 'diagnose')
  let prompt = ''
  f.answerLander((text) => {
    prompt = text
    return fauxAssistantMessage('DIAGNOSIS: both sides rewrote base.txt; keep the workspace line.')
  })
  const id = await f.create()
  await f.service.ready(id, context)
  const head = await conflicting(f, id)
  const { id: submission, lander: landerId } = await f.service.submit(id, context)
  const [report] = await submitted(f, id)
  expect(prompt).toContain('Mode: diagnose')
  expect(prompt).toContain('base.txt')
  expect(report).toContain('conflicts with main in:')
  expect(report).toContain('Diagnosis by lander:\\nDIAGNOSIS: both sides rewrote base.txt')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
  expect((await f.service.get(id, context))!.landed).toBeUndefined()
  const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
  expect(index.results[submission]).toMatchObject({
    outcome: 'failed',
    diagnosis: expect.stringContaining('DIAGNOSIS'),
  })
  // The question and the answer sit in the lander conversation between its log lines, and the checkout is reset.
  const { kinds } = await landerLog(f)
  expect(kinds).toEqual(expect.arrayContaining(['ultimate.lander-ask', 'pi.assistant']))
  expect(kinds.indexOf('ultimate.lander-ask')).toBeLessThan(kinds.lastIndexOf('ultimate.lander'))
  const cwd = (
    await (await f.opened.harness.conversation(landerId as ConversationId, context))!.agent(context)
  ).cwd!
  expect(await git(cwd, 'status', '--porcelain')).toBe('')
})
it.concurrent('fix: a fix that still fails the check is not landed and leaves the target untouched', async () => {
  const f = await lander({ checks: ['grep -q good base.txt'] })
  await landerDefinition(f, 'fix')
  let asked = 0
  f.answerLander(() => {
    asked++
    return fauxAssistantMessage(
      fauxToolCall('bash', {
        command: 'echo bad > base.txt && git add base.txt && git commit -q --no-edit',
      }),
      { stopReason: 'toolUse' },
    )
  })
  const id = await f.create()
  await f.service.ready(id, context)
  const head = await conflicting(f, id)
  await f.service.submit(id, context)
  const [report] = await submitted(f, id)
  expect(report).toContain('was not landed: check failed twice: grep -q good base.txt')
  expect(report).toContain("The lander's fix (1 commit) did not land it either.")
  // One fix per submission: the failing check after it is reported, not handed to the model again.
  expect(asked).toBe(1)
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
  expect(await readFile(join(f.projectRoot, 'base.txt'), 'utf8')).toBe('target')
})
it.concurrent('starts an isolated root whose first request sees its ready checkout', async () => {
  const f = await fixture()
  // This fixture's host has no event bus, so no extension labels the root.
  f.host.events = { emit: () => {} } as unknown as ExtensionHost['events']
  // Its prompt task delivers the first input.
  f.prepared.registry.install(lineage(f.host))
  const { id } = await startRoot(f.host, { prompt: 'ASK where am I?', isolated: true }, context)
  const conversation = (await f.opened.harness.conversation(id, context))!
  await until(async () => f.asked.length > 0)
  await conversation.waitForIdle(context)
  const workspace = (await f.service.get(id, context))!
  expect(workspace.state).toBe('ready')
  expect((await conversation.agent(context)).cwd).toBe(workspace.path)
  const [request] = f.asked
  expect(JSON.stringify(request.messages)).toContain(`Workspace: ${workspace.path}`)
  expect((await f.opened.harness.snapshot(Roots, ROOT_CONVERSATION_ID, context))?.roots).toEqual([
    ROOT_CONVERSATION_ID,
    id,
  ])
})
it.concurrent('answers the user in the lander conversation with its definition, tools and the lander state', async () => {
  const f = await lander({})
  await landerDefinition(f, 'diagnose')
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path, 'one.txt')
  const { id: submission, lander: landerId } = await f.service.submit(id, context)
  await submitted(f, id)
  const conversation = (await f.opened.harness.conversation(landerId as ConversationId, context))!
  await (
    await conversation.submit({ type: 'input', content: 'ASK what landed?' }, context)
  ).wait(context)
  const [request] = f.asked
  const system = JSON.stringify(request.messages.filter((message) => message.role === 'system'))
  expect(system).toContain('Land it.')
  expect(system).toContain(`${submission} landed`)
  expect((await conversation.agent(context)).tools.map((tool) => tool.name).toSorted()).toEqual([
    'bash',
    'read',
  ])
  // Main conversations get no lander state.
  await f.call(id, 'workspace', { action: 'status' })
  const main = await (await f.opened.harness.conversation(id, context))!.context(context)
  expect(JSON.stringify(main.messages)).not.toContain('You are the lander of')
})
it.concurrent('gives the standing lander a checkout at the target tip before any submission', async () => {
  const f = await lander({})
  const { id, cwd } = await landerLog(f)
  expect(cwd).toMatch(/\/lander\/[0-9a-f]{12}$/)
  const result = JSON.stringify(await f.call(id, 'bash', { command: 'git log -1 --format=%H' }))
  expect(result).toContain(await git(f.projectRoot, 'rev-parse', 'HEAD'))
  // Opening again keeps the checkout as it is.
  await writeFile(join(cwd!, 'kept.txt'), 'kept')
  await f.reopen()
  expect(await readFile(join(cwd!, 'kept.txt'), 'utf8')).toBe('kept')
})
it.concurrent('fix: a model run that fails after committing lands nothing', async () => {
  const f = await lander({})
  await landerDefinition(f, 'fix')
  f.answerLander(
    () =>
      fauxAssistantMessage(
        fauxToolCall('bash', {
          command: 'echo resolved > base.txt && git add base.txt && git commit -q --no-edit',
        }),
        { stopReason: 'toolUse' },
      ),
    () => fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'provider failed' }),
  )
  const id = await f.create()
  await f.service.ready(id, context)
  const head = await conflicting(f, id)
  const { id: submission } = await f.service.submit(id, context)
  const [report] = await submitted(f, id)
  expect(report).toContain("was not landed: the lander's model did not finish (model_error)")
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
  const result = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
    .results[submission]
  expect(result).toMatchObject({ outcome: 'failed' })
  expect(result.fixed).toBeUndefined()
})
/** A check that marks `started` and waits for `gate`; both files live in the test directory. */
function heldCheck(f: Awaited<ReturnType<typeof fixture>>, then = 'true') {
  const started = join(f.directory, 'check-started')
  const gate = join(f.directory, 'check-gate')
  return {
    command: `touch '${started}'; while [ ! -f '${gate}' ]; do sleep 0.05; done; ${then}`,
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
/** Run `tool` in conversation `id` and return its tool results, without waiting for the lander task to end. */
async function ask(
  f: Awaited<ReturnType<typeof fixture>>,
  id: ConversationId,
  tool: string,
  args: object,
) {
  const conversation = (await f.opened.harness.conversation(id, context))!
  await (
    await conversation.submit(
      { type: 'input', content: `CALL ${JSON.stringify({ tool, args })}`, whenBusy: 'followUp' },
      context,
    )
  ).wait(context)
  const view = await conversation.viewState(context)
  try {
    return JSON.stringify(view.value.entries.filter((entry) => entry.kind === 'pi.tool-result'))
  } finally {
    view.dispose()
  }
}
const commitIn = (name: string) =>
  `echo ${name} > ${name} && git add ${name} && git commit -qm ${name} && echo COMMITTED`
it.concurrent('keeps user tool calls out of the lander checkout while it lands', async () => {
  const f = await fixture()
  const held = heldCheck(f)
  f.host.projectSettings = async () => ({ lander: { checks: [held.command] } })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path, 'submitted.txt')
  const { id: submission, lander: landerId } = await f.service.submit(id, context)
  await held.started()
  const section = workspaceExtension(f.host).sections!.find((item) => item.key === 'lander_state')!
  const state = await section.render(
    { conversationId: landerId } as Parameters<typeof section.render>[0],
    context,
  )
  expect(state).toContain(`- ${submission} #${id} tip `)
  expect(state).toContain(' landing · checking:')
  const result = await ask(f, landerId as ConversationId, 'bash', { command: commitIn('user.txt') })
  expect(result).toContain(`The lander is landing #${id}; ask again when it is idle`)
  expect(result).not.toContain('COMMITTED')
  await held.release()
  expect((await submitted(f, id))[0]).toContain('landed as')
  await access(join(f.projectRoot, 'submitted.txt'))
  await expect(access(join(f.projectRoot, 'user.txt'))).rejects.toThrow('ENOENT')
  // Idle again, the lander conversation works in its checkout.
  expect(
    JSON.stringify(await f.call(landerId as ConversationId, 'bash', { command: 'git log -1' })),
  ).not.toContain('The lander is landing')
})
it.concurrent('lands only the commit every check ran on, never one added to its checkout meanwhile', async () => {
  const f = await fixture()
  const held = heldCheck(f)
  f.host.projectSettings = async () => ({ lander: { checks: [held.command] } })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path, 'submitted.txt')
  const head = await git(f.projectRoot, 'rev-parse', 'HEAD')
  await f.service.submit(id, context)
  await held.started()
  // As a tool call started before the landing would: no hook stops it.
  await commit(join(f.home, 'lander', (await readdir(join(f.home, 'lander')))[0]), 'sneaked.txt')
  await held.release()
  const [report] = await submitted(f, id)
  expect(report).toContain('was not landed: the integration checkout changed during checks')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
})
it.concurrent('fix: a follow-up queued behind the failure run gets nothing landed unchecked', async () => {
  const f = await lander({})
  await landerDefinition(f, 'fix')
  const held = heldCheck(f, 'grep -q resolved base.txt')
  f.host.projectSettings = async () => ({ lander: { checks: [held.command] } })
  const fixGate = join(f.directory, 'fix-gate')
  f.answerLander(() =>
    fauxAssistantMessage(
      fauxToolCall('bash', {
        command: `while [ ! -f '${fixGate}' ]; do sleep 0.05; done; echo resolved > base.txt && git add base.txt && git commit -q --no-edit`,
      }),
      { stopReason: 'toolUse' },
    ),
  )
  const id = await f.create()
  await f.service.ready(id, context)
  await conflicting(f, id)
  const { lander: landerId } = await f.service.submit(id, context)
  const index = () => f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
  await until(async () => (await index())!.queue[0]?.agent === 'fix')
  const conversation = (await f.opened.harness.conversation(landerId as ConversationId, context))!
  // Waits for the checks on the fixed commit, then commits into the checkout.
  const followUp = await conversation.submit(
    {
      type: 'input',
      content: `CALL ${JSON.stringify({
        tool: 'bash',
        args: {
          command: `while [ ! -f '${join(f.directory, 'check-started')}' ]; do sleep 0.05; done; ${commitIn('followup.txt')}`,
        },
      })}`,
      whenBusy: 'followUp',
    },
    context,
  )
  await writeFile(fixGate, '')
  await held.started()
  await followUp.wait(context)
  await held.release()
  const [report] = await submitted(f, id)
  expect(report).toContain('landed as')
  expect(report).toContain('Fixed by lander:')
  expect(await readFile(join(f.projectRoot, 'base.txt'), 'utf8')).toBe('resolved\n')
  await expect(access(join(f.projectRoot, 'followup.txt'))).rejects.toThrow('ENOENT')
  const view = await conversation.viewState(context)
  try {
    expect(
      JSON.stringify(view.value.entries.filter((entry) => entry.kind === 'pi.tool-result')),
    ).toContain(`The lander is landing #${id}`)
  } finally {
    view.dispose()
  }
})
it.concurrent('resumes a group after a restart without a third run of its twice-failed member', async () => {
  const f = await fixture()
  const runs = join(f.directory, 'runs')
  const held = heldCheck(f)
  const failing = `echo failing >> '${runs}'; echo FAILING_OUTPUT; exit 1`
  f.host.projectSettings = async () => ({ lander: { checks: [[failing, held.command]] } })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  const head = await git(f.projectRoot, 'rev-parse', 'HEAD')
  const { id: submission } = await f.service.submit(id, context)
  const index = () => f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
  const task = Object.values((await index())!.landers)[0] as TaskId
  // The failing member's rerun outcome is stored while its sibling still runs.
  await until(async () => {
    const record = await f.opened.harness.commit((tx) => tx.task(task), context)
    return record?.memos?.[`check:${submission}:1:0.0:rerun`] !== undefined
  })
  await held.started()
  await f.reopen()
  await held.release()
  const [report] = await submitted(f, id)
  expect(await readFile(runs, 'utf8')).toBe('failing\nfailing\n')
  expect(report).toContain(`was not landed: check failed twice: ${failing}`)
  expect(report).toContain('FAILING_OUTPUT')
  expect((await index())!.results[submission]).toMatchObject({
    outcome: 'failed',
    output: expect.stringContaining('FAILING_OUTPUT'),
  })
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
})
it.concurrent('fix: a rejected fix stays rejected when the lander crashes during its cleanup', async () => {
  const f = await lander({})
  await landerDefinition(f, 'fix')
  // Resolves and commits the conflict, then leaves base.txt modified: a dirty fix, rejected.
  f.answerLander(() =>
    fauxAssistantMessage(
      fauxToolCall('bash', {
        command:
          'echo resolved > base.txt && git add base.txt && git commit -q --no-edit && echo dirty >> base.txt',
      }),
      { stopReason: 'toolUse' },
    ),
  )
  const id = await f.create()
  await f.service.ready(id, context)
  const head = await conflicting(f, id)
  const index = () => f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
  const { id: submission } = await f.service.submit(id, context)
  await until(async () => (await index())!.queue[0]?.agent === 'fix')
  // The cleanup's reset cleans the checkout, then the process goes down before the rejection is reported.
  const reset = await holdGit(f.projectRoot, 'reset', true)
  await reset.started()
  const crashed = f.opened
  const reopening = f.reopen()
  await until(() =>
    crashed.harness.conversation(ROOT_CONVERSATION_ID, context).then(
      () => false,
      () => true,
    ),
  )
  await reset.release()
  await reopening
  const [report] = await submitted(f, id)
  expect(report).toContain("The lander's fix left uncommitted changes.")
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
  expect((await index())!.results[submission]).toMatchObject({ outcome: 'failed' })
})
it.concurrent('fix: the lander model resolves a conflict with the remote target, then the submission merges, checks and lands', async () => {
  const { paths, bare } = await withRemote()
  const f = await lander({ push: 'origin', checks: ['grep -q resolved base.txt'] }, paths)
  await landerDefinition(f, 'fix')
  let prompt = ''
  f.answerLander((text) => {
    prompt = text
    return fauxAssistantMessage(
      fauxToolCall('bash', {
        command: 'echo resolved > base.txt && git add base.txt && git commit -q --no-edit',
      }),
      { stopReason: 'toolUse' },
    )
  })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path, 'submitted.txt')
  // Local main and origin/main both rewrite base.txt.
  const other = join(f.directory, 'other')
  await git(f.directory, 'clone', '-q', bare, other)
  await writeFile(join(other, 'base.txt'), 'remote')
  await git(other, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qam', 'remote')
  await git(other, 'push', '-q', 'origin', 'main')
  const remoteTip = await git(other, 'rev-parse', 'HEAD')
  await writeFile(join(f.projectRoot, 'base.txt'), 'local')
  await git(f.projectRoot, 'commit', '-qam', 'local')
  const { id: submission } = await f.service.submit(id, context)
  const [report] = await submitted(f, id)
  expect(prompt).toContain('failed: origin/main conflicts with local main in\nbase.txt')
  expect(prompt).toContain(`Merging origin/main (${remoteTip}) into main`)
  expect(report).toContain('landed as')
  expect(report).toContain('Fixed by lander:')
  expect(report).toContain('Pushed to origin/main.')
  const landed = await git(f.projectRoot, 'rev-parse', 'HEAD')
  expect(await readFile(join(f.projectRoot, 'base.txt'), 'utf8')).toBe('resolved\n')
  expect(await readFile(join(f.projectRoot, 'submitted.txt'), 'utf8')).toBe('submitted.txt')
  expect(await git(bare, 'rev-parse', 'main')).toBe(landed)
  const steps = (await f.opened.harness.snapshot(
    Workspaces,
    ROOT_CONVERSATION_ID,
    context,
  ))!.results[submission].steps.map((row) => row.step)
  expect(steps.slice(steps.indexOf('fixing'))).toEqual(
    expect.arrayContaining(['merging', 'checking: grep -q resolved base.txt']),
  )
})
