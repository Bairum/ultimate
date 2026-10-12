import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }

it("opens a definition's config from the automations form over the bus, then takes focus back", async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-handoff-browser-')
  const project = join(userHome, 'project')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await mkdir(project)
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['automations', 'subagents'] } }),
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
    await page.goto(server.url)
    await page.locator('#composer-input').waitFor(timeout)
    await untilInput(page)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('Automations…')
    await page.keyboard.press('Enter')
    const panel = page.locator('aside')
    await panel.getByRole('button', { name: 'New automation' }).click(timeout)
    const form = page.getByRole('dialog', { name: 'New automation' })
    await form.getByRole('button', { name: 'Agent' }).click()
    await page.getByRole('menuitemradio', { name: /^scout/ }).click()

    await form.getByRole('button', { name: 'Configure' }).click()
    const definition = page.getByRole('dialog', { name: /^scout/ })
    await expect.poll(() => definition.getByLabel('Description').count(), timeout).toBe(1)

    // Closing it returns focus to Configure, over the form that is still open.
    await page.keyboard.press('Escape')
    await expect.poll(() => definition.count(), timeout).toBe(0)
    expect(await form.count()).toBe(1)
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim()), timeout)
      .toBe('Configure')
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
})
