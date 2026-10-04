import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

it('renders installed overlays while a facet loads; hooks observe readiness and the latest handler', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const base = await temp('ultimate-events-')
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
      `
import { createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '/@fs/${resolve('web/src/app/App.tsx')}'
import { registry } from '/@fs/${resolve('web/src/sdk/client.ts')}'
import { events, useEvent, useReady } from '@/sdk'
const messages = []
let changeLabel
function Receiver() {
  const [label, setLabel] = useState('first')
  const [value, setValue] = useState('waiting')
  changeLabel = setLabel
  useEvent('fixture:message', data => { messages.push(label); setValue(label + ':' + data) })
  return h('output', { id: 'received' }, value)
}
function Sender() {
  return h('button', { id: 'send', onClick: () => events.emit('fixture:message', 'payload') }, 'Send')
}
function Readiness() {
  const { ready } = useReady()
  return h('output', { id: 'ready' }, String(ready))
}
let finish
const slow = new Promise(resolve => { finish = resolve })
const settled = registry.setLoaders({
  '/extensions/receiver/web.tsx': async () => ({ default: { slots: { overlay: Receiver } } }),
  '/extensions/sender/web.tsx': async () => ({ default: { slots: { overlay: Sender } } }),
  '/extensions/slow/web.tsx': () => slow,
})
const root = createRoot(document.querySelector('#app'))
root.render(h(App))
window.fixture = {
  messages,
  changeLabel: label => changeLabel(label),
  pending: () => registry.getSnapshot().find(record => record.name === 'slow').loading,
  finish: async () => { finish({ default: {} }); await settled; registry.receiveSystem() },
  mountLate: () => root.render(h('div', null, h(App), h(Readiness))),
  unmount: () => root.unmount(),
  emit: () => events.emit('fixture:message', 'after-unmount'),
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
    await page.locator('#send').waitFor()
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').pending())).toBe(true)
    await page.locator('#send').click()
    await page.waitForFunction(
      () => document.querySelector('#received')?.textContent === 'first:payload',
    )
    await page.evaluate(() => Reflect.get(window, 'fixture').changeLabel('latest'))
    await page.locator('#send').click()
    await page.waitForFunction(
      () => document.querySelector('#received')?.textContent === 'latest:payload',
    )
    await page.evaluate(() => Reflect.get(window, 'fixture').finish())
    await page.evaluate(() => Reflect.get(window, 'fixture').mountLate())
    await page.waitForFunction(() => document.querySelector('#ready')?.textContent === 'true')
    const messages = await page.evaluate(() => {
      const fixture = Reflect.get(window, 'fixture')
      fixture.unmount()
      fixture.emit()
      return fixture.messages
    })
    expect(messages).toEqual(['first', 'latest'])
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
  }
})
