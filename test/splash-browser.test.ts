import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, skipWithoutChromium, temp } from './helpers.ts'

const timeout = { timeout: 15000 }

it('covers the page until ready, reveals the app, gives up after the timeout, and never returns on hot reloads', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-splash-browser-')
  const project = join(userHome, 'project')
  await mkdir(project)
  // A user facet that holds readiness back until the page releases it.
  const slow = join(userHome, '.ultimate/extensions/slowpoke')
  await mkdir(slow, { recursive: true })
  await writeFile(join(slow, 'README.md'), 'Holds the page back for the splash test.\n')
  await writeFile(
    join(slow, 'web.tsx'),
    `await new Promise((resolve) => Reflect.set(window, 'releaseSlowpoke', resolve))
export default { slots: { overlay: () => null } }
`,
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const splash = page.getByRole('progressbar', { name: 'Loading Ultimate' })
    const release = () => page.waitForFunction(() => Reflect.has(window, 'releaseSlowpoke'))
    // Strings, so the test runner leaves the page's own imports alone.
    const ready = () =>
      page.evaluate<boolean>(
        "import('/src/sdk/client.ts').then((m) => m.registry.getReady().ready)",
      )

    // The splash shows on load and holds while a facet is still loading.
    await page.goto(server.url)
    await splash.waitFor(timeout)
    await release()
    await page.evaluate(
      "import('/src/sdk/events.ts').then((m) => m.events.on('ultimate:ready', () => { window.readyAt = performance.now() }))",
    )
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[role="progressbar"]')) {
          Reflect.set(window, 'goneAt', performance.now())
          observer.disconnect()
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    await page.waitForTimeout(1500)
    expect(await splash.isVisible()).toBe(true)
    expect(await ready()).toBe(false)

    // Ready reveals the app, which then takes clicks and keys.
    await page.evaluate(() => Reflect.get(window, 'releaseSlowpoke')())
    await splash.waitFor({ state: 'detached', ...timeout })
    const [readyAt, goneAt] = await page.evaluate(() => [
      Reflect.get(window, 'readyAt'),
      Reflect.get(window, 'goneAt'),
    ])
    expect(readyAt).toBeTypeOf('number')
    expect(goneAt).toBeGreaterThan(readyAt)
    const composer = page.locator('#composer-input')
    await composer.click(timeout)
    await page.keyboard.type('hello')
    expect(await composer.inputValue()).toBe('hello')

    // A reload shows it again; a facet that never settles is named once the splash gives up.
    await page.reload()
    await splash.waitFor(timeout)
    await release()
    await splash.waitFor({ state: 'detached', timeout: 12000 })
    expect(
      await page.evaluate("import('/src/sdk/client.ts').then((m) => m.registry.getReady())"),
    ).toMatchObject({ ready: true, timedOut: true, pending: ['slowpoke'] })
    const notice = page.getByRole('alert').filter({ hasText: 'Not ready after 8 s' })
    await expect.poll(() => notice.textContent(), timeout).toContain('still loading: slowpoke')
    await composer.click(timeout)
    await page.evaluate(() => Reflect.get(window, 'releaseSlowpoke')())
    await expect.poll(() => notice.count(), timeout).toBe(0)
    expect(await ready()).toBe(true)

    // Hot reloads after ready, of another facet and of the splash itself, never show it again.
    await page.evaluate(() => {
      new MutationObserver(() => {
        if (document.querySelector('[role="progressbar"]')) Reflect.set(window, 'splashAgain', true)
      }).observe(document.body, { childList: true, subtree: true })
    })
    await writeFile(
      join(slow, 'web.tsx'),
      `export default { slots: { overlay: () => 'slowpoke v2' } }\n`,
    )
    await appendFile(join(server.host.ultimateRoot, 'extensions/splash/web.tsx'), '\n// edited\n')
    await expect.poll(() => page.getByText('slowpoke v2').count(), timeout).toBe(1)
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => Reflect.get(window, 'splashAgain'))).toBeUndefined()
    expect(await splash.count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 90000)
