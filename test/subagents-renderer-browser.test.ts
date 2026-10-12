import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

it('renders yielded waits separately from answers and follows the live child busy state', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const base = await temp('ultimate-subagents-renderer-')
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
import extension from '/@fs/${resolve('extensions/subagents/web.tsx')}'
import { store } from '/@fs/${resolve('web/src/sdk/client.ts')}'
import '/@fs/${resolve('web/src/index.css')}'
let source
window.EventSource = class extends EventTarget {
  readyState = 1
  constructor(url) { super(); if (!url.includes('ultimate.workspaces')) source = this }
  close() {}
}
store.start()
const root = createRoot(document.querySelector('#app'))
window.fixture = {
  busy: busy => flushSync(() => source.dispatchEvent(new MessageEvent('conversations', {
    data: JSON.stringify([{ id: 2, label: 'worker', parentConversationId: 1, busy }]),
  }))),
  show: (action, background, yielded, status = 'done') => flushSync(() => root.render(
    createElement(extension.tools.subagent, { key: action + background + yielded + status, call: {
      id: 'call', name: 'subagent', args: { action, id: 2, agent: 'worker', task: 'Inspect the task' },
      details: { conversationId: 2, background, yielded }, status,
      output: yielded ? 'Wait yielded to steering; child is still running.' : 'Child result.',
      images: [], diagnostics: [],
    } }),
  )),
}
window.fixture.busy(true)
window.fixture.show('wait', undefined, true)
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
    const header = page.getByRole('button', { name: /subagent/ })
    const working = page.getByText('working', { exact: true })
    const yielded = page.getByText('wait yielded', { exact: true })

    // Both a foreground start's implicit wait and an explicit wait can yield.
    for (const action of ['start', 'wait']) {
      await page.evaluate((childAction) => {
        const fixture = Reflect.get(window, 'fixture')
        fixture.busy(true)
        fixture.show(childAction, undefined, true)
      }, action)
      expect(await header.getAttribute('data-state')).toBe('closed')
      expect(await header.getByLabel('done').count()).toBe(1)
      expect(await yielded.count()).toBe(1)
      expect(await working.count()).toBe(1)
      expect(await page.getByText('bg', { exact: true }).count()).toBe(0)
      await header.click()
      expect(await page.getByText('Wait status', { exact: true }).count()).toBe(1)
      expect(await page.getByText('Answer', { exact: true }).count()).toBe(0)
      expect(
        await page.getByText('Wait yielded to steering; child is still running.').count(),
      ).toBe(1)

      // A conversation update alone removes the live indicator; the historical yield stays.
      await page.evaluate(() => Reflect.get(window, 'fixture').busy(false))
      expect(await working.count()).toBe(0)
      expect(await yielded.count()).toBe(1)
      expect(await page.getByText('Wait status', { exact: true }).count()).toBe(1)
    }

    // Ordinary completed waits still have an Answer, including waits on background children.
    await page.evaluate(() => Reflect.get(window, 'fixture').show('wait', true, false))
    await header.click()
    expect(await page.getByText('Answer', { exact: true }).count()).toBe(1)
    expect(await yielded.count()).toBe(0)
    expect(await page.getByText('Wait status', { exact: true }).count()).toBe(0)

    // Background starts retain their existing Result label and live working indicator.
    await page.evaluate(() => {
      const fixture = Reflect.get(window, 'fixture')
      fixture.busy(true)
      fixture.show('start', true, false)
    })
    await header.click()
    expect(await page.getByText('Result', { exact: true }).count()).toBe(1)
    expect(await working.count()).toBe(1)
    await page.evaluate(() => Reflect.get(window, 'fixture').busy(false))
    expect(await working.count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
  }
})
