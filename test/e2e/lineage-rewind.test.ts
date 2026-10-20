import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure } from '@earendil-works/pi-durable'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Committed } from '../../extensions/coding-tools/refs.ts'
import { context } from '../../server/harness.ts'
import { emit } from '../../server/events.ts'
import { fauxServer, post, sourceCopy, temp } from '../helpers.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
})
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_COUNT: '0' } })
    .toString()
    .trim()

it('lists what changed in the checkout since the entry and leaves files and commits as they are', async () => {
  const home = await temp('ultimate-rewind-git-')
  const repo = join(home, 'repo')
  await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  const commit = async (file: string, text: string, subject: string) => {
    await writeFile(join(repo, file), text)
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', subject)
    return git(repo, 'rev-parse', 'HEAD')
  }
  await commit('base.ts', 'base\n', 'base')
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const echo: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([echo])
    const last = transcript.messages.findLast((message) => message.role === 'user')
    return fauxAssistantMessage(`echo ${typeof last?.content === 'string' ? last.content : ''}`)
  }
  server.host.faux!.setResponses([echo])
  const { model } = await server.root.agent(context)
  const conversation = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model } },
    context,
  )
  await server.harness.commit((tx) => configure(tx, conversation.id, { cwd: repo }), context)
  const ask = async (content: string) =>
    (await conversation.submit({ type: 'input', content }, context)).wait(context)
  const recorded = (sha: string, subject: string) =>
    server.harness.commit(
      (tx) =>
        emit(tx, Committed, {
          conversation: conversation.id,
          sha,
          parents: [git(repo, 'rev-parse', `${sha}^`)],
          repo,
          subject,
        }),
      context,
    )
  // A commit before the entry, then the entry, then a commit and uncommitted work after it.
  await recorded(await commit('early.ts', 'early\n', 'early'), 'early')
  await ask('one')
  const at = (await conversation.context(context)).entries.at(-1)!.id
  await ask('two')
  const late = await commit('late.ts', 'a\nb\n', 'late')
  await recorded(late, 'late')
  await writeFile(join(repo, 'base.ts'), 'base\nmore\n')
  await writeFile(join(repo, 'scratch.md'), 'new\n')
  const call = (action: string, args: object) =>
    post(server, `/api/extensions/lineage/actions/${action}`, { args })

  const preview = (await call('rewindPreview', { conversation: conversation.id, at })).data.result
  expect(preview.commits).toEqual([{ sha: late, subject: 'late' }])
  expect(preview.files).toEqual([
    { path: 'base.ts', added: 1, removed: 0 },
    { path: 'late.ts', added: 2, removed: 0 },
    { path: 'scratch.md', added: 0, removed: 0, untracked: true },
  ])
  const status = git(repo, 'status', '--porcelain')
  const { data } = await call('rewind', { conversation: conversation.id, at })
  expect(data.error).toBeUndefined()
  const note = (await conversation.context(context)).messages.at(-1)!.content as string
  expect(note).toContain('- late.ts (+2 −0)')
  expect(note).toContain('- scratch.md (new, untracked)')
  expect(note).not.toContain('early.ts')
  expect(note).toContain(`Commits since: ${late.slice(0, 7)} late`)
  expect(note).toContain("They're still there; decide whether to keep or undo them.")
  // Git is untouched: the same tip, the same files.
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(late)
  expect(git(repo, 'status', '--porcelain')).toBe(status)
  expect(await readFile(join(repo, 'base.ts'), 'utf8')).toBe('base\nmore\n')
})
