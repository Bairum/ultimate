import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context, prepareHarness } from '../../server/harness.ts'
import { Metadata } from '../../server/metadata.ts'
import instance, { actions } from '../../extensions/instance/server.ts'
import subagents, { Subagents } from '../../extensions/subagents/server.ts'
import workspaceExtension from '../../extensions/workspaces/server.ts'
import { workspaces } from '../../extensions/workspaces/workspaces.ts'
import { git } from '../../extensions/workspaces/git.ts'
import { projectSettings } from '../../server/project-setup.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { ExtensionHost } from '../../server/extensions.ts'
import { attach, temp, removeTemp, until } from '../helpers.ts'

type Preview = { id: string; url: string; home: string; pid: number }
async function assertProject(
  preview: Preview,
  path: string,
  decision: boolean | null,
  source = path,
) {
  const client = await attach(preview)
  try {
    expect(client.system().execution.defaultCwd).toBe(path)
    expect(client.system().code.ultimateRoot).toBe(source)
    expect(client.system().project.decision).toBe(decision)
    expect(client.system().persistence.path).toBe(join(preview.home, 'state.sqlite'))
    expect(client.system().process.pid).toBe(preview.pid)
  } finally {
    await client.close()
  }
  expect((await fetch(`${preview.url}/api/models`)).status).toBe(200)
}
async function fixture({ foreign = false } = {}) {
  const root = await temp('ultimate-preview-')
  const checkout = resolve('.')
  const source = join(root, 'source')
  await git(root, 'clone', '--no-hardlinks', checkout, source)
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
  await git(source, 'commit', '-m', 'Configure preview setup')
  const project = foreign ? join(root, 'app') : source
  if (foreign) {
    await git(root, 'init', '-b', 'main', project)
    await writeFile(join(project, 'README.md'), 'An app, not Ultimate\n')
    await git(project, 'add', 'README.md')
    await git(project, 'commit', '-m', 'Start app')
  }
  new ProjectTrustStore(join(root, '.ultimate')).set(project, true)
  const prepared = await prepareHarness({
    ultimateRoot: source,
    projectRoot: project,
    home: join(root, 'home'),
    userHome: root,
    faux: true,
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const resources = new Map<string, unknown>()
  const services = new Map<string, unknown>()
  const cleanups: (() => Promise<void>)[] = []
  const host = {
    ...prepared,
    projectSettings: () => projectSettings(project, root),
    harness: () => opened.harness,
    metadata: Metadata,
    provide: (name: string, value: unknown) => {
      services.set(name, value)
    },
    use: (name: string) => services.get(name),
    extensions: () => [{ name: 'workspaces', enabled: true }],
    resource<T>(key: string, create: () => T): T {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onOpen: () => {},
    onClose: (cleanup: () => Promise<void>) => {
      cleanups.push(cleanup)
    },
  } as unknown as ExtensionHost
  const extension = instance(host)
  const service = workspaces(host)
  prepared.registry.install(workspaceExtension(host))
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
    return result.output!.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
  async function main() {
    const conversation = await opened.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
        init: (tx, id) => service.create(tx, id, project).then(() => undefined),
      },
      context,
    )
    await service.ready(conversation.id, context)
    return { id: conversation.id, workspace: (await service.get(conversation.id, context))! }
  }
  async function close() {
    const previews = JSON.parse(await run({ action: 'list' })) as Preview[]
    for (const cleanup of cleanups) await cleanup()
    await opened.close()
    for (const preview of previews) await removeTemp(preview.home)
    await removeTemp(root)
  }
  const list = async () =>
    (await actions.list(null, { host } as never)) as Omit<Preview, 'home' | 'pid'>[]
  return { root, source, prepared, opened, service, call, run, list, main, close }
}
const listed = (preview: Preview, conversationId: number) => ({
  id: preview.id,
  url: preview.url,
  conversationId,
  faux: true,
})
it('selects shared, isolated main and owned child checkouts with the main project decision', async () => {
  const f = await fixture()
  try {
    expect(await f.call('instance', { action: 'start', subagent: 999999, faux: true })).toContain(
      'Unknown subagent',
    )
    const main = await f.main()
    const own = JSON.parse(
      await f.call('instance', { action: 'start', faux: true }, main.id),
    ) as Preview
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
    const childWorkspace = (await f.service.get(child.conversationId, context))!
    expect(childWorkspace.source).toBe(main.workspace.path)
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
    await assertProject(shared, f.source, true)
    await assertProject(own, main.workspace.path, true)
    await assertProject(selected, childWorkspace.path, true)
    expect(await f.run({ action: 'start', faux: true })).toContain('At most three')
    expect(await f.list()).toEqual(
      expect.arrayContaining([
        listed(own, main.id),
        listed(shared, f.opened.root.id),
        listed(selected, child.conversationId),
      ]),
    )
    for (const preview of [selected, shared, own]) {
      expect(await f.call('instance', { action: 'logs', id: preview.id })).toContain(preview.url)
      await f.run({ action: 'stop', id: preview.id })
      expect((await f.list()).map(({ id }) => id)).not.toContain(preview.id)
      await removeTemp(preview.home)
    }
    await f.service.discard(child.conversationId, context)
    await f.service.discard(main.id, context)
    expect(await f.run({ action: 'start', faux: true }, main.id)).toContain('active, ready')
  } finally {
    await f.close()
  }
}, 120000)
it('previews a workspace of another project on the host Ultimate', async () => {
  const f = await fixture({ foreign: true })
  try {
    const main = await f.main()
    const preview = JSON.parse(
      await f.call('instance', { action: 'start', faux: true }, main.id),
    ) as Preview
    expect(await readFile(join(main.workspace.path, 'README.md'), 'utf8')).toContain('not Ultimate')
    await assertProject(preview, main.workspace.path, true, f.source)
    await f.run({ action: 'stop', id: preview.id })
  } finally {
    await f.close()
  }
}, 120000)
it('cleans up a failed or aborted preview and allows its home to be reused', async () => {
  const f = await fixture()
  try {
    const main = await f.main()
    const entry = join(main.workspace.path, 'server/main.ts')
    const original = await readFile(entry, 'utf8')
    await writeFile(entry, "throw new Error('preview startup failure')\n")
    const home = join(f.root, 'failed-home')
    expect(await f.run({ action: 'start', home, faux: true }, main.id)).toContain(
      'preview startup failure',
    )
    expect(JSON.parse(await f.run({ action: 'list' }))).toEqual([])
    await writeFile(entry, 'setInterval(() => {}, 1000)\n')
    const controller = new AbortController()
    const abort = f.run({ action: 'start', home, faux: true }, main.id, {
      ...context,
      abortSignal: controller.signal,
    })
    await until(async () => JSON.parse(await f.run({ action: 'list' })).length === 1)
    controller.abort()
    expect(await abort).toContain('AbortError')
    expect(JSON.parse(await f.run({ action: 'list' }))).toEqual([])
    await writeFile(entry, original)
    const preview = JSON.parse(
      await f.run({ action: 'start', home, faux: true }, main.id),
    ) as Preview
    process.kill(preview.pid, 'SIGTERM')
    await until(async () => JSON.parse(await f.run({ action: 'list' })).length === 0)
    await f.run({ action: 'stop', id: preview.id })
  } finally {
    await f.close()
  }
}, 120000)
