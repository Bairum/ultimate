import { mkdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../server/extensions.ts'
import cloud from '../extensions/cloud/server.ts'
import { cloudConfig, leaseSettings } from '../lib/cloud.ts'
import { writeJson } from '../lib/json-file.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import { temp } from './helpers.ts'

afterEach(() => vi.unstubAllEnvs())

async function fixture() {
  const userHome = await temp()
  const projectRoot = await temp()
  const notice = vi.fn<ExtensionHost['notice']>()
  const projectSettings = vi.fn<ExtensionHost['projectSettings']>(async () => ({
    cloud: { url: 'wss://untrusted/sync' },
  }))
  const host = { userHome, projectRoot, faux: undefined, notice, projectSettings }
  const settings = (value: JsonObject) =>
    writeJson(join(userHome, '.ultimate/settings.json'), { cloud: value })
  await settings({ url: 'wss://user/sync', machine: 'user-machine' })
  await writeSecret(userHome, 'ULTIMATE_CLOUD_TOKEN', 'secret-token')
  return { host, settings }
}

it('enables sync with user settings and the secret', async () => {
  const { host } = await fixture()
  expect(await cloudConfig(host, {})).toEqual({
    url: 'wss://user/sync',
    token: 'secret-token',
    machine: 'user-machine',
  })
  expect(host.notice).not.toHaveBeenCalled()
})

it('ignores project cloud settings, even without a user URL', async () => {
  const { host, settings } = await fixture()
  await mkdir(join(host.projectRoot, '.ultimate'))
  await writeFile(
    join(host.projectRoot, '.ultimate/settings.json'),
    JSON.stringify(await host.projectSettings()),
  )
  host.projectSettings.mockClear()
  await settings({})
  expect(await cloudConfig(host, {})).toBeUndefined()
  expect(host.projectSettings).not.toHaveBeenCalled()
  expect(host.notice).not.toHaveBeenCalled()
})

it('keeps faux silent without an explicit environment URL', async () => {
  const { host } = await fixture()
  expect(
    await cloudConfig({ ...host, faux: {} as NonNullable<ExtensionHost['faux']> }, {}),
  ).toBeUndefined()
  expect(host.notice).not.toHaveBeenCalled()
})

it('keeps previews silent without an explicit environment URL', async () => {
  const { host } = await fixture()
  expect(await cloudConfig(host, { ULTIMATE_INSTANCE_OWNER: '123' })).toBeUndefined()
  expect(host.notice).not.toHaveBeenCalled()
})

it('prefers environment overrides, including on faux previews', async () => {
  const { host } = await fixture()
  expect(
    await cloudConfig(
      { ...host, faux: {} as NonNullable<ExtensionHost['faux']> },
      {
        ULTIMATE_INSTANCE_OWNER: '123',
        ULTIMATE_CLOUD_URL: 'ws://override/sync',
        ULTIMATE_CLOUD_TOKEN: 'env-token',
        ULTIMATE_CLOUD_MACHINE: 'env-machine',
      },
    ),
  ).toEqual({ url: 'ws://override/sync', token: 'env-token', machine: 'env-machine' })
})

it('defaults the machine name to the OS hostname', async () => {
  const { host, settings } = await fixture()
  await settings({ url: 'wss://user/sync' })
  expect((await cloudConfig(host, {}))?.machine).toBe(hostname())
})

it('reads the lease timing from user settings, with defaults for missing or invalid values', async () => {
  const { host, settings } = await fixture()
  expect(await leaseSettings(host)).toEqual({ idleRelease: 10, autoClaim: true })
  await settings({ idleRelease: 0, autoClaim: false })
  expect(await leaseSettings(host)).toEqual({ idleRelease: 0, autoClaim: false })
  await settings({ idleRelease: -1, autoClaim: 'no' })
  expect(await leaseSettings(host)).toEqual({ idleRelease: 10, autoClaim: true })
})

it('reports a missing token once at host open and never opens a connection', async () => {
  const userHome = await temp()
  await writeJson(join(userHome, '.ultimate/settings.json'), { cloud: { url: 'wss://user/sync' } })
  for (const key of [
    'ULTIMATE_CLOUD_URL',
    'ULTIMATE_CLOUD_TOKEN',
    'ULTIMATE_CLOUD_MACHINE',
    'ULTIMATE_INSTANCE_OWNER',
  ])
    vi.stubEnv(key, undefined)
  const notice = vi.fn<ExtensionHost['notice']>()
  let open: (() => Promise<void>) | undefined
  let close: (() => Promise<void>) | undefined
  vi.useFakeTimers()
  try {
    await cloud({
      userHome,
      faux: false,
      notice,
      onOpen: (callback: () => Promise<void>) => {
        open = callback
      },
      onClose: (callback: () => Promise<void>) => {
        close = callback
      },
      onRelease: () => {},
      resource: <T>(_key: string, create: () => T) => create(),
    } as unknown as ExtensionHost)
    await open!()
    expect(notice.mock.calls).toEqual([
      ['Missing ULTIMATE_CLOUD_TOKEN. Add it in the Secrets panel (⌘K → Secrets).'],
    ])
    expect(vi.getTimerCount()).toBe(0)
    await close!()
  } finally {
    vi.useRealTimers()
  }
})
