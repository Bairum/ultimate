import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { buildQueue, uiFingerprint } from '../cloud/ui-build.ts'

it('fingerprints web source, enabled facets and enablement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-fingerprint-'))
  try {
    for (const path of ['web', 'shared', 'extensions/demo', 'user'])
      await mkdir(join(root, path), { recursive: true })
    for (const path of [
      'web/main.tsx',
      'shared/protocol.ts',
      'extensions/demo/web.tsx',
      'vite.config.ts',
      'package.json',
      'pnpm-lock.yaml',
      'cloud/build.ts',
      'server/vite-extensions.ts',
    ]) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), 'original')
    }
    const fingerprint = () => uiFingerprint(root, root, join(root, 'user'))
    const original = await fingerprint()
    await writeFile(join(root, 'web/main.tsx'), 'changed')
    const web = await fingerprint()
    expect(web).not.toBe(original)
    await writeFile(join(root, 'extensions/demo/web.tsx'), 'changed')
    const facet = await fingerprint()
    expect(facet).not.toBe(web)
    await mkdir(join(root, 'user/.ultimate'), { recursive: true })
    await writeFile(
      join(root, 'user/.ultimate/settings.json'),
      JSON.stringify({ extensions: { disable: ['demo'] } }),
    )
    expect(await fingerprint()).not.toBe(facet)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('debounces changes and never builds concurrently, including changes during a build', async () => {
  vi.useFakeTimers()
  const releases: (() => void)[] = []
  const run = vi.fn<(fingerprint: string) => Promise<void>>(
    () =>
      new Promise((resolve) => {
        releases.push(resolve)
      }),
  )
  const queue = buildQueue(run, () => {})
  try {
    queue.change('a', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    queue.change('b')
    await vi.advanceTimersByTimeAsync(30_000)
    queue.change('c')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    releases.shift()!()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenLastCalledWith('c')
    expect(run).toHaveBeenCalledTimes(2)
    releases.shift()!()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledTimes(2)
    queue.change('c', true) // A reconnect rechecks missing cloud files even without source changes.
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(3)
    let stopped = false
    const stopping = queue.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    releases.shift()!()
    await stopping
    queue.change('after-close', true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledTimes(3)
  } finally {
    for (const release of releases) release()
    await queue.stop()
    vi.useRealTimers()
  }
})
