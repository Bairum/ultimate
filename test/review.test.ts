import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePatchFiles } from '@pierre/diffs'
import { beforeAll, describe, expect, it } from 'vitest'
import { git } from '../lib/git.ts'
import { FILE_CAP, reviewDiff } from '../extensions/review/diff.ts'
import { temp } from './helpers.ts'

let repo: string
const sha: Record<string, string> = {}
const options = { target: async () => 'main' }
const diff = (spec: string) => reviewDiff(repo, spec, options)
const commit = async (name: string, message: string) => {
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', message)
  sha[name] = await git(repo, 'rev-parse', 'HEAD')
}

beforeAll(async () => {
  repo = await temp('ultimate-review-')
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')
  const body = Array.from({ length: 30 }, (_, line) => `line ${line}`).join('\n')
  await writeFile(join(repo, 'a.txt'), `${body}\n`)
  await commit('root', 'first')
  await mkdir(join(repo, 'src'))
  await git(repo, 'mv', 'a.txt', 'src/b.txt')
  await writeFile(join(repo, 'src/b.txt'), `${body}\nline 30\n`)
  await writeFile(join(repo, 'big.txt'), `${'x'.repeat(100)}\n`.repeat(5000))
  await commit('rename', 'move a to b and add a big file')
  await git(repo, 'checkout', '-q', '-b', 'feature')
  await writeFile(join(repo, 'feature.txt'), 'new\n')
  await commit('feature', 'add feature')
  await git(repo, 'checkout', '-q', 'main')
  await writeFile(join(repo, 'main.txt'), 'main only\n')
  await commit('main', 'main moves on')
})

describe('review diffs', () => {
  it('shows a root commit against the empty tree', async () => {
    const result = await diff(sha.root)
    expect(result).toMatchObject({ kind: 'commit', title: 'first', head: sha.root })
    expect(result.files).toEqual([{ path: 'a.txt', status: 'added', additions: 30, deletions: 0 }])
    expect(parsePatchFiles(result.patch)[0].files.map((file) => file.name)).toEqual(['a.txt'])
  })

  it('detects a rename and leaves a file over the cap out of the patch', async () => {
    const result = await diff(sha.rename.slice(0, 10))
    expect(result).toMatchObject({ kind: 'commit', base: sha.root, head: sha.rename })
    expect(result.files).toEqual([
      { path: 'big.txt', status: 'added', additions: 5000, deletions: 0, tooLarge: true },
      { path: 'src/b.txt', oldPath: 'a.txt', status: 'renamed', additions: 1, deletions: 0 },
    ])
    expect(result.truncated).toBeUndefined()
    const files = parsePatchFiles(result.patch)[0].files
    expect(files.map((file) => [file.prevName, file.name])).toEqual([['a.txt', 'src/b.txt']])
    expect(result.patch.length).toBeLessThan(FILE_CAP)
  })

  it('shows what a range brought since it forked, and a branch against its target', async () => {
    const range = await diff(`${sha.main}...${sha.feature}`)
    expect(range).toMatchObject({ kind: 'range', base: sha.rename, head: sha.feature })
    expect(range.files.map((file) => file.path)).toEqual(['feature.txt'])
    const branch = await diff('branch:feature')
    expect(branch).toMatchObject({ kind: 'branch', title: 'main...feature', base: sha.rename })
    expect(branch.files.map((file) => file.path)).toEqual(['feature.txt'])
  })

  it('shows uncommitted changes with untracked files, without ignored ones', async () => {
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(repo, 'ignored.txt'), 'secret\n')
    await writeFile(join(repo, 'main.txt'), 'main changed\n')
    await writeFile(join(repo, 'fresh.txt'), 'one\ntwo\n')
    await writeFile(join(repo, 'huge.txt'), 'y'.repeat(FILE_CAP + 10))
    const result = await diff('uncommitted')
    expect(result).toMatchObject({ kind: 'uncommitted', base: sha.main })
    expect(result.head).toBeUndefined()
    expect(result.files).toEqual([
      { path: 'main.txt', status: 'modified', additions: 1, deletions: 1 },
      { path: '.gitignore', status: 'added', additions: 1, deletions: 0 },
      { path: 'fresh.txt', status: 'added', additions: 2, deletions: 0 },
      { path: 'huge.txt', status: 'added', additions: 1, deletions: 0, tooLarge: true },
    ])
    const names = parsePatchFiles(result.patch)[0].files.map((file) => file.name)
    expect(names).toEqual(['main.txt', '.gitignore', 'fresh.txt'])
  })

  it('rejects unknown refs and anything that could be read as an option', async () => {
    await expect(diff('nope')).rejects.toThrow('Not a commit: nope')
    await expect(diff('branch:nope')).rejects.toThrow('Not a commit: nope')
    await expect(diff(`${sha.main}...nope`)).rejects.toThrow('Not a commit: nope')
    for (const spec of [
      '--output=/tmp/x',
      '-p',
      'branch:--all',
      `--all...${sha.main}`,
      `${sha.main}...-x`,
    ])
      await expect(diff(spec)).rejects.toThrow(`Invalid spec: ${spec}`)
    await expect(diff('a...b...c')).rejects.toThrow('Invalid spec')
    await expect(diff('HEAD HEAD')).rejects.toThrow('Invalid spec')
    await expect(diff('')).rejects.toThrow('Expected a spec')
  })
})
