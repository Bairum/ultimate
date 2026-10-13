import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

it('ticks working, thinking, and retry timers at their displayed precision without stream updates', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const base = await temp('ultimate-transcript-timer-')
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    await linkDependencies(base)
    await writeFile(
      join(base, 'index.html'),
      '<div id="app"></div><script type="module" src="/main.js"></script>',
    )
    await writeFile(
      join(base, 'main.js'),
      `import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Transcript } from '/@fs/${resolve('web/src/app/transcript.tsx')}'
import { store } from '/@fs/${resolve('web/src/sdk/client.ts')}'
let source
window.EventSource = class extends EventTarget {
  readyState = 1
  constructor() { super(); source = this }
  close() {}
}
store.start()
const root = createRoot(document.querySelector('#app'))
flushSync(() => root.render(createElement(Transcript)))
window.fixture = {
  show: (live, entries = []) => flushSync(() => source.dispatchEvent(new MessageEvent('view', {
    data: JSON.stringify({ conversation: { id: 1 }, entries, docs: { 'pi.live': live } }),
  }))),
}
`,
    )
    server = await createServer({
      configFile: resolve('vite.config.ts'),
      configLoader: 'runner',
      root: base,
      cacheDir: join(base, '.vite'),
      server: { host: '127.0.0.1', port: 0, fs: { allow: [base, resolve('.')] } },
    })
    await server.listen()
    browser = await chromium.launch({ executablePath, headless: true })
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.resolvedUrls!.local[0])
    await page.waitForFunction(() => Reflect.has(window, 'fixture'))
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
    await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'))

    await page.evaluate(() => Reflect.get(window, 'fixture').show({ run: { taskId: 1 } }))
    const timer = page.locator('.tabular-nums')
    await page.clock.runFor(2000)
    expect(await timer.textContent()).toBe('2.0s')
    await page.clock.runFor(100)
    expect(await timer.textContent()).toBe('2.1s')

    await page.evaluate(() =>
      Reflect.get(window, 'fixture').show({
        run: { taskId: 1 },
        generation: {
          message: {
            role: 'assistant',
            timestamp: 0,
            content: [{ type: 'thinking', thinking: '' }],
          },
        },
      }),
    )
    expect(await page.getByText('thinking…', { exact: true }).count()).toBe(1)
    await page.clock.runFor(100)
    expect(await timer.textContent()).toBe('2.2s')

    await page.evaluate(() =>
      Reflect.get(window, 'fixture').show({
        run: { taskId: 1 },
        generation: { retry: { at: Date.now() + 5000, error: 'busy' }, attempt: 2 },
      }),
    )
    expect(await page.getByText('retrying in', { exact: false }).textContent()).toContain('5.0s')
    await page.clock.runFor(100)
    expect(await page.getByText('retrying in', { exact: false }).textContent()).toContain('4.9s')

    await page.evaluate(() => Reflect.get(window, 'fixture').show({}))
    await page.clock.runFor(1000)
    expect(await timer.count()).toBe(0)
    expect(await page.getByText('retrying in', { exact: false }).count()).toBe(0)
    for (const redacted of [false, true]) {
      const reasoning = {
        type: 'thinking',
        thinking: redacted ? '' : 'Considering options.',
        redacted,
      }
      const suffix = redacted ? ' (redacted)' : ''
      await page.evaluate((thinking) => {
        Reflect.get(window, 'fixture').show({
          run: { taskId: 2 },
          generation: { message: { role: 'assistant', timestamp: 0, content: [thinking] } },
        })
      }, reasoning)
      expect(await page.getByText(`Thinking${suffix}…`, { exact: true }).count()).toBe(1)

      for (const following of [
        { type: 'text', text: 'Here is the answer.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
      ]) {
        await page.evaluate(
          ({ thinking, next }) => {
            Reflect.get(window, 'fixture').show({
              run: { taskId: 2 },
              generation: {
                message: { role: 'assistant', timestamp: 0, content: [thinking, next] },
              },
            })
          },
          { thinking: reasoning, next: following },
        )
        expect(await page.getByText(`Thought${suffix}`, { exact: true }).count()).toBe(1)
        expect(await page.getByText(`Thinking${suffix}…`, { exact: true }).count()).toBe(0)
      }

      await page.evaluate((thinking) => {
        Reflect.get(window, 'fixture').show({}, [
          {
            id: 1,
            kind: 'pi.assistant',
            model: [
              { role: 'assistant', timestamp: 0, content: [thinking], stopReason: 'toolUse' },
            ],
          },
        ])
      }, reasoning)
      expect(await page.getByText(`Thought${suffix}`, { exact: true }).count()).toBe(1)
    }
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
  }
})
