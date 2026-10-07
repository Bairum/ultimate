import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, post, skipWithoutChromium, temp, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }

it('sets a secret from the panel without echoing it, lists it as set, and deletes it after a confirm', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-secrets-browser-')
  const project = join(userHome, 'project')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await mkdir(project)
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['secrets', 'parallel'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  const value = 'sk-sentinel-4f1c9a'
  const list = async () =>
    (await post(server, '/api/extensions/secrets/actions/list', { args: null })).data.result as {
      name: string
      set: boolean
      declaredBy: string[]
    }[]
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await page.locator('#composer-input').waitFor(timeout)
    await untilInput(page)

    // The status line counts the missing key parallel declares; clicking it opens the panel at that row's form.
    const indicator = page.locator('footer').getByRole('button', { name: '1 secret missing' })
    await expect.poll(() => indicator.count(), timeout).toBe(1)
    await indicator.click()
    const panel = page.locator('aside').filter({ hasText: 'Plain text in' })
    const row = panel.getByRole('listitem', { name: 'PARALLEL_API_KEY' })
    await expect.poll(() => row.getByText('missing', { exact: true }).count(), timeout).toBe(1)
    expect(await row.getByText('parallel.ai API key for web search and fetch').count()).toBe(1)
    expect(await row.getByText('needed by parallel').count()).toBe(1)
    expect(await row.getByRole('link', { name: 'Get a key' }).getAttribute('href')).toBe(
      'https://platform.parallel.ai',
    )
    const input = row.getByLabel('Value for PARALLEL_API_KEY')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')), timeout)
      .toBe('Value for PARALLEL_API_KEY')

    // Hidden by default; the toggle shows it while typing. Cancel drops it.
    await input.fill('discarded-value')
    expect(await input.getAttribute('type')).toBe('password')
    await row.getByRole('button', { name: 'Cancel' }).click()
    expect(await input.count()).toBe(0)
    await row.getByRole('button', { name: 'Add' }).click()
    expect(await input.inputValue()).toBe('')
    await input.fill(value)
    await row.getByRole('button', { name: 'Show value' }).click()
    expect(await input.getAttribute('type')).toBe('text')
    expect(await row.getByRole('button', { name: 'Hide value' }).getAttribute('aria-pressed')).toBe(
      'true',
    )

    // Saved: the row and the status line follow, and the value is nowhere in the page.
    await row.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => row.getByText('set · just now').count(), timeout).toBe(1)
    await expect.poll(() => indicator.count(), timeout).toBe(0)
    expect(await panel.getByText('all set').count()).toBe(1)
    const leaked = () =>
      page.evaluate(
        (secret) =>
          document.documentElement.outerHTML.includes(secret) ||
          [...document.querySelectorAll('input, textarea')].some((field) =>
            (field as HTMLInputElement).value.includes(secret),
          ),
        value,
      )
    expect(await leaked()).toBe(false)
    expect(await list()).toEqual([
      expect.objectContaining({ name: 'PARALLEL_API_KEY', set: true, declaredBy: ['parallel'] }),
    ])
    expect(JSON.stringify(await list())).not.toContain(value)
    const store = join(userHome, '.ultimate/secrets.json')
    expect(JSON.parse(await readFile(store, 'utf8')).secrets.PARALLEL_API_KEY.value).toBe(value)

    // Delete asks first; Cancel keeps it, Delete removes it.
    await row.getByRole('button', { name: 'Delete' }).click()
    expect(await row.getByText('Delete this secret?').count()).toBe(1)
    await row.getByRole('button', { name: 'Cancel' }).click()
    expect(await row.getByText('set · just now').count()).toBe(1)
    await row.getByRole('button', { name: 'Delete' }).click()
    await row.getByRole('button', { name: 'Delete' }).click()
    await expect.poll(() => row.getByText('missing', { exact: true }).count(), timeout).toBe(1)
    await expect.poll(() => indicator.count(), timeout).toBe(1)
    expect((await list())[0]).toMatchObject({ name: 'PARALLEL_API_KEY', set: false })
    expect(JSON.parse(await readFile(store, 'utf8')).secrets).toEqual({})
    expect(await leaked()).toBe(false)

    // Closed, the palette opens it again.
    await page.keyboard.press('Control+Alt+b')
    await expect.poll(() => panel.count(), timeout).toBe(0)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('Secrets…')
    await page.keyboard.press('Enter')
    await expect.poll(() => panel.count(), timeout).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 120000)
