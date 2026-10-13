import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }

it('picks and resets the summary model from the palette', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-summary-model-browser-')
  const project = join(userHome, 'project')
  await mkdir(project)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  const settings = async () =>
    JSON.parse(await readFile(join(userHome, '.ultimate/settings.json'), 'utf8').catch(() => '{}'))
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await expect.poll(() => page.locator('main #composer-input').count(), timeout).toBe(1)
    await untilInput(page)
    const open = async () => {
      await page.keyboard.press('Control+k')
      await page.keyboard.type('Summary model')
      await page.keyboard.press('Enter')
    }
    const dialog = page.getByRole('dialog', { name: 'Summary model' })
    const current = dialog.getByTestId('summary-model-current')

    await open()
    await expect.poll(() => current.textContent(), timeout).toBe('openai/gpt-6-luna:medium')
    await expect.poll(() => dialog.getByText('default', { exact: true }).count()).toBe(1)
    if (process.env.SUMMARY_MODEL_SCREENSHOT)
      await page.screenshot({ path: process.env.SUMMARY_MODEL_SCREENSHOT })
    await dialog.getByPlaceholder('Search logged-in models…').fill('faux-1')
    await dialog.getByRole('option', { name: /faux-1/ }).click()
    await expect.poll(() => dialog.count(), timeout).toBe(0)
    await expect.poll(settings, timeout).toEqual({ summaryModel: 'faux/faux-1' })

    await open()
    await expect.poll(() => current.textContent(), timeout).toBe('faux/faux-1')
    await expect
      .poll(() => dialog.getByText('~/.ultimate/settings.json', { exact: true }).count())
      .toBe(1)
    await dialog.getByRole('option', { name: /Use the default/ }).click()
    await expect.poll(() => dialog.count(), timeout).toBe(0)
    await expect.poll(settings, timeout).toEqual({})
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 60000)
