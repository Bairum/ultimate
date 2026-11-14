import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { exec } from '../../../lib/exec.ts'
import { git } from '../../../lib/git.ts'
import { acquireLock } from '../../../server/lock.ts'
import { install, loadable, owed } from '../packages.ts'
import { temp } from '../../../test/helpers.ts'

// No spawns in a fast test: pnpm is a deferred promise per call, and git says "not a checkout" (no index.lock, no lock)
// unless a test points it at a lock.
vi.mock('../../../lib/exec.ts', () => ({ exec: vi.fn<typeof exec>() }))
vi.mock('../../../lib/git.ts', () => ({ git: vi.fn<typeof git>() }))
vi.mock('../../../server/lock.ts', () => ({ acquireLock: vi.fn<typeof acquireLock>() }))

afterEach(() => vi.resetAllMocks())

/** A clone whose lockfile differs from the installed one, and a host that records notices and reloads. */
async function clone() {
  vi.mocked(git).mockRejectedValue(new Error('not a git repository'))
  const root = await temp('ultimate-packages-')
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nnew: 1\n')
  await mkdir(join(root, 'node_modules/.pnpm'), { recursive: true })
  await writeFile(join(root, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\nold: 1\n')
  const resources = new Map<string, unknown>()
  const notices: string[] = []
  const host = {
    ultimateRoot: root,
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    notice: (message: string) => void notices.push(message),
    reloadExtensions: vi.fn<() => Promise<void>>(async () => {}),
  }
  const installs: { resolve: () => void; reject: (error: unknown) => void }[] = []
  vi.mocked(exec).mockImplementation(
    () =>
      new Promise((resolve, reject) =>
        installs.push({
          // pnpm writes the installed lockfile once it is done.
          resolve: () =>
            writeFile(
              join(root, 'node_modules/.pnpm/lock.yaml'),
              'lockfileVersion: 9\nnew: 1\n',
            ).then(() => resolve({ stdout: '', stderr: '' }), reject),
          reject,
        }),
      ),
  )
  return { host, notices, installs }
}

// 2026-11-13, landing 1e338e7 (Pi 1.5.0 → 1.5.2): extensions loaded before the lockfile was installed (#116515).
it('holds loads while an owed install runs; loads waiting meanwhile join it', async () => {
  const { host, notices, installs } = await clone()
  let settled = 0
  const first = loadable(host).then(() => settled++)
  const second = loadable(host).then(() => settled++)
  await vi.waitFor(() => expect(installs).toHaveLength(1))
  expect(settled).toBe(0)
  expect(notices[0]).toMatch(/^Installing packages for lockfile [0-9a-f]{8}/)
  installs[0].resolve()
  await Promise.all([first, second])
  expect(installs).toHaveLength(1)
  expect(notices[1]).toMatch(/^Packages installed for lockfile/)
  expect(await owed(host)).toBe(false)
  // Nothing owed: the next load passes without installing.
  await loadable(host)
  expect(installs).toHaveLength(1)
})

it('keeps failing loads after a failed install until a retry succeeds, then reloads', async () => {
  const { host, notices, installs } = await clone()
  const failing = loadable(host)
  await vi.waitFor(() => expect(installs).toHaveLength(1))
  installs[0].reject(Object.assign(new Error('exit 1'), { stderr: 'ERR_PNPM_FETCH_404' }))
  await expect(failing).rejects.toThrow('ERR_PNPM_FETCH_404')
  expect(notices.at(-1)).toMatch(/pnpm install failed .*held until Retry/)
  // The same lockfile fails at once, without installing again.
  await expect(loadable(host)).rejects.toThrow('ERR_PNPM_FETCH_404')
  expect(installs).toHaveLength(1)
  expect(await owed(host)).toBe(true)
  // Retry installs again; its success clears the failure and reloads what was held.
  const retry = install(host)
  await vi.waitFor(() => expect(installs).toHaveLength(2))
  installs[1].resolve()
  expect(await retry).toEqual({ install: 'done' })
  expect(host.reloadExtensions).toHaveBeenCalledOnce()
  await loadable(host)
  expect(await owed(host)).toBe(false)
})

it('reloads what a lock held by another Ultimate kept back, once that install settles', async () => {
  const { host, installs } = await clone()
  // A clone in git, whose lock another Ultimate holds past the wait; it then installs the lockfile itself.
  vi.mocked(git).mockImplementation(async (_cwd, ...args) => join(host.ultimateRoot, args.at(-1)!))
  vi.mocked(acquireLock).mockRejectedValueOnce(new Error('Ultimate core already owns this lock'))
  await expect(loadable(host)).rejects.toThrow('Another Ultimate is still installing')
  expect(await owed(host)).toBe(true)
  await writeFile(
    join(host.ultimateRoot, 'node_modules/.pnpm/lock.yaml'),
    'lockfileVersion: 9\nnew: 1\n',
  )
  vi.mocked(acquireLock).mockResolvedValue({ close: async () => {} } as never)
  // The next load finds nothing to install and reloads what the hold kept back.
  await loadable(host)
  expect(installs).toHaveLength(0)
  expect(host.reloadExtensions).toHaveBeenCalledOnce()
  expect(await owed(host)).toBe(false)
})
