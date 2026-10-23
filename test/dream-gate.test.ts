import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Tx } from '@earendil-works/pi-durable'
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { memoryBrief } from '../extensions/lineage/memory.ts'
import { readJson } from '../lib/json-file.ts'
import { BRIEF_BUDGET, gate } from '../extensions/dream/gate.ts'
import type { Seed } from '../extensions/dream/types.ts'
import type { InstanceService } from '../extensions/instance/api.ts'
import { gateSeed, inspection } from './dream-fixture.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function instance() {
  let home = ''
  const seed = gateSeed()
  const api = {
    start: vi.fn<InstanceService['start']>(async (options) => {
      home = options.home
      expect(await readJson(join(home, 'pending-chapter.json'), null)).toEqual({
        to: 'fresh-roots',
      })
      expect(
        await readJson<Seed | null>(join(home, 'chapters/fresh-roots/seed.json'), null),
      ).toEqual({ ...seed, gate: true })
      return { id: 'gate', url: 'http://127.0.0.1:12345' }
    }),
    stop: vi.fn<InstanceService['stop']>(async () => {}),
  }
  return { api, seed, home: () => home }
}

it('boots the switch-shaped scratch home, checks every invariant through HTTP, then stops and removes it', async () => {
  const f = instance()
  inspection(() => f.seed)
  const result = await gate(f.seed, 'fresh-roots', f.api)
  expect(result.ok).toBe(true)
  expect(result.checks.map((item) => item.name)).toEqual([
    'boot',
    'memories',
    'todos',
    'automations',
    'chapter entry',
    'memory brief',
  ])
  expect(f.api.stop).toHaveBeenCalledWith('gate')
  expect(existsSync(f.home())).toBe(false)
})

it.each([
  ['memories', { 'lineage.memory': { memories: {} } }],
  ['todos', { todos: { items: [{}, {}] } }],
  ['automations', { 'dream.seed': { automations: [] } }],
  [
    'memory brief',
    {
      'lineage.memory': {
        memories: { lesson: { ...gateSeed().memories.lesson, line: 'x'.repeat(BRIEF_BUDGET * 8) } },
      },
    },
  ],
])('fails the %s mismatch and still cleans up', async (name, overrides) => {
  const f = instance()
  inspection(
    () => f.seed,
    () => overrides,
  )
  const result = await gate(f.seed, 'fresh-roots', f.api)
  expect(result.ok).toBe(false)
  expect(result.checks.filter((item) => !item.ok).map((item) => item.name)).toEqual([name])
  expect(f.api.stop).toHaveBeenCalledOnce()
  expect(existsSync(f.home())).toBe(false)
})

it('fails a missing chapter entry after the passive effects deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = instance()
  inspection(
    () => f.seed,
    () => ({ entries: [] }),
    // The search returns at the deadline; no real timer (node:timers/promises) needs to elapse.
    () => vi.setSystemTime(Date.now() + 10_000),
  )
  const result = await gate(f.seed, 'fresh-roots', f.api)
  expect(result.checks.find((item) => item.name === 'chapter entry')?.ok).toBe(false)
  expect(f.api.stop).toHaveBeenCalledOnce()
  expect(existsSync(f.home())).toBe(false)
})

it('measures the same fresh-root brief as lineage even before the root becomes a tally', async () => {
  const f = instance()
  inspection(() => f.seed)
  const tx = {
    doc: async () => ({ memories: f.seed.memories }),
    scanEntries: async () => ({ items: [] }),
  } as unknown as Tx
  const brief = await memoryBrief(tx, 1 as never)
  const result = await gate(f.seed, 'fresh-roots', f.api)
  expect(result.checks.find((item) => item.name === 'memory brief')).toEqual({
    name: 'memory brief',
    ok: true,
    detail: `${estimateTextTokens(brief!.text)} tokens; budget ${BRIEF_BUDGET}`,
  })
})

it('accepts an empty memory without a brief', async () => {
  const f = instance()
  f.seed.memories = {}
  f.seed.counts.memories = 0
  inspection(() => f.seed)
  const result = await gate(f.seed, 'fresh-roots', f.api)
  expect(result.ok).toBe(true)
  expect(result.checks.find((item) => item.name === 'memory brief')?.detail).toBe(
    `0 tokens; budget ${BRIEF_BUDGET}`,
  )
})

it('records startup and HTTP failures, always removing the scratch home', async () => {
  const f = instance()
  const start = f.api.start.getMockImplementation()!
  f.api.start.mockImplementation(async (options) => {
    await start(options)
    throw new Error('Boot failed')
  })
  expect((await gate(f.seed, 'fresh-roots', f.api)).checks).toEqual([
    { name: 'boot', ok: false, detail: 'Error: Boot failed' },
  ])
  expect(f.api.stop).not.toHaveBeenCalled()
  expect(existsSync(f.home())).toBe(false)
  f.api.start.mockImplementation(start)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"error":"broken"}', { status: 500 })),
  )
  expect((await gate(f.seed, 'fresh-roots', f.api)).checks.at(-1)).toMatchObject({
    name: 'inspection',
    ok: false,
  })
  expect(f.api.stop).toHaveBeenCalledOnce()
  expect(existsSync(f.home())).toBe(false)
})

it('removes the home even when stopping fails and refuses the gate', async () => {
  const f = instance()
  inspection(() => f.seed)
  f.api.stop.mockRejectedValue(new Error('Cannot stop'))
  const result = await gate(f.seed, 'fresh-roots', f.api)
  expect(result.ok).toBe(false)
  expect(result.checks.at(-1)).toMatchObject({ name: 'stop', ok: false })
  expect(existsSync(f.home())).toBe(false)
})
