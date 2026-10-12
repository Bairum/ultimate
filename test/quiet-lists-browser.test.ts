import { resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { skipWithoutChromium } from './helpers.ts'

it('keeps list identities quiet and excludes archived subtrees and their live tasks', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    server = await createServer({
      configFile: resolve('vite.config.ts'),
      root: resolve('.'),
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    browser = await chromium.launch({ executablePath, headless: true })
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${server.resolvedUrls!.local[0]}test/web/quiet-lists.html`)
    await page.waitForFunction(() => Reflect.has(window, 'fixture'))
    const agents = page.locator('[data-panel="agents"]')
    const tasks = page.locator('[data-panel="tasks"]')
    await agents.getByText('Setup failed', { exact: true }).waitFor()
    expect(await agents.getByText('Ready', { exact: true }).count()).toBe(0)
    expect(await agents.getByText('↑0', { exact: true }).count()).toBe(0)
    expect(await agents.getByText('↑2', { exact: true }).count()).toBe(1)
    expect(await agents.getByText('Setting up…', { exact: true }).count()).toBe(1)
    expect(await agents.getByText('Checkout failed', { exact: true }).count()).toBe(1)
    expect(await agents.locator('.animate-pulse-dot').count()).toBe(2)
    expect(await agents.getByRole('button', { name: 'Land', exact: true }).count()).toBe(4)
    expect(await agents.getByText('Untitled conversation', { exact: true }).count()).toBe(1)
    expect(await agents.getByText('Subagent', { exact: true }).count()).toBe(1)
    const longRow = agents.getByRole('button', { name: /Landed worker/ })
    expect(await longRow.getByText('#2', { exact: true }).count()).toBe(1)
    expect(await longRow.getByText('· W2', { exact: true }).count()).toBe(1)
    const layout = await longRow.evaluate((row) => {
      const title = row.querySelector('[title]')!
      const identity = title.nextElementSibling!
      return {
        truncated: title.scrollWidth > title.clientWidth,
        underneath: identity.getBoundingClientRect().top >= title.getBoundingClientRect().bottom,
      }
    })
    expect(layout).toEqual({ truncated: true, underneath: true })
    expect(await tasks.getByText('6 live · 5 running', { exact: true }).count()).toBe(1)
    expect(await tasks.getByText('aborting', { exact: true }).count()).toBe(1)
    expect(await tasks.getByText('bg', { exact: true }).count()).toBe(1)
    await page.evaluate(() => Reflect.get(window, 'fixture').archive([2]))
    expect(
      await agents.getByRole('button', { name: /Landed worker|Failed checkout/ }).count(),
    ).toBe(0)
    expect(await tasks.getByRole('button', { name: /Landed worker|Failed checkout/ }).count()).toBe(
      0,
    )
    expect(await tasks.getByText('#20', { exact: true }).count()).toBe(0)
    expect(await tasks.getByText('#30', { exact: true }).count()).toBe(0)
    expect(await agents.getByText('4 · 2 working', { exact: true }).count()).toBe(1)
    expect(await tasks.getByText('4 live · 3 running', { exact: true }).count()).toBe(1)
    await page.evaluate(() => Reflect.get(window, 'fixture').archive([1]))
    expect(await agents.getByRole('button', { name: /Review changes/ }).count()).toBe(0)
    expect(await tasks.getByText('1 live · 1 running', { exact: true }).count()).toBe(1)
    await page.evaluate(() => Reflect.get(window, 'fixture').archive([]))
    await agents.getByRole('button', { name: /Failed checkout/ }).waitFor()
    expect(await tasks.getByText('6 live · 5 running', { exact: true }).count()).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
  }
})
