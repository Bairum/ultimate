import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { git } from '../lib/git.ts'
import { removeWorktree } from '../extensions/workspaces/remove.ts'
import { temp } from './helpers.ts'

const identity = ['-c', 'user.name=T', '-c', 'user.email=t@example.com']
const commit = (cwd: string, message: string) =>
  git(cwd, ...identity, 'commit', '--quiet', '--allow-empty', '-m', message)
const file = ['-c', 'protocol.file.allow=always']

let source: string, worktree: string, sub: string
beforeEach(async () => {
  const root = await temp('ultimate-remove-')
  const library = join(root, 'library')
  source = join(root, 'source')
  worktree = join(root, 'worktree')
  await git(root, 'init', '--quiet', '-b', 'main', library)
  await commit(library, 'library')
  await git(root, 'init', '--quiet', '-b', 'main', source)
  await commit(source, 'root')
  await git(source, ...file, 'submodule', 'add', '--quiet', library, 'lib')
  await commit(source, 'add submodule')
  await git(source, 'worktree', 'add', '--quiet', '-b', 'feature', worktree)
  await git(worktree, ...file, 'submodule', 'update', '--init', '--quiet')
  sub = join(worktree, 'lib')
})

it('removes a worktree whose submodules were never initialised as Git does', async () => {
  const plain = join(worktree, '..', 'plain')
  await git(source, 'worktree', 'add', '--quiet', '-b', 'plain', plain)
  await removeWorktree(source, plain)
  expect(existsSync(plain)).toBe(false)
})

it('removes a worktree whose initialised submodule holds nothing unique', async () => {
  await expect(git(source, 'worktree', 'remove', worktree)).rejects.toThrow(
    'working trees containing submodules cannot be moved or removed',
  )
  await removeWorktree(source, worktree)
  expect(existsSync(worktree)).toBe(false)
  expect(await git(source, 'worktree', 'list')).not.toContain(worktree)
  // The main checkout keeps its submodule configuration.
  expect(await git(source, 'config', 'submodule.lib.active')).toBe('true')
})

it('removes a worktree whose submodule commit already reached its remote after the clone', async () => {
  await commit(sub, 'pushed later')
  await git(sub, 'push', '--quiet', 'origin', 'HEAD:refs/heads/later')
  await git(sub, 'update-ref', '-d', 'refs/remotes/origin/later')
  await removeWorktree(source, worktree)
  expect(existsSync(worktree)).toBe(false)
})

it('keeps a worktree whose submodule has commits on no remote', async () => {
  await commit(sub, 'only here')
  await git(worktree, 'add', 'lib')
  await commit(worktree, 'bump submodule')
  await expect(removeWorktree(source, worktree)).rejects.toThrow(
    'for its submodules: lib has 1 commit on no remote',
  )
  expect(existsSync(join(sub, '.git'))).toBe(true)
})

it('keeps a worktree whose submodule has uncommitted changes', async () => {
  await writeFile(join(sub, 'notes.md'), 'draft\n')
  await expect(removeWorktree(source, worktree)).rejects.toThrow(
    'for its submodules: lib has 1 uncommitted change',
  )
  expect(existsSync(join(sub, 'notes.md'))).toBe(true)
})

it('keeps a worktree whose own checkout has uncommitted changes', async () => {
  await writeFile(join(worktree, 'notes.md'), 'draft\n')
  await expect(removeWorktree(source, worktree)).rejects.toThrow('it has uncommitted changes')
  expect(existsSync(join(worktree, 'notes.md'))).toBe(true)
})

it('keeps a worktree whose deinitialised submodule repository still holds unique commits', async () => {
  await commit(sub, 'only here')
  await git(sub, 'checkout', '--quiet', '-b', 'kept')
  await git(sub, 'checkout', '--quiet', '--detach', 'HEAD~1')
  await git(worktree, 'submodule', 'deinit', '--quiet', '--all')
  await git(source, ...file, 'submodule', 'init', '--quiet')
  await expect(removeWorktree(source, worktree)).rejects.toThrow('lib has 1 commit on no remote')
})
