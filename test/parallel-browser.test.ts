import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }

/** A fake Parallel API, as in parallel.test.ts: ranked results for /search, one page and one failure for /extract. */
async function fakeParallel() {
  const keys: (string | undefined)[] = []
  const server = createServer(async (request, response) => {
    await new Promise((done) => request.resume().on('end', done))
    keys.push(request.headers['x-api-key'] as string | undefined)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify(
        request.url === '/search'
          ? {
              search_id: 's',
              session_id: 'session',
              results: [
                {
                  url: 'https://www.example.com/durable',
                  title: 'Durable agents',
                  publish_date: '2026-09-01',
                  excerpts: ['Durable agents survive restarts by committing every step.'],
                },
                {
                  url: 'https://docs.pi.dev/guide',
                  title: 'Pi guide',
                  publish_date: null,
                  excerpts: ['Pi is minimal, readable, and malleable.'],
                },
                {
                  url: 'https://blog.example.org/post',
                  title: null,
                  publish_date: '2026-08-15T10:00:00Z',
                  excerpts: ['A post about checkpoints.'],
                },
                { url: 'https://news.site/item', title: 'News', excerpts: ['More.'] },
              ],
              warnings: [{ type: 'notice', message: 'Some results were filtered.' }],
            }
          : {
              extract_id: 'e',
              session_id: 'session',
              results: [
                {
                  url: 'https://example.com/durable',
                  title: 'Durable agents',
                  publish_date: null,
                  excerpts: [
                    '## Checkpoints\n\nEvery **tool call** is committed.\n\n![Diagram](https://images.example.com/diagram.png)',
                  ],
                },
              ],
              errors: [
                {
                  url: 'https://bad.example/page',
                  error_type: 'unavailable',
                  http_status_code: 404,
                },
              ],
            },
      ),
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  vi.stubEnv('ULTIMATE_PARALLEL_TEST_URL', `http://127.0.0.1:${address.port}`)
  return {
    keys,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

const card = (page: Page, text: string) => page.locator('.group\\/tool').filter({ hasText: text })

it('renders web_search and web_fetch results, and a missing key with Add key opening the Secrets panel', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  vi.stubEnv('PARALLEL_API_KEY', '')
  const userHome = await temp('ultimate-parallel-browser-')
  const project = join(userHome, 'project')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await mkdir(project)
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['secrets', 'parallel'] } }),
  )
  const api = await fakeParallel()
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // The renderers request nothing from the web: no favicons, previews, or images in fetched markdown.
    const external: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (!url.startsWith(server.url) && !url.startsWith('data:')) external.push(url)
    })
    const send = async (text: string) => {
      await page.locator('#composer-input').fill(text)
      await page.keyboard.press('Enter')
      await expect.poll(() => page.locator('#composer-input').inputValue(), timeout).toBe('')
    }
    await page.goto(server.url)
    await page.locator('#composer-input').waitFor(timeout)
    await untilInput(page)

    // Without a key: a compact error, open, with Add key beside the header, which opens the Secrets panel at it.
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('web_search', { query: 'keyless question' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('No key yet.'),
    ])
    await send('search without a key')
    const failed = card(page, 'keyless question')
    await expect.poll(() => failed.getByText(/^Missing PARALLEL_API_KEY/).count(), timeout).toBe(1)
    expect(api.keys).toEqual([])
    await failed.getByRole('button', { name: 'Add key' }).click()
    const input = page.locator('aside').getByLabel('Value for PARALLEL_API_KEY')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')), timeout)
      .toBe('Value for PARALLEL_API_KEY')
    await input.fill('test-key')
    await page.locator('aside').getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => input.count(), timeout).toBe(0)

    // With the key: search, then fetch.
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('web_search', { query: 'durable agents' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(
        [
          fauxToolCall('web_fetch', {
            url: ['https://example.com/durable', 'https://bad.example/page'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Found it.'),
    ])
    await send('search and fetch')

    // Search, collapsed: the query, the top domains, how many results, and a warning count.
    const search = card(page, 'durable agents · example.com')
    await expect.poll(() => search.getByText('4 results').count(), timeout).toBe(1)
    expect(await search.getByText('· example.com, docs.pi.dev, blog.example.org +1').count()).toBe(
      1,
    )
    expect(await search.getByText('1 warning').count()).toBe(1)
    const results = search.getByRole('list', { name: 'Search results' })
    expect(await results.isVisible()).toBe(false)

    // Expanded: each result's title as a link, its domain and date, and its excerpt; the warning, compact.
    await search.getByRole('button', { name: /search/ }).click()
    await expect.poll(() => results.isVisible(), timeout).toBe(true)
    expect(await results.getByRole('listitem').count()).toBe(4)
    const first = results.getByRole('listitem').first()
    expect(await first.getByRole('link', { name: 'Durable agents' }).getAttribute('href')).toBe(
      'https://www.example.com/durable',
    )
    expect(await first.getByText('example.com', { exact: true }).count()).toBe(1)
    expect(await first.getByText('2026-09-01').count()).toBe(1)
    expect(await first.getByText('Durable agents survive restarts').count()).toBe(1)
    // An untitled result shows its address; an ISO date shows its day.
    const third = results.getByRole('listitem').nth(2)
    expect(await third.getByRole('link', { name: 'blog.example.org/post' }).count()).toBe(1)
    expect(await third.getByText('2026-08-15', { exact: true }).count()).toBe(1)
    expect(await search.getByText('Some results were filtered.').count()).toBe(1)

    // Fetch, collapsed: the domains, one page, and one failure.
    const fetch = card(page, 'example.com, bad.example')
    await expect.poll(() => fetch.getByText('1 page', { exact: true }).count(), timeout).toBe(1)
    expect(api.keys).toEqual(['test-key', 'test-key'])
    expect(await fetch.getByText('1 failed').count()).toBe(1)

    // Expanded: the page's title and source link, its content as markdown (open for a single page), and the failure.
    await fetch.getByRole('button', { name: /fetch/ }).click()
    const pages = fetch.getByRole('list', { name: 'Fetched pages' })
    await expect.poll(() => pages.isVisible(), timeout).toBe(true)
    expect(await pages.getByText('Durable agents', { exact: true }).count()).toBe(1)
    expect(
      await pages.getByRole('link', { name: 'example.com/durable' }).getAttribute('href'),
    ).toBe('https://example.com/durable')
    await expect
      .poll(() => pages.getByRole('heading', { name: 'Checkpoints' }).count(), timeout)
      .toBe(1)
    // Bold rendered on its own, not as asterisks.
    expect(await pages.getByText('tool call', { exact: true }).count()).toBe(1)
    expect(await pages.getByText('**tool call**').count()).toBe(0)
    expect(await fetch.locator('img').count()).toBe(0)
    expect(await fetch.getByText('bad.example/page').count()).toBe(1)
    expect(await fetch.getByText('unavailable · HTTP 404').count()).toBe(1)
    // The disclosure folds the content away.
    await pages.getByRole('button', { name: /^content/ }).click()
    await expect
      .poll(() => pages.getByRole('heading', { name: 'Checkpoints' }).count(), timeout)
      .toBe(0)

    expect(external).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
    await api.close()
  }
}, 120000)
