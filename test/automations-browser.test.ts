import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }

it('creates an automation from the form, lists its runs live, opens one, and keeps it after delete', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-automations-browser-')
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
  const answer: FauxResponseFactory = () => {
    server.host.faux!.appendResponses([answer])
    return fauxAssistantMessage([fauxText('## All quiet\nNothing changed.')])
  }
  server.host.faux!.setResponses([answer])
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
    await expect
      .poll(() => panel.getByText('Automations run a prompt on a schedule').count(), timeout)
      .toBe(1)

    // The form: a raw `every` schedule, previewed by the backend before it is saved.
    await panel.getByRole('button', { name: 'New automation' }).click()
    const dialog = page.getByRole('dialog', { name: 'New automation' })
    await dialog.getByLabel('Name').fill('Heartbeat')
    await dialog.getByLabel('Prompt').fill('Check the build.')
    await dialog.getByRole('radio', { name: 'Every' }).click()
    await dialog.getByLabel('Interval').fill('2s')
    await expect.poll(() => dialog.getByText('next', { exact: true }).count(), timeout).toBe(1)
    expect(await dialog.getByText('Every 2 seconds').count()).toBeGreaterThan(0)
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect.poll(() => dialog.count(), timeout).toBe(0)

    // Its first scheduled run shows up live with the first line of its answer.
    const row = panel.getByRole('listitem', { name: 'Heartbeat' })
    await row.getByRole('button', { name: /runs?$/ }).click()
    const runs = row.getByRole('list', { name: 'Runs' }).getByRole('listitem')
    await expect
      .poll(() => runs.filter({ hasText: 'All quiet' }).count(), timeout)
      .toBeGreaterThan(0)

    // The switch pauses it at once, and resuming brings the next scheduled run.
    const enabled = row.getByRole('switch', { name: 'Enable Heartbeat' })
    await enabled.click()
    await expect.poll(() => enabled.getAttribute('aria-checked'), timeout).toBe('false')
    await expect.poll(() => row.getByText('paused', { exact: true }).count(), timeout).toBe(1)
    const paused = await runs.count()
    await enabled.click()
    await expect.poll(() => enabled.getAttribute('aria-checked'), timeout).toBe('true')
    await expect.poll(() => runs.count(), timeout).toBeGreaterThan(paused)
    await enabled.click()
    await expect.poll(() => enabled.getAttribute('aria-checked'), timeout).toBe('false')

    // "open #id" shows the run's own conversation: the prompt was never sent to main.
    const open = runs
      .filter({ hasText: 'All quiet' })
      .last()
      .getByRole('button', { name: /^open #/ })
    await open.click()
    const main = page.locator('main')
    await expect.poll(() => main.getByText('Check the build.').count(), timeout).toBe(1)
    await expect.poll(() => main.getByText('Nothing changed.').count(), timeout).toBe(1)

    // Delete asks first and keeps the run conversations: after a reload the shown run is still there.
    await row.getByRole('button', { name: 'More for Heartbeat' }).click()
    await page.getByRole('menuitem', { name: 'Delete…' }).click()
    const confirm = row.getByRole('group', { name: 'Delete Heartbeat' })
    await expect.poll(() => confirm.getByText(/run conversations? (is|are) kept/).count()).toBe(1)
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => row.count(), timeout).toBe(0)
    await expect
      .poll(() => panel.getByText('Automations run a prompt on a schedule').count(), timeout)
      .toBe(1)
    await page.reload()
    await expect.poll(() => main.getByText('Check the build.').count(), timeout).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 120000)
