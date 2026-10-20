import { expect, it } from 'vitest'
import { fetchOrigin, otherTransport } from '../lib/fast-forward.ts'

it('swaps a GitHub remote to the other transport and leaves others alone', () => {
  expect(otherTransport('git@github.com:o/r.git')).toBe('https://github.com/o/r.git')
  expect(otherTransport('git@github.com:o/r')).toBe('https://github.com/o/r.git')
  expect(otherTransport('ssh://git@github.com/o/r.git')).toBe('https://github.com/o/r.git')
  expect(otherTransport('https://github.com/o/r.git')).toBe('git@github.com:o/r.git')
  expect(otherTransport('https://github.com/o/r/')).toBe('git@github.com:o/r.git')
  expect(otherTransport('https://user@github.com/o/r')).toBe('git@github.com:o/r.git')
  expect(otherTransport('git@gitlab.com:o/r.git')).toBeUndefined()
  expect(otherTransport('/srv/repo.git')).toBeUndefined()
})

/** A git that fails the commands `fail` matches and records every call. */
function stub(answers: Record<string, string>, fail: (args: string[]) => boolean) {
  const calls: string[] = []
  const git = async (...args: string[]) => {
    const call = args.join(' ')
    calls.push(call)
    if (fail(args)) throw new Error(`git ${args[0]} failed: denied ${call}`)
    return answers[call] ?? ''
  }
  return { git, calls }
}

it('fetches origin alone when it works', async () => {
  const { git, calls } = stub({}, () => false)
  await fetchOrigin(git)
  expect(calls).toEqual(['fetch --quiet origin'])
})

it('retries over HTTPS into origin refs and sets a missing origin/HEAD from it', async () => {
  const alt = 'https://github.com/o/r.git'
  const { git, calls } = stub(
    {
      'remote get-url origin': 'git@github.com:o/r.git',
      [`ls-remote --symref ${alt} HEAD`]: 'ref: refs/heads/main\tHEAD\nabc\tHEAD',
    },
    (args) =>
      args.join(' ') === 'fetch --quiet origin' ||
      args.join(' ') === 'symbolic-ref --quiet refs/remotes/origin/HEAD',
  )
  await fetchOrigin(git)
  expect(calls).toEqual([
    'fetch --quiet origin',
    'remote get-url origin',
    `fetch --quiet ${alt} +refs/heads/*:refs/remotes/origin/*`,
    'symbolic-ref --quiet refs/remotes/origin/HEAD',
    `ls-remote --symref ${alt} HEAD`,
    'symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main',
  ])
})

it('keeps an existing origin/HEAD after a fallback', async () => {
  const { git, calls } = stub(
    {
      'remote get-url origin': 'https://github.com/o/r.git',
      'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/main',
    },
    (args) => args.join(' ') === 'fetch --quiet origin',
  )
  await fetchOrigin(git)
  expect(calls.at(-2)).toBe(
    'fetch --quiet git@github.com:o/r.git +refs/heads/*:refs/remotes/origin/*',
  )
  expect(calls).not.toContain('ls-remote --symref git@github.com:o/r.git HEAD')
})

it('names both causes when both transports fail', async () => {
  const { git } = stub(
    { 'remote get-url origin': 'git@github.com:o/r.git' },
    (args) => args[0] === 'fetch',
  )
  await expect(fetchOrigin(git)).rejects.toThrow(
    /denied fetch --quiet origin\nRetry over https:\/\/github\.com\/o\/r\.git: .*denied fetch --quiet https/,
  )
})

it('rethrows the first failure for a remote off GitHub', async () => {
  const { git, calls } = stub(
    { 'remote get-url origin': '/srv/repo.git' },
    (args) => args[0] === 'fetch',
  )
  await expect(fetchOrigin(git)).rejects.toThrow('denied fetch --quiet origin')
  expect(calls).toEqual(['fetch --quiet origin', 'remote get-url origin'])
})
