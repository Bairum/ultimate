import { createBashTool } from '@earendil-works/pi-durable/tools'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import codingTools, { prepareBash } from '../extensions/coding-tools/server.ts'
import { context } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'

afterEach(() => vi.unstubAllEnvs())

it("runs commands without this server's own variables, so a nested `ultimate` opens its own home", () => {
  vi.stubEnv('ULTIMATE_HOME', '/state/of/this/server')
  vi.stubEnv('ULTIMATE_PROJECT', '/this/project')
  vi.stubEnv('ULTIMATE_SUPERVISED', '1')
  // Vite's dev server sets it on this process; it made a project's `vite build` ship a development bundle.
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ULTIMATE_BASH_TIMEOUT', '42')
  const execution = { command: 'ultimate', cwd: '/', env: { EXTRA: 'kept' }, inheritEnv: true }
  prepareBash(execution, { conversationId: 7 } as ToolExecutionApi, '/tmp/commits.log')
  expect(execution.inheritEnv).toBe(false)
  expect(execution.env).not.toHaveProperty('ULTIMATE_HOME')
  expect(execution.env).not.toHaveProperty('ULTIMATE_PROJECT')
  expect(execution.env).not.toHaveProperty('ULTIMATE_SUPERVISED')
  expect(execution.env).not.toHaveProperty('NODE_ENV')
  expect(execution.env).toMatchObject({
    PATH: process.env.PATH,
    ULTIMATE_BASH_TIMEOUT: '42',
    EXTRA: 'kept',
    ULTIMATE_COMMIT_LOG: '/tmp/commits.log',
  })
})

it('uses a 600-second default tripwire and leaves explicit timeouts unchanged', async () => {
  vi.stubEnv('ULTIMATE_BASH_TIMEOUT', undefined)
  const execute = vi
    .fn<ReturnType<typeof createBashTool>['execute']>()
    .mockRejectedValue(new Error('Command timed out after 600 seconds'))
  const wrapper = codingTools({
    emit: vi.fn<ExtensionHost['emit']>() as ExtensionHost['emit'],
  }).wraps!.find((wrap) => 'tool' in wrap && wrap.tool === 'bash')!
  if (!('tool' in wrapper)) throw new Error('Missing bash wrapper')
  const bash = wrapper.wrap({ ...createBashTool(), execute })
  const api = {} as ToolExecutionApi
  await expect(bash.execute({ command: 'sleep' }, api, context)).rejects.toThrow(
    'Tripwire: bash ran past the 600 s default limit',
  )
  expect(execute.mock.calls[0][0]).toEqual({ command: 'sleep', timeout: 600 })
  await expect(bash.execute({ command: 'sleep', timeout: 1200 }, api, context)).rejects.toThrow(
    'Command timed out after 600 seconds',
  )
  expect(execute.mock.calls[1][0]).toEqual({ command: 'sleep', timeout: 1200 })
  vi.stubEnv('ULTIMATE_BASH_TIMEOUT', '42')
  await expect(bash.execute({ command: 'sleep' }, api, context)).rejects.toThrow(
    'the 42 s default limit',
  )
  expect(execute.mock.calls[2][0]).toEqual({ command: 'sleep', timeout: 42 })
})
