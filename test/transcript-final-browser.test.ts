import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

it('highlights only completed text answers, retaining parent and child answers across turns and navigation', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const base = await temp('ultimate-transcript-final-')
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
  show: (id, entries, live = {}) => {
    localStorage.setItem('fixture.view', JSON.stringify({ id, entries, live }))
    flushSync(() => {
      store.show(id)
      source.dispatchEvent(new MessageEvent('view', {
        data: JSON.stringify({ conversation: { id, parent: id === 2 ? 1 : undefined }, entries, docs: { 'pi.live': live } }),
      }))
    })
  },
}
const saved = JSON.parse(localStorage.getItem('fixture.view') || 'null')
if (saved) window.fixture.show(saved.id, saved.entries, saved.live)
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
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Completed parent answer.' }],
      stopReason: 'stop',
      usage,
    }
    const entry = { id: 1, kind: 'pi.assistant', model: [message] }
    const label = page.getByText('Final answer', { exact: true })
    const highlighted = page.locator('[data-from="assistant"][class*="border-success"]')
    await page.evaluate((item) => Reflect.get(window, 'fixture').show(1, [item]), entry)
    expect(await label.count()).toBe(1)
    expect(await highlighted.count()).toBe(1)
    expect(await highlighted.locator('svg.lucide-check').count()).toBe(1)
    expect(await highlighted.getAttribute('class')).toContain('bg-success/5')

    for (const stopReason of ['toolUse', 'error', 'aborted', 'length', 'deferred']) {
      await page.evaluate((item) => Reflect.get(window, 'fixture').show(1, [item]), {
        ...entry,
        model: [{ ...message, stopReason }],
      })
      expect(await label.count()).toBe(0)
      expect(await highlighted.count()).toBe(0)
    }
    for (const content of [
      [],
      [{ type: 'text', text: '' }],
      [{ type: 'text', text: ' \n ' }],
      [{ type: 'thinking', thinking: 'Still thinking.' }],
      [...message.content, { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }],
    ]) {
      await page.evaluate((item) => Reflect.get(window, 'fixture').show(1, [item]), {
        ...entry,
        model: [{ ...message, content }],
      })
      expect(await label.count()).toBe(0)
      expect(await highlighted.count()).toBe(0)
    }
    await page.evaluate(
      (partial) =>
        Reflect.get(window, 'fixture').show(1, [], {
          run: { taskId: 1 },
          generation: { message: partial },
        }),
      message,
    )
    expect(await page.getByText('Completed parent answer.', { exact: true }).count()).toBe(1)
    expect(await label.count()).toBe(0)
    expect(await highlighted.count()).toBe(0)

    const followup = {
      id: 3,
      kind: 'pi.user',
      model: [{ role: 'user', content: 'Follow-up question.' }],
    }
    const parent = [entry, followup]
    await page.evaluate(
      ({ entries, message: partial }) =>
        Reflect.get(window, 'fixture').show(1, entries, {
          run: { taskId: 2 },
          generation: {
            message: { ...partial, content: [{ type: 'text', text: 'New reply streaming.' }] },
          },
        }),
      { entries: parent, message },
    )
    expect(await label.count()).toBe(1)
    expect(await highlighted.textContent()).toContain('Completed parent answer.')
    const later = {
      ...entry,
      id: 4,
      model: [{ ...message, content: [{ type: 'text', text: 'Later final answer.' }] }],
    }
    await page.evaluate(
      (entries) => Reflect.get(window, 'fixture').show(1, entries),
      [...parent, later],
    )
    expect(await label.count()).toBe(2)
    expect(await highlighted.count()).toBe(2)

    const child = {
      ...entry,
      id: 5,
      model: [{ ...message, content: [{ type: 'text', text: 'Completed child answer.' }] }],
    }
    await page.evaluate((item) => Reflect.get(window, 'fixture').show(2, [item]), child)
    expect(await label.count()).toBe(1)
    expect(await highlighted.textContent()).toContain('Completed child answer.')
    await page.reload()
    await page.waitForFunction(() => Reflect.has(window, 'fixture'))
    expect(await label.count()).toBe(1)
    expect(await highlighted.textContent()).toContain('Completed child answer.')
    await page.evaluate(
      (entries) => Reflect.get(window, 'fixture').show(1, entries),
      [...parent, later],
    )
    expect(await highlighted.count()).toBe(2)
    await page.reload()
    await page.waitForFunction(() => Reflect.has(window, 'fixture'))
    expect(await label.count()).toBe(2)
    expect(await highlighted.count()).toBe(2)
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
  }
})
