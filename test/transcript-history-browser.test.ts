import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

const user = (id: number) => ({
  id,
  kind: 'pi.user',
  model: [{ role: 'user', timestamp: 0, content: `Message ${id}: full original text.` }],
})

it('keeps history separate, anchors paging, retries, and ignores switched-conversation responses', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const base = await temp('ultimate-transcript-history-')
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
store.start()
const root = createRoot(document.querySelector('#app'))
flushSync(() => root.render(createElement(Transcript)))
window.fixture = {
  show: (id, entries) => flushSync(() => {
    store.show(id)
    source.dispatchEvent(new MessageEvent('view', { data: JSON.stringify({ conversation: { id }, entries, docs: {} }) }))
  }),
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
    page.setDefaultTimeout(5000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.resolvedUrls!.local[0])
    await page.waitForFunction(() => Reflect.has(window, 'fixture'))
    const marker = {
      id: 100,
      kind: 'pi.compaction',
      data: { reason: 'manual' },
      model: [
        {
          role: 'user',
          timestamp: 0,
          content:
            'The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nKeep **original messages** available.\n\n- Preserve history\n- Keep context small\n</summary>',
        },
      ],
    }
    await page.evaluate(
      (entries) => Reflect.get(window, 'fixture').show(1, entries),
      [marker, ...Array.from({ length: 10 }, (_, n) => user(101 + n))],
    )
    await page.getByText('Conversation condensed · manual', { exact: true }).click()
    expect(await page.locator('h2').textContent()).toBe('Goal')
    expect(await page.locator('[data-streamdown="strong"]').textContent()).toBe('original messages')
    expect(await page.locator('summary').count()).toBe(0)
    expect(
      await page.getByText('The conversation history before this point', { exact: false }).count(),
    ).toBe(0)
    await page
      .locator('[data-entry-id="100"]')
      .evaluate((row) => row.scrollIntoView({ block: 'start' }))
    let top = 0
    let attempt = 0
    await page.route('**/history?before=110', async (route) => {
      attempt++
      top = await page
        .locator('[data-entry-id="100"]')
        .evaluate((row) => row.getBoundingClientRect().top)
      await route.fulfill({
        status: attempt === 1 ? 500 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          attempt === 1
            ? { error: 'Try again' }
            : { entries: Array.from({ length: 64 }, (_, n) => user(99 - n)), before: 36 },
        ),
      })
    })
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
    await page.getByRole('alert').waitFor()
    await page.getByRole('button', { name: 'Retry loading earlier messages' }).click()
    await page.locator('[data-entry-id="36"]').waitFor()
    expect(
      Math.abs(
        (await page
          .locator('[data-entry-id="100"]')
          .evaluate((row) => row.getBoundingClientRect().top)) - top,
      ),
    ).toBeLessThan(3)
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').active())).toEqual([
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
    ])
    await page.route('**/history?before=36', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [user(36), ...Array.from({ length: 35 }, (_, n) => user(35 - n))],
        }),
      }),
    )
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
    await page.locator('[data-entry-id="1"]').waitFor()
    expect(await page.locator('[data-entry-id="36"]').count()).toBe(1)
    expect(
      await page.getByRole('button', { name: 'Load earlier messages', exact: true }).count(),
    ).toBe(0)
    // A live compaction must not discard rows the reader has already loaded.
    await page.evaluate(
      (entries) => Reflect.get(window, 'fixture').show(1, entries),
      [{ ...marker, id: 111 }],
    )
    expect(await page.locator('[data-entry-id="1"]').count()).toBe(1)
    expect(await page.locator('[data-entry-id="110"]').count()).toBe(1)
    await page.evaluate((entry) => Reflect.get(window, 'fixture').show(2, [entry]), user(200))
    let release: (() => void) | undefined
    const gate = new Promise<void>((done) => {
      release = done
    })
    await page.route('**/history?before=200', async (route) => {
      await gate
      await route
        .fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ entries: [user(199)] }),
        })
        .catch(() => {})
    })
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
    await page.getByRole('button', { name: 'Loading earlier messages…' }).waitFor()
    await page.evaluate((entry) => Reflect.get(window, 'fixture').show(3, [entry]), user(300))
    release!()
    await page.waitForTimeout(150)
    expect(
      await page
        .locator('[data-entry-id]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-entry-id'))),
    ).toEqual(['300'])
    // Preserve the empty tail as well when a short transcript becomes scrollable.
    await page.evaluate(
      (entries) => Reflect.get(window, 'fixture').show(4, entries),
      [{ ...marker, id: 400 }, user(401)],
    )
    await page.waitForTimeout(250)
    const shortTop = await page
      .locator('[data-entry-id="400"]')
      .evaluate((row) => row.getBoundingClientRect().top)
    await page.route('**/history?before=401', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          entries: Array.from({ length: 64 }, (_, n) => user(399 - n)),
          before: 336,
        }),
      }),
    )
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
    await page.locator('[data-entry-id="336"]').waitFor()
    await page.waitForTimeout(350)
    expect(
      Math.abs(
        (await page
          .locator('[data-entry-id="400"]')
          .evaluate((row) => row.getBoundingClientRect().top)) - shortTop,
      ),
    ).toBeLessThan(3)
    expect(await page.locator('[data-history-anchor-space]').count()).toBe(1)
    await page.locator('[data-entry-id="400"]').evaluate((row) => {
      const scroll = row.parentElement!.parentElement!
      scroll.scrollTop = scroll.scrollHeight
    })
    await page.locator('[data-history-anchor-space]').waitFor({ state: 'detached' })
    // Real compaction keeps a suffix but removes earlier head markers from the active view.
    await page.evaluate(
      (entries) => Reflect.get(window, 'fixture').show(5, entries),
      [{ ...marker, id: 50 }, user(20), user(30)],
    )
    await page.waitForTimeout(250)
    const retainedTop = await page
      .locator('[data-entry-id="20"]')
      .evaluate((row) => row.getBoundingClientRect().top)
    await page.route('**/history?before=50', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ entries: [{ ...marker, id: 40 }, user(30), user(20)], before: 20 }),
      }),
    )
    await page.route('**/history?before=20', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ entries: [user(10)] }),
      }),
    )
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
    await page.locator('[data-entry-id="40"]').waitFor()
    await page.waitForTimeout(350)
    expect(
      Math.abs(
        (await page
          .locator('[data-entry-id="20"]')
          .evaluate((row) => row.getBoundingClientRect().top)) - retainedTop,
      ),
    ).toBeLessThan(3)
    expect(await page.locator('[data-entry-id="20"]').count()).toBe(1)
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
    await page.locator('[data-entry-id="10"]').waitFor()
    expect(
      await page
        .locator('[data-entry-id]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-entry-id'))),
    ).toEqual(['10', '20', '30', '40', '50'])
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').active())).toEqual([50, 20, 30])
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
  }
})
