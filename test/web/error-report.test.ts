import { expect, it, vi } from 'vitest'
import type { SystemInfo } from '../../shared/protocol.ts'
import { errorReport } from '../../web/src/app/boundary.tsx'

// The real hooks connect to a server; errorReport reads only the system snapshot it is given.
vi.mock('../../web/src/sdk/hooks.ts', async () => ({
  ExtensionNameContext: (await import('react')).createContext<string | undefined>(undefined),
  useExtensions: () => [],
  useSystem: () => undefined,
}))

const system = {
  build: { id: 'b1', generation: 4 },
  machine: { home: '/home/me' },
  code: { ultimateRoot: '/home/me/ultimate' },
  project: { root: '/home/me/my-app' },
  extensions: [{ name: 'shell', source: 'user', path: '/home/me/.ultimate/extensions/shell' }],
} as unknown as SystemInfo

it('reports a failed load with its full message, path, source and build', () => {
  const message = "The requested module '/@fs/x.ts' does not provide an export named 'attention'"
  expect(
    errorReport(system, { extension: 'shell', error: message, context: 'web.tsx did not load' }),
  ).toBe(
    [
      'Extension `shell` failed: web.tsx did not load.',
      'Path: ~/.ultimate/extensions/shell (user)',
      `Error: ${message}`,
      'Build: b1 · gen 4',
    ].join('\n'),
  )
})

it("caps a crash's stack", () => {
  const stack = Array.from({ length: 40 }, (_, line) => `    at frame${line}`).join('\n')
  const report = errorReport(system, {
    extension: 'shell',
    error: 'boom',
    context: 'a component threw',
    stack,
  })
  expect(report).toContain('at frame14\n```')
  expect(report).not.toContain('frame15')
})
