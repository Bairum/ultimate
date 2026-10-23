import { expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../server/extensions.ts'
import { cloudConfig } from '../lib/cloud.ts'
import { projectIdentity } from '../lib/project-identity.ts'
import { backUp } from '../extensions/cloud/backup.ts'
import { CloudApi } from '../extensions/cloud/api.ts'
import cloud from '../extensions/cloud/server.ts'
import { apis } from './helpers.ts'

vi.mock('../lib/cloud.ts', async (original) => ({
  ...(await original<typeof import('../lib/cloud.ts')>()),
  cloudConfig: vi.fn<typeof cloudConfig>(),
}))
vi.mock('../lib/project-identity.ts', async (original) => ({
  ...(await original<typeof import('../lib/project-identity.ts')>()),
  projectIdentity: vi.fn<typeof projectIdentity>(),
}))
vi.mock('../extensions/cloud/backup.ts', async (original) => ({
  ...(await original<typeof import('../extensions/cloud/backup.ts')>()),
  backUp: vi.fn<typeof backUp>(),
}))

it('publishes optional status and non-forced backup services for the active chapter', async () => {
  const resources = new Map<string, unknown>()
  const services = apis()
  const host = {
    ...services,
    projectRoot: '/project',
    chapter: { name: 'fresh-roots', number: 2, dir: '/home/chapters/fresh-roots' },
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    harness: () => ({ commit: async (run: (tx: unknown) => unknown) => run({}) }),
    emit: () => {},
    notice: () => {},
  } as unknown as ExtensionHost
  cloud(host)
  const service = host.want(CloudApi)!
  vi.mocked(cloudConfig).mockResolvedValue(undefined)
  expect(await service.status()).toBe('off')
  vi.mocked(cloudConfig).mockResolvedValue({
    url: 'https://cloud',
    token: 'token',
    machine: 'here',
  })
  vi.mocked(projectIdentity).mockResolvedValue(undefined)
  expect(await service.status()).toBe('local')
  vi.mocked(projectIdentity).mockResolvedValue({
    key: 'github.com/user/project',
    rootCommit: 'hash',
  })
  expect(await service.status()).toBe('on')
  const done = { id: 'final', at: 1, machine: 'here', bytes: 12, uploaded: 10 }
  vi.mocked(backUp).mockResolvedValue(done)
  vi.stubEnv('ULTIMATE_CLOUD_SNAPSHOT_KEY', 'test-only')
  try {
    expect(await service.backup()).toEqual(done)
    expect(backUp).toHaveBeenCalledWith(
      expect.objectContaining({
        force: false,
        key: 'github.com/user/project@fresh-roots',
        dir: '/home/chapters/fresh-roots',
        projectRoot: '/project',
      }),
    )
  } finally {
    vi.unstubAllEnvs()
  }
})
