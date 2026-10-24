import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { backend, cloneMode, populate } from '../extensions/workspaces/clone.ts'
import { git } from '../lib/git.ts'
import * as gitModule from '../lib/git.ts'
import { removeTemps, temp } from './helpers.ts'

afterEach(removeTemps)
afterEach(() => vi.restoreAllMocks())

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

it('refuses a missing git file without touching the enclosing source', async () => {
  const { src, path } = await source()
  const nested = join(src, 'nested')
  await git(src, 'worktree', 'move', path, nested)
  await rm(join(nested, '.git'))
  await writeFile(join(nested, 'keep'), 'safe\n')
  await expect(populate(src, nested, 'auto')).rejects.toThrow(/Unsafe worktree repository/)
  expect(await readFile(join(src, 'untracked'), 'utf8')).toBe('stray\n')
  expect(await readFile(join(nested, 'keep'), 'utf8')).toBe('safe\n')
  expect(await readFile(join(src, 'tracked'), 'utf8')).toBe('dirty\n')
})

it('refuses a git file that points at the source repository itself', async () => {
  const { src, path } = await source()
  await writeFile(join(path, '.git'), `gitdir: ${join(src, '.git')}\n`)
  await expect(populate(src, path, 'auto')).rejects.toThrow(/Unsafe worktree repository/)
  expect(await readFile(join(src, 'tracked'), 'utf8')).toBe('dirty\n')
  expect(await git(src, 'diff', '--name-only')).toBe('tracked')
})

it('clones a repository whose file list exceeds 1 MiB', async () => {
  const { src, path } = await source()
  await mkdir(join(src, 'many'))
  // About 120 bytes per `ls-files -s -z` entry: 10,000 files list 1.2 MB.
  const name = 'x'.repeat(60)
  await Promise.all(
    Array.from({ length: 10_000 }, (_, i) => writeFile(join(src, 'many', `${name}${i}`), '')),
  )
  await git(src, 'add', 'many')
  await git(src, 'commit', '--quiet', '-m', 'many')
  await git(path, 'reset', '--soft', '--quiet', await git(src, 'rev-parse', 'HEAD'))
  const { backend: used, reason } = await populate(src, path, 'auto')
  expect(reason).toBeUndefined()
  expect(used).toBe(backend('auto'))
  expect(await git(path, 'status', '--porcelain')).toBe('')
})

it('falls back visibly on a failed gitlink listing, but explicit backends throw', async () => {
  const { src, path } = await source()
  const original = gitModule.git
  vi.spyOn(gitModule, 'git').mockImplementation((cwd, ...args) => {
    if (args[0] === 'ls-files') return Promise.reject(new Error('listing failed'))
    return original(cwd, ...args)
  })
  await expect(populate(src, path, 'auto')).resolves.toEqual({
    backend: 'git',
    reason: 'listing failed',
  })
  expect(await readFile(join(path, 'tracked'), 'utf8')).toBe('committed\n')
  await expect(populate(src, path, 'apfs')).rejects.toThrow('listing failed')
})

it('refreshes the copied index before resetting, so unchanged cloned files are not rewritten', async () => {
  const { src, path } = await source()
  const calls: string[] = []
  const original = gitModule.git
  vi.spyOn(gitModule, 'git').mockImplementation((cwd, ...args) => {
    const dir = typeof cwd === 'string' ? cwd : cwd.cwd
    if (dir === path && (args[0] === 'update-index' || args[0] === 'reset')) calls.push(args[0])
    return original(cwd, ...args)
  })
  const { backend: used } = await populate(src, path, 'auto')
  expect(calls).toEqual(used === 'git' ? ['reset'] : ['update-index', 'reset'])
})

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
  const { src, path } = await source()
  await symlink(join(src, 'tracked'), join(src, 'deps', 'source-link'))
  const { backend: used } = await populate(join(path, '..', 'src'), path, 'auto')
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
  expect(used === 'git' ? [] : await readdir(join(path, 'deps'))).toEqual(
    used === 'git' ? [] : ['lib'],
  )
})

it('leaves a nested submodule out of the clone but keeps ignored files beside it', async () => {
  const dir = await temp('ultimate-clone-')
  const lib = join(dir, 'lib')
  await mkdir(lib)
  await git(lib, 'init', '--quiet')
  await git(lib, 'commit', '--quiet', '--allow-empty', '-m', 'lib')
  const src = join(dir, 'src')
  await mkdir(src)
  await git(src, 'init', '--quiet')
  await writeFile(join(src, '.gitignore'), 'build/\n')
  await git(
    src,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--quiet',
    lib,
    'libs/sub module',
  )
  await git(src, 'add', '.')
  await git(src, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '--quiet', '-m', 'first')
  await mkdir(join(src, 'libs', 'build'))
  await writeFile(join(src, 'libs', 'build', 'out'), 'built\n')
  const path = join(dir, 'wt')
  await git(src, 'worktree', 'add', '--quiet', '--no-checkout', '-b', 'feature', path, 'HEAD')
  const { backend: used } = await populate(src, path, 'auto')
  expect(await readdir(join(path, 'libs', 'sub module'))).toEqual([])
  const built = await readFile(join(path, 'libs', 'build', 'out'), 'utf8').catch(
    // A plain checkout has no ignored files.
    () => null,
  )
  expect(built).toBe(used === 'git' ? null : 'built\n')
  expect(await git(path, 'status', '--porcelain')).toBe('')
})

it('checks out plainly with the git mode, starting over on a half-filled checkout', async () => {
  const { src, path } = await source()
  await writeFile(join(path, 'leftover'), 'from a crash\n')
  expect((await populate(src, path, 'git')).backend).toBe('git')
  expect((await readdir(path)).toSorted()).toEqual(['.git', '.gitignore', 'tracked'])
  expect(await git(path, 'status', '--porcelain')).toBe('')
})
