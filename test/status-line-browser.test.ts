import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

it('preserves the shared server rate on navigation/remount, explains it and cleans up stale/error requests', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const base = await temp('ultimate-status-line-browser-')
  await linkDependencies(base)
  await writeFile(
    join(base, 'index.html'),
    '<div id="app"></div><script type="module" src="/main.js"></script>',
  )
  await writeFile(
    join(base, 'main.js'),
    `
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import extension from '/@fs/${resolve('extensions/status-line/web.tsx')}'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api, store } from '/@fs/${resolve('web/src/sdk/client.ts')}'
class Source extends EventTarget {
  readyState = 1
  close() {}
  send(name, data) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) })) }
}
const source = new Source()
window.EventSource = class { constructor() { return source } }
window.fetch = async () => ({ ok: true, json: async () => ({ models: [], providers: [] }) })
const requests = []
api.action = (extension, action, args, options) => new Promise((resolve, reject) => {
  const request = { extension, action, args, ...options, resolve, reject, aborted: false }
  options.signal.addEventListener('abort', () => { request.aborted = true })
  requests.push(request)
})
store.start()
let id = 1
function view(next = id) {
  id = next
  source.send('view', { conversation: { id }, entries: [], docs: { 'pi.agent': {}, 'pi.usage': { models: { 'faux/model': { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, cost: { total: 0.003 } } }, tools: { fixture: { input: 50, output: 60, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } } } }, 'pi.live': {} } })
}
function system(generation) { source.send('system', { process: { generation, pid: 1 } }) }
source.send('open')
system(1)
view()
const root = createRoot(document.querySelector('#app'))
const show = () => root.render(h(TooltipProvider, { delayDuration: 0 }, h(extension.slots['statusline.left'][1])))
show()
window.fixture = {
  requests,
  view,
  system,
  disconnect: () => source.send('error'),
  reconnect: () => source.send('open'),
  finish: (index, output, elapsed) => requests[index].resolve(output === null ? null : { elapsed, rates: { input: output * 2, output, cacheRead: output * 3, cacheWrite: output * 4 } }),
  hide: () => root.render(null),
  show,
  fail: index => requests[index].reject(new Error('offline')),
  unmount: () => { root.unmount(); store.stop() },
}
`,
  )
  const server = await createServer({
    configFile: resolve('vite.config.ts'),
    configLoader: 'runner',
    root: base,
    cacheDir: join(base, '.vite'),
    server: { host: '127.0.0.1', port: 0, fs: { allow: [base, resolve('.')] } },
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    await server.listen()
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.clock.install()
    await page.clock.pauseAt(new Date())
    await page.goto(server.resolvedUrls!.local[0])
    const rate = page.getByLabel('Output token rate')
    const count = () => page.evaluate(() => Reflect.get(window, 'fixture').requests.length)
    const waitCount = (n: number) =>
      page.waitForFunction(
        (expected) => Reflect.get(window, 'fixture').requests.length === expected,
        n,
      )
    const finish = (index: number, output: number | null, elapsed = 30) =>
      page.evaluate(
        ([requestIndex, tokens, seconds]) =>
          Reflect.get(window, 'fixture').finish(requestIndex, tokens, seconds),
        [index, output, elapsed],
      )
    await waitCount(1)
    expect(await rate.textContent()).toBe('↓? tok/s')
    const totals = ['↑150', '↓260', 'R300', 'W400', '$0.008']
    for (const text of totals) expect(await page.locator('#app').textContent()).toContain(text)
    await page.clock.runFor(2000)
    expect(await count()).toBe(1) // Completion-chained, no overlap.
    await finish(0, null)
    await page.clock.runFor(1000)
    await waitCount(2)
    await finish(1, 123, 1)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Output token rate"]')?.textContent === '↓123 tok/s',
    )
    for (const text of totals) expect(await page.locator('#app').textContent()).toContain(text)
    await rate.hover()
    await page.clock.runFor(100)
    const tooltip = page.getByRole('tooltip')
    await tooltip.waitFor()
    const tip = await tooltip.textContent()
    for (const text of [
      'Input ↑246.0',
      'Output ↓123.0',
      'Cache read 369.0',
      'Cache write 492.0',
      'across all conversations, averaged over the last 30 seconds',
      'tool usage is excluded',
    ])
      expect(tip).toContain(text)
    await page.mouse.move(700, 500)
    await page.evaluate(() => Reflect.get(window, 'fixture').view(2))
    expect(await rate.textContent()).toBe('↓123 tok/s')
    expect(await count()).toBe(2)
    await page.clock.runFor(900)
    await waitCount(3)
    expect(await rate.textContent()).toBe('↓123 tok/s')
    await page.evaluate(() => Reflect.get(window, 'fixture').disconnect())
    await page.waitForFunction(() => Reflect.get(window, 'fixture').requests[2].aborted)
    await finish(2, 999999) // An aborted transport that still resolves cannot contaminate the next scope.
    await page.clock.runFor(2000)
    expect(await count()).toBe(3)
    await page.evaluate(() => Reflect.get(window, 'fixture').reconnect())
    await waitCount(4)
    await finish(3, 100)
    await page.clock.runFor(1000)
    await waitCount(5)
    await finish(4, 100)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Output token rate"]')?.textContent === '↓100 tok/s',
    )
    await page.clock.runFor(1000)
    await waitCount(6)
    await page.evaluate(() => Reflect.get(window, 'fixture').fail(5))
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Output token rate"]')?.textContent === '↓? tok/s',
    )
    await page.clock.runFor(1000)
    await waitCount(7)
    await finish(6, 100)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Output token rate"]')?.textContent === '↓100 tok/s',
    )
    await page.clock.runFor(1000)
    await waitCount(8)
    await finish(7, 100)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Output token rate"]')?.textContent === '↓100 tok/s',
    )
    await page.evaluate(() => Reflect.get(window, 'fixture').system(2))
    await waitCount(9)
    expect(await rate.textContent()).toBe('↓? tok/s')
    await finish(8, null)
    await page.clock.runFor(1000)
    await waitCount(10)
    await finish(9, 100)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Output token rate"]')?.textContent === '↓100 tok/s',
    )
    await page.clock.fastForward(7000) // Background-tab / long sampling gap.
    await waitCount(11)
    await finish(10, 200)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Output token rate"]')?.textContent === '↓200 tok/s',
    )
    await page.clock.runFor(1000)
    await waitCount(12)
    await page.clock.runFor(5000)
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').requests[11].aborted)).toBe(
      true,
    )
    await finish(11, 900000) // Timeout results are not accepted even if a transport ignores abort.
    await page.clock.runFor(1000)
    await waitCount(13)
    expect(await rate.textContent()).toBe('↓? tok/s')
    await page.evaluate(() => Reflect.get(window, 'fixture').hide())
    await page.waitForFunction(() => Reflect.get(window, 'fixture').requests[12].aborted)
    await finish(12, 900000)
    await page.clock.runFor(10000)
    expect(await count()).toBe(13)
    await page.evaluate(() => Reflect.get(window, 'fixture').show())
    await waitCount(14)
    await finish(13, 123)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Output token rate"]')?.textContent === '↓123 tok/s',
    )
    await page.clock.runFor(1000)
    await waitCount(15)
    await page.evaluate(() => Reflect.get(window, 'fixture').unmount())
    await page.waitForFunction(() => Reflect.get(window, 'fixture').requests[14].aborted)
    await finish(14, 900000)
    await page.clock.runFor(10000)
    expect(await count()).toBe(15)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
})
