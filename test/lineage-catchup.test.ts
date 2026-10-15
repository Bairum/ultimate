import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { Branch, leaveNote } from '../extensions/lineage/server.ts'
import { Seen } from '../extensions/lineage/catchup.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['plan', 'subagents'] } }),
  )
})

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : ((content ?? []) as { type: string; text?: string }[])
        .flatMap((part) => (part.type === 'text' ? [part.text!] : []))
        .join('')

const ask = async (server: Server, id: ConversationId, content: string) =>
  (
    await (await server.harness.conversation(id, context))!.submit(
      { type: 'input', content },
      context,
    )
  ).wait(context)

const repoGit = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_COUNT: '0' } })
    .toString()
    .trim()

async function catchupFixture(disableWorkspaces = false) {
  const home = await temp('ultimate-lineage-main-')
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  repoGit(projectRoot, 'init', '-b', 'main')
  repoGit(projectRoot, 'config', 'user.email', 'test@example.com')
  repoGit(projectRoot, 'config', 'user.name', 'Test')
  await writeFile(join(projectRoot, 'schema.ts'), 'base\n')
  repoGit(projectRoot, 'add', '.')
  repoGit(projectRoot, 'commit', '-m', 'base')
  if (disableWorkspaces) {
    await mkdir(join(home, '.ultimate'))
    await writeFile(
      join(home, '.ultimate/settings.json'),
      JSON.stringify({ extensions: { disable: ['workspaces'] } }),
    )
  }
  const config = { ultimateRoot, home, userHome: home, projectRoot }
  const requests: string[][] = []
  const gate = Promise.withResolvers<void>()
  let held = false
  const open = async () => {
    const server = await fauxServer(config)
    servers.push(server)
    const route: FauxResponseFactory = async (transcript, options) => {
      server.host.faux!.appendResponses([route])
      requests.push(
        transcript.messages
          .filter((message) => message.role === 'user')
          .map((message) => textOf(message.content)),
      )
      const last = transcript.messages.at(-1)!
      const text = textOf(last.content)
      if (last.role === 'user' && text === 'edit schema')
        return fauxAssistantMessage(
          [fauxToolCall('write', { path: join(projectRoot, 'schema.ts'), content: 'own edit\n' })],
          { stopReason: 'toolUse' },
        )
      if (
        (last.role === 'toolResult' && text.includes('schema.ts')) ||
        (last.role === 'user' && text === 'resume during restart')
      ) {
        held = true
        await Promise.race([
          gate.promise,
          new Promise((_, fail) =>
            options?.signal?.addEventListener('abort', () => fail(new Error('closed'))),
          ),
        ])
      }
      return fauxAssistantMessage(`echo ${text}`)
    }
    server.host.faux!.setResponses([route])
    return server
  }
  const server = await open()
  return { server, projectRoot, requests, open, release: () => gate.resolve(), held: () => held }
}

