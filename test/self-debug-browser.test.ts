import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createEventBus } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import { fauxServer as createServer, skipWithoutChromium, temp, removeTemp } from './helpers.ts'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { Browser } from 'playwright-core'
import browserExtension from '../extensions/browser/server.ts'

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
  if (!(await skipWithoutChromium(test))) return
  const home = await temp('ultimate-browser-test-')
  const server = await createServer({
    ultimateRoot: resolve('.'),
    userHome: home,
    home,
    faux: true,
    port: 0,
  })
  const browserState: { launched?: Promise<Browser> } = {}
  try {
    server.host.registry.install(
      browserExtension({
        ...server.host,
        events: createEventBus(),
        access: { allow: () => () => {} },
        notice: () => {},
        service: () => ({ update: () => {}, dispose: () => {} }),
        resource: <T>(_key: string, _create: () => T) => browserState as T,
        onOpen: () => {},
        onClose: () => {},
        harness: () => server.harness,
        system: () => server.system.current(),
        conversations: () => server.api.conversations(),
        projects: async () => [],
        extensions: () => server.extensions.info(),
        reloadExtensions: async () => {},
        projectSetup: async () => ({ config: false, decision: null }),
        projectSettings: async () => ({}),
        projectExtensions: async () => [],
        setProjectDecision: async () => {},
        doc: () => undefined,
        metadata: Metadata,
      }),
    )
    const result = await run(server, 'screenshot', {
      url: server.url,
      width: 2000,
      height: 1000,
      waitMs: 0,
    })
    expect(result.isError).not.toBe(true)
    expect(
      result.content.some(
        (block) => block.type === 'image' && ['image/png', 'image/jpeg'].includes(block.mimeType),
      ),
    ).toBe(true)
    expect(JSON.stringify(result.content)).toContain(
      '[Image: original 2000x1000, displayed at 1600x800. Multiply coordinates by 1.25 to map to original image.]',
    )
    const files = await readdir(join(home, 'screenshots'))
    expect(files).toHaveLength(1)
    expect((await readFile(join(home, 'screenshots', files[0]))).subarray(1, 4).toString()).toBe(
      'PNG',
    )
    const browser = await browserState.launched!
    await browser.close()
    const recovered = await run(server, 'screenshot', { url: server.url, waitMs: 0 })
    expect(recovered.isError).not.toBe(true)
    expect(recovered.content.some((block) => block.type === 'image')).toBe(true)
    const driven = await run(server, 'browser', {
      steps: [
        { wait: 'button[aria-label="Command palette"]' },
        { click: 'button[aria-label="Command palette"]' },
        { press: 'Escape' },
        { fill: ['textarea', 'browser fill test'] },
        {
          eval: 'console.error("self-debug-console-test"); ({answer:42,origin:location.origin,draft:document.querySelector("textarea").value})',
        },
      ],
    })
    expect(driven.isError).not.toBe(true)
    expect(JSON.stringify(driven.content)).toContain('self-debug-console-test')
    expect(JSON.stringify(driven.content)).toContain('answer')
    expect(JSON.stringify(driven.content)).toContain(server.url)
    expect(JSON.stringify(driven.content)).toContain('browser fill test')
    const nested = await run(server, 'codemode', {
      code: `text('restart:' + ('restart' in tools)); text(typeof tools.browser); const shot = await tools.screenshot({url:${JSON.stringify(server.url)},waitMs:0}); image(shot.image);`,
    })
    if (nested.isError) throw new Error(JSON.stringify(nested.content))
    expect(nested.isError).not.toBe(true)
    expect(nested.content.some((block) => block.type === 'image')).toBe(true)
    expect(JSON.stringify(nested.content)).toContain('function')
    expect(JSON.stringify(nested.content)).toContain('restart:false')
  } finally {
    await (await browserState.launched)?.close()
    await server.vite.watcher.close()
    await server.close()
    await removeTemp(home)
  }
}, 60000)
