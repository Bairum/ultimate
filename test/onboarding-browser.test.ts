import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, skipWithoutChromium, temp } from './helpers.ts'

const timeout = { timeout: 15000 }

it('asks about the project and welcomes once, and a keyboard toggle keeps focus as its row moves', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-onboarding-browser-')
  const project = join(userHome, 'project')
  // The project's setup: an explainer and a folder in place of the built-in codemode.
  await mkdir(join(project, '.ultimate/extensions/codemode'), { recursive: true })
  await writeFile(join(project, '.ultimate/README.md'), 'Project setup for the browser test.')
  await writeFile(
    join(project, '.ultimate/extensions/codemode/README.md'),
    '# codemode\n\nThe project codemode.',
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
    localSetup: false,
    firstRun: true,
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const dialog = page.getByRole('dialog')
    await page.goto(server.url)

    // The project question comes first and discloses the replaced built-in.
    await expect
      .poll(() => dialog.getByText('This folder has its own Ultimate setup').count(), timeout)
      .toBe(1)
    await expect.poll(() => dialog.getByText('Replaces built-in').count(), timeout).toBe(1)
    await dialog.getByRole('button', { name: "Use this project's setup" }).click()

    // Then the welcome, once.
    await expect.poll(() => dialog.getByText('Welcome', { exact: true }).count(), timeout).toBe(1)
    await dialog.getByRole('button', { name: 'Start' }).click()
    await expect.poll(() => dialog.count(), timeout).toBe(0)
    await expect
      .poll(() =>
        access(join(userHome, '.ultimate/onboarding.json')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)

    // A reload asks neither again; a dialog would also block the panel below.
    await page.reload()
    await expect.poll(() => page.locator('main #composer-input').count(), timeout).toBe(1)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('Extensions…')
    await page.keyboard.press('Enter')
    const on = page.getByRole('region', { name: 'On' })
    const available = page.getByRole('region', { name: 'Available' })
    const clock = page.getByRole('switch', { name: 'clock for this project' })
    await expect
      .poll(
        () => available.getByRole('switch', { name: 'clock for this project' }).count(),
        timeout,
      )
      .toBe(1)
    await expect.poll(() => on.getByText('replaces the built-in').count(), timeout).toBe(1)

    // Space on the focused switch turns it on; the row moves to On and focus moves with it.
    await clock.focus()
    await page.keyboard.press('Space')
    await expect
      .poll(() => on.getByRole('switch', { name: 'clock for this project' }).count(), timeout)
      .toBe(1)
    const focused = () =>
      page.evaluate(() => {
        const active = document.activeElement
        return `${active?.closest('section')?.getAttribute('aria-label')}/${active?.getAttribute('aria-label')}`
      })
    await expect.poll(focused, timeout).toBe('On/clock for this project')
    expect(await clock.getAttribute('aria-checked')).toBe('true')
    await expect
      .poll(() => page.locator('aside [aria-live="polite"]').textContent(), timeout)
      .toBe('clock is on, under On')
    expect(
      JSON.parse(await readFile(join(project, '.ultimate/settings.json'), 'utf8')).extensions,
    ).toEqual({ enable: ['clock'] })
    expect(await dialog.count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 120000)
