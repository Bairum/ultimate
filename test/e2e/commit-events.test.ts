import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConversationId, ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { createBashTool } from '@earendil-works/pi-durable/tools'
import type { EventToken } from '../../shared/events.ts'
import codingTools from '../../extensions/coding-tools/server.ts'
import { Committed } from '../../extensions/coding-tools/refs.ts'
import { context } from '../../server/harness.ts'
import { removeTemp, temp } from '../helpers.ts'

const run = promisify(execFile)
type Event = typeof Committed extends EventToken<infer D> ? D : never

let cwd: string
let emitted: Event[]
let calls = 0
const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim()

beforeEach(async () => {
  cwd = await realpath(await temp('ultimate-commit-events-'))
  emitted = []
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Event Test')
  await git('config', 'user.email', 'event@example.test')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await removeTemp(cwd)
})

/** The extension's bash tool, run as one call of conversation 7 in `dir`. */
async function bash(command: string, dir = cwd) {
  const extension = codingTools({
    emit: async (_tx, event, data) => {
      expect(event).toBe(Committed)
      emitted.push(data as Event)
      return undefined as never
    },
  })
  const tool = extension.tools!.find((candidate) => candidate.name === 'bash') as ReturnType<
    typeof createBashTool
  >
  let output = ''
  const api = {
    conversationId: 7 as ConversationId,
    taskId: `task-commit-events-${++calls}`,
    callId: 'call',
    env: new NodeExecutionEnv({ cwd: dir }),
    output: (chunk: string | Uint8Array) => (output += chunk.toString()),
    outputWindow: undefined,
    retainedOutput: () => ({ text: output, truncated: false }),
    diagnostic: () => {},
    commit: async (change: (tx: never) => unknown) => change(undefined as never),
  } as unknown as ToolExecutionApi
  const result = await tool.execute({ command }, api, context)
  return { result, output }
}

it('records a commit through bash with its full sha, parents, branch and subject', async () => {
  await bash('git commit -q --allow-empty -m first && git commit -q --allow-empty -m second')
  const [first, second] = [await git('rev-parse', 'HEAD~1'), await git('rev-parse', 'HEAD')]
  expect(emitted).toEqual([
    { conversation: 7, sha: first, parents: [], repo: cwd, branch: 'main', subject: 'first' },
    {
      conversation: 7,
      sha: second,
      parents: [first],
      repo: cwd,
      branch: 'main',
      subject: 'second',
    },
  ])
  expect(second).toMatch(/^[0-9a-f]{40}$/)
})

it('records an amend with the commit it replaced', async () => {
  await git('commit', '--allow-empty', '-m', 'one')
  const before = await git('rev-parse', 'HEAD')
  await bash('git commit -q --amend --allow-empty -m two')
  expect(emitted).toEqual([
    {
      conversation: 7,
      sha: await git('rev-parse', 'HEAD'),
      parents: [],
      repo: cwd,
      branch: 'main',
      subject: 'two',
      rewrittenFrom: before,
    },
  ])
})

it('records a commit in a linked worktree under its repository and a detached HEAD without branch', async () => {
  await git('commit', '--allow-empty', '-m', 'base')
  const tree = join(cwd, 'tree')
  await git('worktree', 'add', '--detach', tree)
  await bash('git commit -q --allow-empty -m detached', tree)
  expect(emitted).toEqual([
    expect.objectContaining({ repo: cwd, worktree: tree, subject: 'detached' }),
  ])
  expect(emitted[0]).not.toHaveProperty('branch')
})

it('records its own merge commits but not fast-forwards', async () => {
  await git('commit', '--allow-empty', '-m', 'base')
  await git('checkout', '-b', 'side')
  await git('commit', '--allow-empty', '-m', 'side')
  await git('checkout', 'main')
  await git('checkout', '-b', 'ff', 'main')
  await bash('git merge -q --ff-only side')
  expect(emitted).toEqual([])
  await git('checkout', 'main')
  await git('commit', '--allow-empty', '-m', 'main')
  await bash('git merge -q --no-ff side -m merged')
  expect(emitted).toEqual([
    expect.objectContaining({ sha: await git('rev-parse', 'HEAD'), subject: 'merged' }),
  ])
  expect(emitted[0].parents).toHaveLength(2)
})

it('records nothing when bash made no commit', async () => {
  await bash('git status --short && echo done')
  await bash('false').catch(() => undefined)
  expect(emitted).toEqual([])
})

it('never fails a commit when the log cannot be written', async () => {
  // A log path inside a missing directory makes every hook's append fail.
  vi.stubEnv('TMPDIR', join(cwd, 'missing'))
  const { result } = await bash('git commit -q --allow-empty -m kept && echo ok')
  expect(result.isError).toBeFalsy()
  expect(await git('log', '-1', '--format=%s')).toBe('kept')
  expect(emitted).toEqual([])
})
