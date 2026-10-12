import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Workspace } from '../shared/protocol.ts'
import { create, git, requestName, worktreePath } from '../server/workspaces/worktree.ts'
import { temp, removeTemp } from './helpers.ts'

const setupOnce = async () => ({ isolates: { worktree: { setup: ['echo run >> runs.txt'] } } })
const failSetup = async () => ({ isolates: { worktree: { setup: ['exit 99'] } } })
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await removeTemp(directory)
})
async function fixture() {
  const root = await temp('ultimate-workspace-naming-')
  directories.push(root)
  const project = join(root, 'project')
  const home = join(root, 'home')
  await mkdir(project)
  await git(project, 'init', '-b', 'main')
  await git(project, 'config', 'user.email', 'test@example.com')
  await git(project, 'config', 'user.name', 'Test')
  await writeFile(join(project, 'base.txt'), 'base')
  await git(project, 'add', '.')
  await git(project, 'commit', '-m', 'base')
  const marker = (request: string, stateHome?: string) =>
    join(stateHome ?? home, 'worktrees', `${requestName(request)}.ready`)
  return { root, project, home, marker }
}
it('uses deterministic compact names and keeps the full request in the existing marker', async () => {
  const f = await fixture()
  const request = 'main:full-durable-request-identity'
  const first = await create(f.project, f.home, 'a-very-long-agent-name', request, setupOnce)
  expect(basename(first.cwd)).toBe(requestName(request))
  expect(basename(first.cwd)).toMatch(/^w-[a-f0-9]{10}$/)
  expect(first.record.branch).toBe(`ultimate/${basename(first.cwd)}`)
  expect(JSON.parse(await readFile(f.marker(request), 'utf8')).request).toBe(request)
  expect(await create(f.project, f.home, 'another-agent', request, setupOnce)).toEqual(first)
  expect(await readFile(join(first.cwd, 'runs.txt'), 'utf8')).toBe('run\n')
  const other = await create(f.project, f.home, 'worker', 'other-request')
  expect(other.cwd).not.toBe(first.cwd)
  expect(other.record.branch).not.toBe(first.record.branch)
})
it('refuses a real truncated SHA-256 collision without touching the first workspace', async () => {
  const f = await fixture()
  const firstRequest = 'collision-247742'
  const secondRequest = 'collision-777099'
  expect(requestName(firstRequest)).toBe('w-3e51a674fd')
  expect(requestName(secondRequest)).toBe(requestName(firstRequest))
  const first = await create(f.project, f.home, 'worker', firstRequest)
  await writeFile(join(first.cwd, 'valuable.txt'), 'keep me')
  const markerBefore = await readFile(f.marker(firstRequest), 'utf8')
  const gitBefore = await git(f.project, 'worktree', 'list', '--porcelain')
  await expect(create(f.project, f.home, 'worker', secondRequest)).rejects.toThrow(
    'ownership conflict',
  )
  expect(await readFile(join(first.cwd, 'valuable.txt'), 'utf8')).toBe('keep me')
  expect(await readFile(f.marker(firstRequest), 'utf8')).toBe(markerBefore)
  expect(await git(f.project, 'worktree', 'list', '--porcelain')).toBe(gitBefore)
  expect(f.marker(secondRequest)).toBe(f.marker(firstRequest))
  expect(await create(f.project, f.home, 'worker', firstRequest)).toEqual(first)
})
it('exclusively claims ownership when real colliding requests create concurrently', async () => {
  const f = await fixture()
  const requests = ['collision-247742', 'collision-777099']
  const results = await Promise.allSettled(
    requests.map((request) => create(f.project, f.home, 'worker', request, setupOnce)),
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  const owner = JSON.parse(await readFile(f.marker(requests[0]), 'utf8')).request as string
  const winner = results[requests.indexOf(owner)]
  expect(winner.status).toBe('fulfilled')
  if (winner.status !== 'fulfilled') throw new Error('Missing winning workspace')
  const loser = requests.find((request) => request !== owner)!
  await expect(create(f.project, f.home, 'worker', loser)).rejects.toThrow('ownership conflict')
  expect(await create(f.project, f.home, 'worker', owner)).toEqual(winner.value)
  expect(await readFile(join(winner.value.cwd, 'runs.txt'), 'utf8')).toBe('run\n')
})
it('refuses a preexisting unrelated branch rather than adopting its commits', async () => {
  const f = await fixture()
  const request = 'branch-conflict'
  const branch = `ultimate/${requestName(request)}`
  await git(f.project, 'branch', branch)
  const before = await git(f.project, 'rev-parse', branch)
  await expect(create(f.project, f.home, 'worker', request)).rejects.toThrow('ownership conflict')
  expect(await git(f.project, 'rev-parse', branch)).toBe(before)
  await expect(access(f.marker(request))).rejects.toThrow('ENOENT')
})
it('refuses unrelated existing paths and registered worktrees without ownership markers', async () => {
  const f = await fixture()
  const request = 'path-conflict'
  const path = await worktreePath(f.home, requestName(request))
  await mkdir(path)
  await writeFile(join(path, 'valuable.txt'), 'untouched')
  await expect(create(f.project, f.home, 'worker', request)).rejects.toThrow(
    'Unregistered workspace path exists',
  )
  expect(await readFile(join(path, 'valuable.txt'), 'utf8')).toBe('untouched')
  const registeredRequest = 'registered-conflict'
  const registeredPath = await worktreePath(f.home, requestName(registeredRequest))
  await git(
    f.project,
    'worktree',
    'add',
    '-b',
    `ultimate/${requestName(registeredRequest)}`,
    registeredPath,
  )
  await expect(create(f.project, f.home, 'worker', registeredRequest)).rejects.toThrow(
    'ownership conflict',
  )
  await access(join(registeredPath, 'base.txt'))
})
it('refuses a marker belonging to another request even at the colliding short name', async () => {
  const f = await fixture()
  const firstRequest = 'collision-247742'
  const secondRequest = 'collision-777099'
  const first = await create(f.project, f.home, 'worker', firstRequest)
  const unrelatedMarker = await readFile(f.marker(firstRequest), 'utf8')
  await writeFile(f.marker(secondRequest), unrelatedMarker)
  await expect(create(f.project, f.home, 'worker', secondRequest)).rejects.toThrow(
    'ownership conflict',
  )
  expect(await readFile(f.marker(secondRequest), 'utf8')).toBe(unrelatedMarker)
  expect(await git(first.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe(first.record.branch)
})
it('refuses cross-home branch adoption and copied ownership markers', async () => {
  const f = await fixture()
  const request = 'cross-home'
  const first = await create(f.project, f.home, 'worker', request)
  const otherHome = join(f.root, 'other-home')
  await expect(create(f.project, otherHome, 'worker', request)).rejects.toThrow(
    'ownership conflict',
  )
  await writeFile(f.marker(request, otherHome), await readFile(f.marker(request), 'utf8'))
  await expect(create(f.project, otherHome, 'worker', request)).rejects.toThrow(
    'ownership conflict',
  )
  await access(join(first.cwd, 'base.txt'))
})
it('does not treat a pending short-name document as ownership of an unrelated registration', async () => {
  const f = await fixture()
  const request = 'unowned-prepared-short-name'
  const workspace: Workspace = {
    kind: 'worktree',
    path: await worktreePath(f.home, requestName(request)),
    branch: `ultimate/${requestName(request)}`,
    base: await git(f.project, 'rev-parse', 'HEAD'),
    source: f.project,
    targetBranch: 'main',
    state: 'active',
    preparation: 'pending',
  }
  await git(f.project, 'worktree', 'add', '-b', workspace.branch, workspace.path, workspace.base)
  await expect(
    create(f.project, f.home, 'worker', request, undefined, undefined, workspace),
  ).rejects.toThrow('ownership conflict')
  await writeFile(f.marker(request), JSON.stringify(workspace))
  await expect(
    create(f.project, f.home, 'worker', request, undefined, undefined, workspace),
  ).rejects.toThrow('ownership conflict')
  expect(await readFile(f.marker(request), 'utf8')).toBe(JSON.stringify(workspace))
})
it('validates registered branch ownership before replaying a ready marker', async () => {
  const f = await fixture()
  const request = 'changed-branch'
  const first = await create(f.project, f.home, 'worker', request)
  await git(first.cwd, 'checkout', '-b', 'unrelated')
  await expect(create(f.project, f.home, 'worker', request)).rejects.toThrow('ownership conflict')
  expect(await git(first.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('unrelated')
})
it.each([false, true])(
  'resumes prepared long identities when Git add already completed: %s',
  async (registered) => {
    const f = await fixture()
    const request = 'persisted-long-identity'
    const key = createHash('sha256').update(request).digest('hex')
    const workspace: Workspace = {
      kind: 'worktree',
      path: await worktreePath(f.home, key),
      branch: `ultimate/old-worker-${key.slice(0, 16)}`,
      base: await git(f.project, 'rev-parse', 'HEAD'),
      source: f.project,
      targetBranch: 'main',
      state: 'active',
      preparation: 'pending',
    }
    await writeFile(join(f.home, 'worktrees', `${key}.ready`), JSON.stringify(workspace))
    if (registered)
      await git(
        f.project,
        'worktree',
        'add',
        '-b',
        workspace.branch,
        workspace.path,
        workspace.base,
      )
    const first = await create(
      f.project,
      f.home,
      'old-worker',
      request,
      setupOnce,
      undefined,
      workspace,
    )
    expect(first.cwd).toBe(workspace.path)
    expect(first.record.branch).toBe(workspace.branch)
    expect(await git(first.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe(workspace.branch)
    expect(await readFile(join(first.cwd, 'runs.txt'), 'utf8')).toBe('run\n')
    await expect(access(join(f.home, 'worktrees', requestName(request)))).rejects.toThrow('ENOENT')
    expect(
      await create(f.project, f.home, 'old-worker', request, setupOnce, undefined, workspace),
    ).toEqual(first)
    expect(await readFile(join(first.cwd, 'runs.txt'), 'utf8')).toBe('run\n')
  },
)
it('preserves an existing legacy ready marker byte-for-byte', async () => {
  const f = await fixture()
  const request = 'legacy-ready'
  const key = createHash('sha256').update(request).digest('hex')
  const workspace: Workspace = {
    kind: 'worktree',
    path: await worktreePath(f.home, key),
    branch: `ultimate/old-worker-${key.slice(0, 16)}`,
    base: await git(f.project, 'rev-parse', 'HEAD'),
    source: f.project,
    targetBranch: 'main',
    state: 'active',
    preparation: 'ready',
  }
  await git(f.project, 'worktree', 'add', '-b', workspace.branch, workspace.path, workspace.base)
  const originalMarker = JSON.stringify(workspace)
  const legacyMarker = join(f.home, 'worktrees', `${key}.ready`)
  await writeFile(legacyMarker, originalMarker)
  expect(await create(f.project, f.home, 'old-worker', request, failSetup)).toEqual({
    cwd: workspace.path,
    record: workspace,
  })
  expect(await readFile(legacyMarker, 'utf8')).toBe(originalMarker)
})
it('never adopts a retained branch on retry after failed clean setup', async () => {
  const f = await fixture()
  const request = 'failed-clean-setup'
  await expect(
    create(f.project, f.home, 'worker', request, async () => ({
      isolates: { worktree: { setup: ['exit 1'] } },
    })),
  ).rejects.toThrow('Worktree setup failed')
  await expect(create(f.project, f.home, 'worker', request)).rejects.toThrow('ownership conflict')
  expect(await git(f.project, 'branch', '--list', `ultimate/${requestName(request)}`)).not.toBe('')
})
