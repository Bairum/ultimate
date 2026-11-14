import { expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import workspaceExtension from '../server.ts'

// 2026-11-13, landing 1e338e7 (#116515): the only gate lived in `update`, which this machine had disabled, so no reload
// waited for the install. The core-tier workspaces registers it, so turning `update` off cannot turn the gate off.
it('registers the install gate and the install after landing itself', () => {
  const resources = new Map<string, unknown>()
  const registered = {
    onBeforeLoad: vi.fn<ExtensionHost['onBeforeLoad']>(),
    react: vi.fn<ExtensionHost['react']>(),
  }
  const host = new Proxy<Record<string, unknown>>(
    {
      ...registered,
      resource: (key: string, create: () => unknown) => {
        if (!resources.has(key)) resources.set(key, create())
        return resources.get(key)
      },
    },
    // Every other capability is unused while the extension installs.
    { get: (target, key) => (key in target ? target[key as string] : () => ({})) },
  ) as unknown as ExtensionHost
  workspaceExtension(host)
  expect(registered.onBeforeLoad).toHaveBeenCalledOnce()
  expect(registered.react).toHaveBeenCalledWith(
    'install-landed',
    expect.anything(),
    expect.any(Function),
    { from: 'now' },
  )
})
