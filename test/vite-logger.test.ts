import { afterEach, expect, it, vi } from 'vitest'
import { viteLogger } from '../server/vite-logger.ts'
import { reportCore } from '../server/supervisor-protocol.ts'

vi.mock('../server/supervisor-protocol.ts', () => ({ reportCore: vi.fn<typeof reportCore>() }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('routes routine Vite output and warning/error diagnostics as structured IPC, without console scrollback', () => {
  vi.stubEnv('ULTIMATE_SUPERVISED', '1')
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const logger = viteLogger()
  logger.info('hmr update /web/test.tsx')
  logger.warnOnce('warning marker')
  logger.warnOnce('warning marker')
  logger.error('error marker')
  expect(reportCore).toHaveBeenCalledTimes(3)
  expect(reportCore).toHaveBeenNthCalledWith(1, {
    type: 'log',
    level: 'info',
    source: 'web',
    text: 'hmr update /web/test.tsx',
  })
  expect(reportCore).toHaveBeenNthCalledWith(2, {
    type: 'log',
    level: 'warn',
    source: 'web',
    text: 'warning marker',
  })
  expect(reportCore).toHaveBeenNthCalledWith(3, {
    type: 'log',
    level: 'error',
    source: 'web',
    text: 'error marker',
  })
  expect(logger.hasWarned).toBe(true)
  expect(output).not.toHaveBeenCalled()
  expect(warning).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
})
