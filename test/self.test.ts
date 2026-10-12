import { afterEach, expect, it, vi } from 'vitest'
import self from '../extensions/self/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context } from '../server/harness.ts'

afterEach(() => vi.unstubAllEnvs())
function fixture(cwd?: string, agentCwd?: string) {
  const restart = vi.fn<ExtensionHost['restart']>(async () => 'Preparation failed')
  const host = {
    projectRoot: '/host/project',
    ultimateRoot: '/host/ultimate',
    resource: (_key: string, create: () => unknown) => create(),
    harness: () => ({ snapshot: async () => undefined }),
    restart,
    build: () => ({ id: 'new-build' }),
    system: () => ({ process: { activationError: 'Activation failed' } }),
  } as unknown as ExtensionHost
  const tool = self(host).tools![0]
  const memo = vi.fn<(key: string, ...args: unknown[]) => Promise<unknown>>(async () => undefined)
  const api = {
    conversationId: 1,
    taskId: 'task-1',
    env: cwd ? { cwd } : undefined,
    agent: async () => ({ cwd: agentCwd }),
    memo,
  }
  return { tool, restart, memo, run: () => tool.execute({}, api as never, context) }
}
it.each(['/host/project', '/host/project/src', undefined])(
  'keeps shared restart and approval memo behavior (%s)',
  async (cwd) => {
    vi.stubEnv('ULTIMATE_GENERATION', '1')
    const f = fixture(cwd)
    f.restart.mockImplementation(async (approved) => {
      await approved(2)
      return 'Preparation failed'
    })
    expect(f.tool.replay).toBe('safe')
    const result = await f.run()
    expect(f.restart).toHaveBeenCalledOnce()
    expect(f.memo).toHaveBeenCalledWith('restart:task-1', context)
    expect(f.memo).toHaveBeenCalledWith(
      'restart:task-1',
      { generation: 2, fromGeneration: 1, build: 'new-build' },
      context,
    )
    expect(result).toMatchObject({
      isError: true,
      details: { fromGeneration: 1, toGeneration: 1, error: 'Preparation failed' },
    })
  },
)
it('replays an approved restart without a second restart', async () => {
  vi.stubEnv('ULTIMATE_GENERATION', '2')
  const f = fixture()
  f.memo.mockResolvedValue({ generation: 2, fromGeneration: 1, build: 'old-build' })
  const result = await f.run()
  expect(result.isError).not.toBe(true)
  expect(result.details).toEqual({
    fromGeneration: 1,
    toGeneration: 2,
    fromBuild: 'old-build',
    toBuild: 'new-build',
  })
  expect(JSON.stringify(result.content)).toContain('Restarted. Now running generation 2')
  expect(f.restart).not.toHaveBeenCalled()
})
it('reports rollback when the memoed generation did not activate', async () => {
  vi.stubEnv('ULTIMATE_GENERATION', '1')
  const f = fixture()
  f.memo.mockResolvedValue({ generation: 2, fromGeneration: 1, build: 'old-build' })
  expect(await f.run()).toMatchObject({
    isError: true,
    details: { rolledBack: true, toGeneration: 1, error: 'Activation failed' },
  })
  expect(f.restart).not.toHaveBeenCalled()
})
