import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  addWorktree,
  removeWorktree,
  treeName,
  treePath,
} from '../../extensions/workspaces/tree.ts'

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tree-')))
  const source = join(root, 'source')
  execFileSync('git', ['init', '-q', '-b', 'main', source])
  run(
    source,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'first',
  )
  return { root, source, base: run(source, 'rev-parse', 'HEAD') }
}

test('a configured path names checkouts, expands ~, resolves symlinks and must be absolute', async () => {
  expect(treeName('ultimate/abc123-7')).toBe('ult-abc123-7')
  expect(await treePath({ isolates: { worktree: { path: '~/trees/{name}/src' } } }, 'ult-1')).toBe(
    join(realpathSync(homedir()), 'trees/ult-1/src'),
  )
  expect(await treePath({}, 'ult-1')).toBeUndefined()
  const { root } = repository()
  symlinkSync(root, join(root, 'link'))
  expect(await treePath({ isolates: { worktree: { path: join(root, 'link/{name}') } } }, 'a')).toBe(
    join(root, 'a'),
  )
  await expect(treePath({ isolates: { worktree: { path: 'trees/{name}' } } }, 'a')).rejects.toThrow(
    'must be absolute',
  )
  await expect(treePath({ isolates: { worktree: { path: 1 } } }, 'a')).rejects.toThrow(
    'isolates.worktree.path must be a string',
  )
})

test('a path alone keeps git worktree add and remove', async () => {
  const { root, source, base } = repository()
  const settings = { isolates: { worktree: { path: join(root, 'trees/{name}') } } }
  const path = (await treePath(settings, 'ult-1'))!
  await addWorktree(settings, source, path, 'ult-1', ['-b', 'ultimate/x-1', base])
  expect(run(path, 'symbolic-ref', '--short', 'HEAD')).toBe('ultimate/x-1')
  await removeWorktree(settings, source, path, 'ult-1')
  expect(run(source, 'worktree', 'list', '--porcelain')).not.toContain(path)
})

test('configured add and remove commands get {name} and {path} as shell words, and must do their part', async () => {
  const { root, source, base } = repository()
  const settings = {
    isolates: {
      worktree: {
        path: join(root, "it's here/{name}"),
        add: 'git worktree add --detach {path} HEAD',
        remove: 'git worktree remove {path}',
      },
    },
  }
  const path = (await treePath(settings, 'ult-2'))!
  await addWorktree(settings, source, path, 'ult-2', ['-b', 'ultimate/x-2', base])
  expect(run(path, 'symbolic-ref', '--short', 'HEAD')).toBe('ultimate/x-2')
  await expect(
    removeWorktree({ isolates: { worktree: { remove: 'true' } } }, source, path, 'ult-2'),
  ).rejects.toThrow('isolates.worktree.remove left')
  await removeWorktree(settings, source, path, 'ult-2')
  expect(run(source, 'worktree', 'list', '--porcelain')).not.toContain(path)
  await expect(
    addWorktree({ isolates: { worktree: { add: 'exit 3' } } }, source, join(root, 'n'), 'n', [
      '--detach',
      base,
    ]),
  ).rejects.toThrow('isolates.worktree.add failed')
  await expect(
    addWorktree({ isolates: { worktree: { add: 'true' } } }, source, join(root, 'm'), 'm', [
      '--detach',
      base,
    ]),
  ).rejects.toThrow('isolates.worktree.add left no worktree')
})