it('catches up once on an idle resume, puts overlap first, and reads it before the input', async () => {
  const f = await catchupFixture()
  const seen = await f.server.harness.snapshot(Seen, ROOT_CONVERSATION_ID, context)
  expect(seen?.main).toBe(repoGit(f.projectRoot, 'rev-parse', 'main'))
  const editing = ask(f.server, ROOT_CONVERSATION_ID, 'edit schema')
  await until(f.held)
  f.release()
  await editing
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Fix schema\n\nUltimate-Conversation: 1')
  await writeFile(join(f.projectRoot, 'other.ts'), 'other\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Add something unrelated')
  await ask(f.server, ROOT_CONVERSATION_ID, 'continue work')
  const notes = (await f.server.root.context(context)).entries.filter(
    (entry) =>
      entry.kind === 'lineage.note' && (entry.data as { source?: string }).source === 'main',
  )
  expect(notes).toHaveLength(1)
  const text = (notes[0].data as { text: string }).text
  expect(text).toContain('2 commits landed on main')
  expect(text).toMatch(/\*\*Overlap\*\* .*Fix schema · #1 edit schema/)
  expect(text).toContain('`schema.ts`')
  expect(text.indexOf('Fix schema')).toBeLessThan(text.indexOf('Add something unrelated'))
  expect(f.requests.at(-1)!.slice(-2)).toEqual([text, 'continue work'])
  const view = await f.server.root.context(context)
  const resumed = view.entries.find((entry) =>
    entry.model?.some(
      (message) => message.role === 'user' && textOf(message.content) === 'continue work',
    ),
  )!
  expect(notes[0].id).toBeLessThan(resumed.id)
  expect(notes[0].edits).toBeUndefined()
  expect(notes[0].model?.[0]?.content).toBe(text)
  expect(
    view.messages
      .filter((message) => message.role === 'user')
      .map((message) => textOf(message.content))
      .slice(-2),
  ).toEqual([text, 'continue work'])
  expect(view.entries.findLastIndex((entry) => entry.kind === 'pi.assistant')).toBeGreaterThan(
    view.entries.indexOf(notes[0]),
  )
  expect((await f.server.harness.snapshot(Seen, ROOT_CONVERSATION_ID, context))?.main).toBe(
    repoGit(f.projectRoot, 'rev-parse', 'main'),
  )
  await ask(f.server, ROOT_CONVERSATION_ID, 'continue again')
  expect(
    (await f.server.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toHaveLength(1)

  await f.server.close()
  servers.splice(servers.indexOf(f.server), 1)
  const reopened = await f.open()
  await ask(reopened, ROOT_CONVERSATION_ID, 'after restart')
  expect(
    (await reopened.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toHaveLength(1)
  expect(f.requests.at(-1)!.filter((message) => message === text)).toHaveLength(1)
})

it('seeds and catches up a shared conversation with workspaces disabled', async () => {
  const f = await catchupFixture(true)
  expect(f.server.host.registry.snapshot().extension('workspaces')).toBeUndefined()
  expect((await f.server.harness.snapshot(Seen, ROOT_CONVERSATION_ID, context))?.main).toBe(
    repoGit(f.projectRoot, 'rev-parse', 'HEAD'),
  )
  await ask(f.server, ROOT_CONVERSATION_ID, 'start shared work')
  await writeFile(join(f.projectRoot, 'landed.ts'), 'landed\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Shared landing')
  await ask(f.server, ROOT_CONVERSATION_ID, 'resume shared work')
  const entries = (await f.server.root.context(context)).entries
  const notes = entries.filter(
    (entry) =>
      entry.kind === 'lineage.note' && (entry.data as { source?: string }).source === 'main',
  )
  expect(notes).toHaveLength(1)
  const text = (notes[0].data as { text: string }).text
  expect(text).toContain('1 commits landed on main')
  expect(text).toContain('Shared landing')
  expect(f.requests.at(-1)!.slice(-2)).toEqual([text, 'resume shared work'])
})

it('does not catch up when a note and new commits arrive in the middle of a run', async () => {
  const f = await catchupFixture()
  const run = ask(f.server, ROOT_CONVERSATION_ID, 'edit schema')
  await until(f.held)
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Landed during work')
  await leaveNote(
    { harness: () => f.server.harness },
    ROOT_CONVERSATION_ID,
    'A sibling left a note.',
    { from: 2 },
  )
  f.release()
  await run
  let view = await f.server.root.context(context)
  expect(
    view.entries
      .filter((entry) => entry.kind === 'lineage.note')
      .map((entry) => (entry.data as { source?: string }).source),
  ).toEqual([undefined])
  await ask(f.server, ROOT_CONVERSATION_ID, 'resume after idle')
  view = await f.server.root.context(context)
  expect(
    view.entries.filter(
      (entry) =>
        entry.kind === 'lineage.note' && (entry.data as { source?: string }).source === 'main',
    ),
  ).toHaveLength(1)
})

it('keeps a catch-up exactly once when reopened during the first request', async () => {
  const f = await catchupFixture()
  await ask(f.server, ROOT_CONVERSATION_ID, 'first work')
  await writeFile(join(f.projectRoot, 'schema.ts'), 'landed\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Land schema')
  const interrupted = ask(f.server, ROOT_CONVERSATION_ID, 'resume during restart').catch(
    () => undefined,
  )
  await until(f.held)
  expect(
    (await f.server.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toHaveLength(1)
  await f.server.close()
  servers.splice(servers.indexOf(f.server), 1)
  await interrupted
  const reopened = await f.open()
  f.release()
  await reopened.root.waitForIdle(context)
  const view = await reopened.root.context(context)
  const notes = view.entries.filter((entry) => entry.kind === 'lineage.note')
  expect(notes).toHaveLength(1)
  expect(f.requests.at(-1)!.slice(-2)).toEqual([
    (notes[0].data as { text: string }).text,
    'resume during restart',
  ])
})

it('warns an isolated workspace it is behind, prioritizes old overlaps, and caps the rows at 30', async () => {
  const f = await catchupFixture()
  await ask(f.server, ROOT_CONVERSATION_ID, 'An idea')
  const { id } = (
    await post(f.server, '/api/extensions/lineage/actions/branch', {
      args: { from: 1, prompt: 'Branch task', isolated: true },
    })
  ).data.result as { id: ConversationId }
  const branch = (await f.server.harness.conversation(id, context))!
  await until(
    async () => (await f.server.harness.snapshot(Branch, id, context))?.branch?.status === 'ready',
  )
  await branch.waitForIdle(context)
  const workspace = (await branch.agent(context)).cwd!
  await writeFile(join(workspace, 'schema.ts'), 'own workspace change\n')
  await writeFile(join(f.projectRoot, 'schema.ts'), 'overlapping landing\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Old overlap')
  for (let i = 0; i < 31; i++) repoGit(f.projectRoot, 'commit', '--allow-empty', '-m', `Other ${i}`)
  await ask(f.server, id, 'Continue branch')
  const notes = (await branch.context(context)).entries.filter(
    (entry) => entry.conversationId === id && entry.kind === 'lineage.note',
  )
  expect(notes).toHaveLength(1)
  const text = (notes[0].data as { text: string }).text
  expect(text).toContain('32 commits landed on main')
  expect(text.split('\n\n')[1]).toMatch(/^- \*\*Overlap\*\* .*Old overlap.*schema.ts/)
  expect(text.split('\n\n').filter((row) => row.startsWith('- '))).toHaveLength(30)
  expect(text).toContain('and 2 more')
  expect(text).toContain('Your workspace is 32 commits behind main; merge it before continuing.')
})
