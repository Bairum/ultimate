import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { git } from '../../lib/git.ts'
import { fastForward, Refusal } from '../../lib/fast-forward.ts'
import { cloneState, fetchIfDue, layersOf } from '../../extensions/update/clone.ts'
import { gitIn, installOwed } from '../../extensions/update/server.ts'
import { temp } from '../helpers.ts'

let upstream: string
let clone: string

/** Commit `files` upstream; returns the new sha. */
async function push(files: Record<string, string>, message = 'change') {
  for (const [name, body] of Object.entries(files)) {
    const path = join(upstream, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
  }
  await git(upstream, 'add', '-A')
  await git(upstream, 'commit', '-q', '-m', message)
  return git(upstream, 'rev-parse', 'HEAD')
}

beforeEach(async () => {
  upstream = await temp('ultimate-update-up-')
  await git(upstream, 'init', '-q', '-b', 'main')
  await git(upstream, 'config', 'user.email', 'test@example.com')
  await git(upstream, 'config', 'user.name', 'Test')
  await push({ 'README.md': 'hello\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'first')
  clone = join(await temp('ultimate-update-clone-'), 'clone')
  await git(process.cwd(), 'clone', '-q', upstream, clone)
  await git(clone, 'config', 'user.email', 'test@example.com')
  await git(clone, 'config', 'user.name', 'Test')
})

it('names the layers a range touches', () => {
  expect(layersOf(['extensions/a/web.tsx', 'web/src/x.ts'])).toEqual({
    core: false,
    bin: false,
    lockfile: false,
    live: true,
  })
  expect(
    layersOf(['server/main.ts', 'shared/protocol.ts', 'bin/ultimate.ts', 'pnpm-lock.yaml']),
  ).toEqual({ core: true, bin: true, lockfile: true, live: false })
})

it('fetches only when the last fetch is an hour old', async () => {
  const run = gitIn(clone)
  // A fresh clone has never fetched: due at once.
  expect(await fetchIfDue(run, clone, Date.now())).toBeUndefined()
  await push({ 'extensions/a/web.tsx': 'x\n' })
  // That fetch just happened: not due, origin/main stays where it was.
  expect(await fetchIfDue(run, clone, Date.now())).toBeUndefined()
  expect((await cloneState(run, clone)).behind).toBe(0)
  // Backdate FETCH_HEAD: due now.
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  await utimes(join(clone, '.git/FETCH_HEAD'), old, old)
  expect(await fetchIfDue(run, clone, Date.now())).toBeUndefined()
  const state = await cloneState(run, clone)
  expect(state).toMatchObject({
    branch: 'main',
    behind: 1,
    layers: { live: true, core: false },
  })
  expect(state.commits).toHaveLength(1)
  expect(state.refused).toBeUndefined()
})

it('fast-forwards a clone behind origin and reports the lockfile change', async () => {
  const tip = await push({
    'server/main.ts': 'x\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\npackages: {}\n',
  })
  let owed = false
  const result = await fastForward(gitIn(clone), async () => {
    owed = true
  })
  expect(result).toMatchObject({ behind: 1, lockfile: true, after: tip })
  expect(owed).toBe(true)
  expect(await git(clone, 'rev-parse', 'HEAD')).toBe(tip)
})

it('refuses a dirty, switched or diverged clone and leaves it alone', async () => {
  await push({ 'extensions/a/web.tsx': 'x\n' })
  const run = gitIn(clone)
  const head = await git(clone, 'rev-parse', 'HEAD')

  await writeFile(join(clone, 'README.md'), 'local edit\n')
  await expect(fastForward(run)).rejects.toThrow(
    new Refusal('The checkout has uncommitted changes'),
  )
  await git(clone, 'checkout', '-q', '--', 'README.md')

  await git(clone, 'checkout', '-q', '-b', 'side')
  await expect(fastForward(run)).rejects.toThrow('The checkout is on side, not main')
  await git(clone, 'checkout', '-q', 'main')

  await writeFile(join(clone, 'local.txt'), 'mine\n')
  await git(clone, 'add', '-A')
  await git(clone, 'commit', '-q', '-m', 'local')
  const local = await git(clone, 'rev-parse', 'HEAD')
  await expect(fastForward(run)).rejects.toThrow('main has diverged from origin/main')
  expect(local).not.toBe(head)
  expect(await git(clone, 'rev-parse', 'HEAD')).toBe(local)
  expect((await cloneState(run, clone)).refused).toBe('main has diverged from origin/main')
})

it('owes an install while the lockfile differs from the installed one', async () => {
  expect(await installOwed(clone)).toBe(true)
  await mkdir(join(clone, 'node_modules/.pnpm'), { recursive: true })
  await writeFile(join(clone, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\n')
  expect(await installOwed(clone)).toBe(false)
})
