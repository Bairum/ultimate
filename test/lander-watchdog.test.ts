import { withAbortSignal } from '@earendil-works/chord/context'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { runLanderCheck } from '../extensions/workspaces/lander.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function hanging(outputEvery?: number) {
  vi.useFakeTimers()
  return vi
    .spyOn(NodeExecutionEnv.prototype, 'exec')
    .mockImplementation(async (_command, options, ctx) => {
      const timer = outputEvery
        ? setInterval(
            () => options?.onOutput?.('progress\n', ctx, { stream: 'stdout' }),
            outputEvery,
          )
        : undefined
      await new Promise<void>((resolve) =>
        ctx.abortSignal!.addEventListener('abort', () => resolve(), { once: true }),
      )
      clearInterval(timer)
      return { ok: false, error: new Error('aborted') } as Awaited<
        ReturnType<NodeExecutionEnv['exec']>
      >
    })
}

it('stops a silent check at the stall limit', async () => {
  hanging()
  const ran = runLanderCheck('.', 'sleep', context, { stall: 0.1, total: 0.3 })
  await vi.advanceTimersByTimeAsync(100)
  expect((await ran).failure).toContain('Stalled: no output for')
  expect(vi.getTimerCount()).toBe(0)
})

it('resets the stall timer on output but stops continuous output at the total limit', async () => {
  hanging(50)
  const ran = runLanderCheck('.', 'print', context, { stall: 0.1, total: 0.3 })
  await vi.advanceTimersByTimeAsync(300)
  expect((await ran).failure).toMatch(/Timed out after .* min\nprogress/)
  expect(vi.getTimerCount()).toBe(0)
})

it('defaults to a 5-minute stall and a 15-minute total cap', async () => {
  hanging()
  const silent = runLanderCheck('.', 'sleep', context)
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  expect((await silent).failure).toBe('Stalled: no output for 5 min, stopped')
  hanging(60 * 1000)
  const printing = runLanderCheck('.', 'print', context)
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
  expect((await printing).failure).toMatch(/^Timed out after 15 min\nprogress/)
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves task cancellation instead of reporting a watchdog failure', async () => {
  hanging()
  const controller = new AbortController()
  const ran = runLanderCheck('.', 'sleep', withAbortSignal(controller.signal, context))
  controller.abort(new Error('task cancelled'))
  await expect(ran).rejects.toThrow('task cancelled')
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps successful summaries and clears both timers', async () => {
  vi.useFakeTimers()
  vi.spyOn(NodeExecutionEnv.prototype, 'exec').mockImplementation(
    async (_command, options, ctx) => {
      options?.onOutput?.('first\nlast\n', ctx, { stream: 'stdout' })
      return { ok: true, value: { exitCode: 0 } }
    },
  )
  expect(await runLanderCheck('.', 'print', context)).toEqual({ summary: 'last' })
  expect(vi.getTimerCount()).toBe(0)
})
