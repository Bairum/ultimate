import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { backend, cloneMode, populate } from '../extensions/workspaces/clone.ts'
import { git } from '../lib/git.ts'
import { removeTemps, temp } from './helpers.ts'

afterEach(removeTemps)

/** A source checkout with a commit, then a dirty tracked file, an untracked file and an ignored directory. */
async function source() {
  const dir = await temp('ultimate-clone-')
  const src = join(dir, 'src')
  await mkdir(src)
  await git(src, 'init', '--quiet')
  await git(src, 'config', 'user.email', 'test@example.com')
  await git(src, 'config', 'user.name', 'Test')
  await writeFile(join(src, 'tracked'), 'committed\n')
  await writeFile(join(src, '.gitignore'), 'deps/\n')
  await git(src, 'add', '.')
  await git(src, 'commit', '--quiet', '-m', 'first')
  await writeFile(join(src, 'tracked'), 'dirty\n')
  await writeFile(join(src, 'untracked'), 'stray\n')
  await mkdir(join(src, 'deps'))
  await writeFile(join(src, 'deps', 'lib'), 'installed\n')
  const path = join(dir, 'wt')
  await git(src, 'worktree', 'add', '--quiet', '--no-checkout', '-b', 'feature', path, 'HEAD')
  return { src, path }
}

it('reads the setting and picks the platform backend', () => {
  expect(cloneMode({})).toBe('auto')
  expect(cloneMode({ isolates: { worktree: { clone: 'git' } } })).toBe('git')
  expect(() => cloneMode({ isolates: { worktree: { clone: 'zfs' } } })).toThrow(/must be one of/)
  expect(backend('auto', 'darwin')).toBe('apfs')
  expect(backend('auto', 'linux')).toBe('reflink')
  expect(backend('auto', 'win32')).toBeNull()
  expect(backend('git', 'darwin')).toBeNull()
})

it('clones the checkout at the branch commit with ignored files, without uncommitted changes', async () => {
  const { path } = await source()
  const used = await populate(join(path, '..', 'src'), path, 'auto')
  expect(await readFile(join(path, 'tracked'), 'utf8')).toBe('committed\n')
  expect(await git(path, 'status', '--porcelain')).toBe('')
  expect(await git(path, 'branch', '--show-current')).toBe('feature')
  expect((await readdir(path)).toSorted()).toEqual(
    used === 'git' ? ['.git', '.gitignore', 'tracked'] : ['.git', '.gitignore', 'deps', 'tracked'],
  )
  const deps = await readFile(join(path, 'deps', 'lib'), 'utf8').catch(
    // A plain checkout has no ignored files.
    () => null,
  )
  expect(deps).toBe(used === 'git' ? null : 'installed\n')
})

it('checks out plainly with the git mode, starting over on a half-filled checkout', async () => {
  const { src, path } = await source()
  await writeFile(join(path, 'leftover'), 'from a crash\n')
  expect(await populate(src, path, 'git')).toBe('git')
  expect((await readdir(path)).toSorted()).toEqual(['.git', '.gitignore', 'tracked'])
  expect(await git(path, 'status', '--porcelain')).toBe('')
})
