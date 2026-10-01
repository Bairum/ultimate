import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import { createServer } from '../server/main.ts'
import { context } from '../server/harness.ts'
import { browserBinary } from '../extensions/browser/server.ts'

async function run(
  server: Awaited<ReturnType<typeof createServer>>,
  name: string,
  args: JsonObject,
) {
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: 'Verify self-debugging' }, context)
  await server.harness.waitForIdle(context)
  const state = await server.root.viewState(context)
  try {
    const entry = state.value.entries.findLast((item) => item.kind === 'pi.tool-result')!
    const result = entry.model![0]
    if (result.role !== 'toolResult') throw new Error('Expected tool result')
    return result
  } finally {
    state.dispose()
  }
}

it('stores screenshot images and PNGs, drives the UI, and forwards nested images through codemode', async (test) => {
  try {
    await browserBinary()
  } catch (error) {
    console.warn(`Skipping browser integration: ${String(error)}`)
    test.skip()
    return
  }
  const home = await mkdtemp(join(tmpdir(), 'ultimate-browser-test-'))
  const server = await createServer({ repoRoot: resolve('.'), home, faux: true, port: 0 })
  try {
    const result = await run(server, 'screenshot', { url: server.url, waitMs: 500 })
    expect(result.isError).not.toBe(true)
    expect(
      result.content.some((block) => block.type === 'image' && block.mimeType === 'image/jpeg'),
    ).toBe(true)
    const files = await readdir(join(home, 'screenshots'))
    expect(files).toHaveLength(1)
    expect((await readFile(join(home, 'screenshots', files[0]))).subarray(1, 4).toString()).toBe(
      'PNG',
    )
    const driven = await run(server, 'browser', {
      url: server.url,
      steps: [
        { wait: 'button[aria-label="Command palette"]' },
        { click: 'button[aria-label="Command palette"]' },
        { eval: 'console.error("self-debug-console-test"); ({answer:42})' },
      ],
    })
    expect(driven.isError).not.toBe(true)
    expect(JSON.stringify(driven.content)).toContain('self-debug-console-test')
    expect(JSON.stringify(driven.content)).toContain('answer')
    const nested = await run(server, 'codemode', {
      code: `text(typeof tools.browser); const shot = await tools.screenshot({url:${JSON.stringify(server.url)},waitMs:0}); image(shot.image);`,
    })
    expect(nested.isError).not.toBe(true)
    expect(nested.content.some((block) => block.type === 'image')).toBe(true)
    expect(JSON.stringify(nested.content)).toContain('function')
  } finally {
    await server.vite.watcher.close()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
}, 60000)

it('starts an isolated standalone instance, reads logs and stops it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-instance-test-'))
  const childHome = join(home, 'child')
  const server = await createServer({ repoRoot: resolve('.'), home, faux: true, port: 0 })
  try {
    const started = await run(server, 'instance', { action: 'start', faux: true, home: childHome })
    expect(started.isError).not.toBe(true)
    const block = started.content.find((item) => item.type === 'text')!
    if (block.type !== 'text') throw new Error('Expected text')
    const instance = JSON.parse(block.text) as {
      id: string
      url: string
      home: string
      pid: number
    }
    expect(instance.home).toBe(childHome)
    expect(instance.pid).toBeGreaterThan(0)
    expect((await fetch(instance.url + '/api/models')).ok).toBe(true)
    const logs = await run(server, 'instance', { action: 'logs', id: instance.id })
    expect(logs.isError).not.toBe(true)
    expect(JSON.stringify(logs.content)).toContain(instance.url)
    expect((await run(server, 'instance', { action: 'stop', id: instance.id })).isError).not.toBe(
      true,
    )
    await expect(fetch(instance.url + '/api/models')).rejects.toThrow('fetch failed')
  } finally {
    await server.vite.watcher.close()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
}, 90000)
