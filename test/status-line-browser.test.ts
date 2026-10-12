import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

it('renders token totals, shared rates and live global running-agent counts', async (test) => {
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
let output = null
api.action = async () => output === null ? null : { elapsed: 30, rates: { input: output * 2, output, cacheRead: output * 3, cacheWrite: output * 4 } }
store.start()
source.send('open')
source.send('system', { process: { generation: 1, pid: 1 } })
source.send('view', { conversation: { id: 1 }, entries: [], docs: { 'pi.agent': {}, 'pi.usage': { models: { 'faux/model': { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, cost: { total: 0.003 } } }, tools: { fixture: { input: 50, output: 60, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } } } }, 'pi.live': {} } })
const root = createRoot(document.querySelector('#app'))
root.render(h(TooltipProvider, { delayDuration: 0 }, h(extension.slots['statusline.left'][1])))
window.fixture = { sample: value => { output = value }, conversations: value => source.send('conversations', value), unmount: () => { root.unmount(); store.stop() } }
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
    await rate.waitFor()
    expect(await rate.textContent()).toBe('↓? tok/s')
    const running = page.getByLabel('Running agents')
    expect(await running.textContent()).toBe('0 agents')
    await page.evaluate(() =>
      Reflect.get(window, 'fixture').conversations([
        { id: 1, busy: true },
        { id: 2, busy: true },
        { id: 3, parentConversationId: 2, ownerTaskId: 10, busy: true },
        { id: 4, busy: false },
      ]),
    )
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Running agents"]')?.textContent === '3 agents',
    )
    for (const text of ['↑150', '↓260', 'R300', 'W400', '$0.008'])
      expect(await page.locator('#app').textContent()).toContain(text)
    await page.evaluate(() => Reflect.get(window, 'fixture').sample(123))
    await page.clock.runFor(1000)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Output token rate"]')?.textContent === '↓123 tok/s',
    )
    await rate.hover()
    await page.clock.runFor(100)
    const tooltip = page.getByRole('tooltip')
    await tooltip.waitFor()
    for (const text of [
      'Input ↑246.0',
      'Output ↓123.0',
      'Cache read 369.0',
      'Cache write 492.0',
      'across all conversations, averaged over the last 30 seconds',
      'tool usage is excluded',
      'Running agents across all conversations in this project, including subagents',
    ])
      expect(await tooltip.textContent()).toContain(text)
    await page.mouse.move(700, 500)
    await page.evaluate(() => Reflect.get(window, 'fixture').sample(200))
    await page.clock.runFor(1000)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Output token rate"]')?.textContent === '↓200 tok/s',
    )
    await rate.hover()
    await page.clock.runFor(100)
    await tooltip.waitFor()
    expect(await tooltip.textContent()).toContain('Output ↓200.0')
    await page.evaluate(() =>
      Reflect.get(window, 'fixture').conversations([
        { id: 1, busy: false },
        { id: 2, busy: true },
        { id: 3, parentConversationId: 2, ownerTaskId: 10, busy: false },
      ]),
    )
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Running agents"]')?.textContent === '1 agent',
    )
    await page.evaluate(() =>
      Reflect.get(window, 'fixture').conversations([{ id: 2, busy: false }]),
    )
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Running agents"]')?.textContent === '0 agents',
    )
    await page.evaluate(() => Reflect.get(window, 'fixture').unmount())
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
})
