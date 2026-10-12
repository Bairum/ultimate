import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }

it('routes creation commands through the preference, guards in-flight calls and reports errors', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const directory = await temp('ultimate-creation-browser-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: directory,
    home: join(directory, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  try {
    const page = await browser.newPage()
    let calls = 0
    await page.route('**/api/extensions/workspaces/actions/create', async (route) => {
      calls++
      if (calls === 1) await gate
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not a Git repository' }),
      })
    })
    await page.goto(server.url)
    await untilInput(page)
    const count = server.api.conversations().length
    await page.getByLabel('New conversation', { exact: true }).click()
    await expect.poll(() => calls, timeout).toBe(1)
    await page.keyboard.press('Control+Alt+n')
    await page.keyboard.press('Control+k')
    await page.keyboard.type('New isolated conversation')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    expect(calls).toBe(1)
    expect(await page.getByRole('dialog').count()).toBe(0)
    release()
    await expect
      .poll(
        () => page.getByText(/New conversation \(conversations\): Not a Git repository/).count(),
        timeout,
      )
      .toBe(1)
    expect(server.api.conversations()).toHaveLength(count)

    // The shortcut retries after failure, still using the initial isolated preference.
    await page.keyboard.press('Control+Alt+n')
    await expect.poll(() => calls, timeout).toBe(2)
    await page.getByRole('button', { name: 'Conversation creation options' }).click()
    await page.getByRole('menuitemradio', { name: 'Shared (not isolated)', exact: true }).click()
    await page.keyboard.press('Control+k')
    await page.keyboard.type('New conversation')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id), timeout)
      .toBe('composer-input')
    expect(calls).toBe(2)
    expect(server.api.conversations()).toHaveLength(count)

    // Explicit isolated bypasses Shared and does not change the remembered choice.
    await page.keyboard.press('Control+k')
    await page.keyboard.type('New isolated conversation')
    await page.keyboard.press('Enter')
    await expect.poll(() => calls, timeout).toBe(3)
    await expect
      .poll(
        () =>
          page
            .getByText(/New isolated conversation \(conversations\): Not a Git repository/)
            .count(),
        timeout,
      )
      .toBe(1)
    await page.getByRole('button', { name: 'Conversation creation options' }).click()
    await expect
      .poll(
        () =>
          page
            .getByRole('menuitemradio', { name: 'Shared (not isolated)', exact: true })
            .getAttribute('aria-checked'),
        timeout,
      )
      .toBe('true')
  } finally {
    release()
    await browser.close()
    await server.close()
  }
}, 120000)
