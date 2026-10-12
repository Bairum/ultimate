import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it, type TestContext } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

const user = (id: number) => ({
  id,
  kind: 'pi.user',
  model: [{ role: 'user', content: `Original message ${id}.` }],
})
const marker = (id: number, kind = 'pi.compaction') => ({
  id,
  kind,
  model: [{ role: 'user', content: '<summary>\n## Goal\nKeep history accessible.\n</summary>' }],
})

async function fixture(test: TestContext, run: (page: Page) => Promise<void>) {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const base = await temp('ultimate-history-reconnect-')
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    await linkDependencies(base)
    await writeFile(
      join(base, 'index.html'),
      '<div id="app" style="height:400px;display:flex"></div><script type="module" src="/main.js"></script>',
    )
    await writeFile(
      join(base, 'main.js'),
      `import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Transcript } from '/@fs/${resolve('web/src/app/transcript.tsx')}'
import { store } from '/@fs/${resolve('web/src/sdk/client.ts')}'
import '/@fs/${resolve('web/src/index.css')}'
let source
window.EventSource = class extends EventTarget {
  readyState = 1
  constructor() { super(); source = this }
  close() {}
}
const originalFetch = window.fetch
const pages = new Map(), waiting = new Map(), requests = []
window.fetch = (url, options) => {
  if (!String(url).includes('/history?')) return originalFetch(url, options)
  const before = Number(new URL(url, location.href).searchParams.get('before'))
  requests.push(before)
  const data = pages.get(before)
  // Deliberately ignore AbortSignal: a stale completion must not update cursor/exhaustion.
  if (data === 'defer') return new Promise(done => waiting.set(before, done))
  return Promise.resolve(Response.json(data || { entries: [] }))
}
store.start()
const root = createRoot(document.querySelector('#app'))
flushSync(() => root.render(createElement(Transcript)))
window.fixture = {
  show: entries => flushSync(() => source.dispatchEvent(new MessageEvent('view', { data: JSON.stringify({ conversation: { id: 1 }, entries, docs: {} }) }))),
  page: (before, data) => pages.set(before, data),
  release: (before, data) => waiting.get(before)(Response.json(data)),
  requests: () => requests,
  active: () => store.getState().view.entries.map(row => row.id),
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
    page.setDefaultTimeout(2500)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.resolvedUrls!.local[0])
    await page.waitForFunction(() => Reflect.has(window, 'fixture'))
    await run(page)
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
  }
}

for (const state of ['exhausted', 'partial', 'in-flight']) {
  it(`restarts stored history scanning after an unseen compaction reconnects over ${state} paging`, async (test) => {
    await fixture(test, async (page) => {
      const old = Array.from({ length: 109 }, (_, n) => user(109 - n))
      await page.evaluate(
        ({ entries, state: paging }) => {
          const f = Reflect.get(window, 'fixture')
          f.page(110, { entries: entries.slice(0, 64), before: 46 })
          f.page(46, paging === 'in-flight' ? 'defer' : { entries: entries.slice(64) })
          f.show([
            {
              id: 110,
              kind: 'pi.user',
              model: [{ role: 'user', content: 'Original message 110.' }],
            },
          ])
        },
        { entries: old, state },
      )
      const load = page.getByRole('button', { name: 'Load earlier messages', exact: true })
      await load.click()
      await page.locator('[data-entry-id="46"]').waitFor()
      if (state === 'exhausted') {
        await load.click()
        await page.locator('[data-entry-id="1"]').waitFor()
      }
      if (state === 'in-flight') {
        await load.click()
        await page.getByRole('button', { name: 'Loading earlier messages…' }).waitFor()
      }
      const missing = Array.from({ length: 64 }, (_, n) => user(120 - n))
      await page.evaluate((entries) => {
        const f = Reflect.get(window, 'fixture')
        f.page(121, { entries, before: 57 })
        f.page(57, {
          entries: Array.from({ length: 56 }, (_, n) => ({
            id: 56 - n,
            kind: 'pi.user',
            model: [{ role: 'user', content: `Original message ${56 - n}.` }],
          })),
        })
        // Reconnect snapshots keep the conversation ID, replacing its active context.
        f.show([
          {
            id: 121,
            kind: 'pi.compaction',
            model: [{ role: 'user', content: '<summary>\nNew checkpoint\n</summary>' }],
          },
          entries[0],
        ])
      }, missing)
      await load.waitFor()
      expect(await load.isEnabled()).toBe(true)
      if (state === 'in-flight') {
        await page.evaluate(() => Reflect.get(window, 'fixture').release(46, { entries: [] }))
        await page.waitForTimeout(100)
      }
      expect(await load.count()).toBe(1)
      await load.click()
      await page.locator('[data-entry-id="111"]').waitFor()
      await load.click()
      await page.locator('[data-entry-id="1"]').waitFor()
      await page
        .getByRole('button', { name: 'Loading earlier messages…' })
        .waitFor({ state: 'detached' })
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').requests())).toEqual(
        state === 'partial' ? [110, 121, 57] : [110, 46, 121, 57],
      )
      expect(await page.locator('[data-entry-id]').count()).toBe(121)
      expect(await page.locator('[data-entry-id="110"]').count()).toBe(1)
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').active())).toEqual([121, 120])
      // A new reset must reopen an exhausted scan as well.
      await page.evaluate(
        (entry) => {
          const f = Reflect.get(window, 'fixture')
          f.page(123, {
            entries: [
              {
                id: 122,
                kind: 'pi.user',
                model: [{ role: 'user', content: 'Missed before reset' }],
              },
            ],
          })
          f.show([entry])
        },
        marker(123, 'pi.reset'),
      )
      await load.click()
      await page.locator('[data-entry-id="122"]').waitFor()
    })
  })
}

it('anchors a surviving row when paging joins a standalone tool result to its earlier call', async (test) => {
  await fixture(test, async (page) => {
    const result = {
      id: 66,
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'split-call',
          toolName: 'read',
          content: [{ type: 'text', text: 'Read result' }],
        },
      ],
    }
    const assistant = {
      id: 65,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'split-call', name: 'read', arguments: {} }],
          stopReason: 'toolUse',
        },
      ],
    }
    await page.evaluate(
      ({ result: row, assistant: call, users }) => {
        const f = Reflect.get(window, 'fixture')
        f.page(100, { entries: [row], before: 66 })
        f.page(66, {
          entries: [
            call,
            ...Array.from({ length: 63 }, (_, n) => ({
              id: 64 - n,
              kind: 'pi.user',
              model: [{ role: 'user', content: `Earlier message ${64 - n}` }],
            })),
          ],
        })
        f.show(users)
      },
      {
        result,
        assistant,
        users: [...Array.from({ length: 12 }, (_, n) => user(67 + n)), marker(100)],
      },
    )
    const load = page.getByRole('button', { name: 'Load earlier messages', exact: true })
    await load.click()
    await page.locator('[data-entry-id="66"]').waitFor()
    await page.locator('[data-entry-id="66"]').evaluate((row) => {
      row.scrollIntoView({ block: 'start' })
      row.parentElement!.parentElement!.scrollTop -= 64
    })
    const top = await page
      .locator('[data-entry-id="67"]')
      .evaluate((row) => row.getBoundingClientRect().top)
    // Invoke without Playwright scrolling the top button into view, as keyboard activation would.
    await load.evaluate((button) => (button as HTMLButtonElement).click())
    await page.locator('[data-entry-id="65"]').waitFor()
    expect(await page.locator('[data-entry-id="66"]').count()).toBe(0)
    await page.waitForTimeout(350)
    expect(
      Math.abs(
        (await page
          .locator('[data-entry-id="67"]')
          .evaluate((row) => row.getBoundingClientRect().top)) - top,
      ),
    ).toBeLessThan(3)
  })
})

it('anchors the replacement assistant when the standalone result is the only displayed row', async (test) => {
  await fixture(test, async (page) => {
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture')
      const result = {
        id: 66,
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'only-call',
            toolName: 'read',
            content: [{ type: 'text', text: 'Read result' }],
          },
        ],
      }
      const assistant = {
        id: 65,
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'only-call', name: 'read', arguments: {} }],
            stopReason: 'toolUse',
          },
        ],
      }
      f.page(66, {
        entries: [
          assistant,
          ...Array.from({ length: 63 }, (_, n) => ({
            id: 64 - n,
            kind: 'pi.user',
            model: [{ role: 'user', content: `Earlier message ${64 - n}` }],
          })),
        ],
      })
      f.show([result])
    })
    await page.locator('[data-entry-id="66"]').waitFor()
    const top = await page
      .locator('[data-entry-id="66"]')
      .evaluate((row) => row.getBoundingClientRect().top)
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
    await page.locator('[data-entry-id="65"]').waitFor()
    await page.waitForTimeout(350)
    expect(await page.locator('[data-entry-id="66"]').count()).toBe(0)
    expect(
      Math.abs(
        (await page
          .locator('[data-entry-id="65"]')
          .evaluate((row) => row.getBoundingClientRect().top)) - top,
      ),
    ).toBeLessThan(3)
  })
})
