import { expect, it } from 'vitest'
import { versionArgs, type Git } from '../cloud/version.ts'

const repo =
  (outputs: Record<string, string>, failing?: string): Git =>
  (...args) =>
    args[0] === failing
      ? { status: 128, stdout: '' }
      : { status: 0, stdout: `${outputs[args[0]] ?? ''}\n` }

it('tags the deploy with the short sha and subject, marking uncommitted cloud/ changes', () => {
  const clean = { 'rev-parse': 'abc1234', status: '', log: 'fix(cloud): retry' }
  expect(versionArgs(repo(clean))).toEqual(['--tag', 'abc1234', '--message', 'fix(cloud): retry'])
  expect(versionArgs(repo({ ...clean, status: ' M cloud/worker.ts' }))[1]).toBe('abc1234-dirty')
})

it('refuses to deploy untagged when git fails or names no commit', () => {
  const outputs = { 'rev-parse': 'abc1234', status: '', log: 'subject' }
  for (const failing of ['rev-parse', 'status', 'log'])
    expect(() => versionArgs(repo(outputs, failing))).toThrow(`git ${failing}`)
  expect(() => versionArgs(repo({ ...outputs, 'rev-parse': '' }))).toThrow('no commit')
  // A missing git binary: spawnSync reports no status and no output.
  expect(() => versionArgs(() => ({ status: null, stdout: null }))).toThrow('failed')
})
