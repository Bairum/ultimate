import { expect, it } from 'vitest'
import { pixelSettings, settings } from '../extensions/computer-use/runtime.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { temp, removeTemp } from './helpers.ts'

it('clamps pixel settings to their safety bounds', () => {
  expect(
    pixelSettings({ labelRadius: 1e9, minConfidence: -1, settleMs: 1e9, maxWaitSeconds: -1 }),
  ).toMatchObject({ labelRadius: 48, minConfidence: 0.3, settleMs: 10000, maxWaitSeconds: 1 })
  expect(
    pixelSettings({ labelRadius: -1, minConfidence: 10, settleMs: -1, maxWaitSeconds: 1e9 }),
  ).toMatchObject({ labelRadius: 0, minConfidence: 1, settleMs: 0, maxWaitSeconds: 600 })
  expect(pixelSettings({ foregroundForDegraded: 'Takeover' }).foregroundForDegraded).toBe(
    'takeover',
  )
  expect(pixelSettings({ foregroundForDegraded: 'background' }).foregroundForDegraded).toBe(
    'background',
  )
})

it.each([
  null,
  'garbage',
  { labelRadius: '12' },
  { minConfidence: Number.NaN },
  { settleMs: Number.POSITIVE_INFINITY },
  { maxWaitSeconds: null },
  { requireLabel: 'false' },
])('rejects garbage pixel settings: %j', (value) => {
  expect(() => pixelSettings(value)).toThrow(/computerUse\.pixel/)
})

it('validates raw project pixel settings before merging defaults', async () => {
  const home = await temp()
  try {
    const host = {
      userHome: home,
      projectSettings: async () => ({ computerUse: { pixel: 'garbage' } }),
    } as unknown as ExtensionHost
    await expect(settings(host)).rejects.toMatchObject({ status: 'invalid_settings' })
  } finally {
    await removeTemp(home)
  }
})
