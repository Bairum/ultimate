import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, skipWithoutChromium, temp } from './helpers.ts'
import { context } from '../server/harness.ts'

const timeout = { timeout: 15000 }

it('lists, creates, marks, archives, renames and clears conversations in the sidebar', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-conversations-browser-')
  const project = join(userHome, 'project')
  await mkdir(project)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  let releaseRun!: () => void
  const runGate = new Promise<void>((done) => {
    releaseRun = done
  })
  server.host.registry.install(
    defineExtension({
      name: 'conversations-test',
      tools: [
        defineTool({
          name: 'hold_run',
          description: 'Hold the run until the test releases it',
          parameters: Type.Object({}),
          execute: async () => {
            await runGate
            return {}
          },
        }),
      ],
    }),
  )
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const calls: string[] = []
    page.on('request', (request) => {
      const action = /\/api\/extensions\/conversations\/actions\/(\w+)$/.exec(request.url())?.[1]
      if (action) calls.push(action)
    })
    const configured: unknown[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/configure')) configured.push(request.postDataJSON())
    })
    const failed: string[] = []
    page.on('response', (response) => {
      if (response.url().endsWith('/configure') && response.status() >= 400)
        failed.push(`${response.status()} ${response.url()}`)
    })
    const sidebar = page.getByRole('navigation', { name: 'Conversations' })
    const rows = sidebar.locator('[data-conversation]')
    const titles = () => rows.locator('.truncate').allTextContents()
    const row = (title: string) => rows.filter({ hasText: title })
    const shown = () =>
      page.locator('[data-conversation]:has([aria-current])').getAttribute('data-conversation')
    const focused = () => page.evaluate(() => document.activeElement?.id)
    const send = async (text: string) => {
      await page.locator('#composer-input').fill(text)
      await page.keyboard.press('Enter')
      await expect.poll(() => page.locator('#composer-input').inputValue(), timeout).toBe('')
    }

    // After a turn, the main conversation is listed under its first message.
    await page.goto(server.url)
    server.host.faux!.setResponses([fauxAssistantMessage('First answer.')])
    await send('first message')
    await expect.poll(titles, timeout).toEqual(['first message'])

    // New conversation shows an empty draft, configured with the shown one's model, listed first, the composer focused.
    const { model } = await server.root.agent(context)
    await page.getByRole('button', { name: 'New conversation' }).click()
    await expect.poll(titles, timeout).toEqual(['New conversation', 'first message'])
    await expect.poll(shown, timeout).not.toBe('1')
    const draft = await shown()
    await expect.poll(focused, timeout).toBe('composer-input')
    await expect.poll(() => configured, timeout).toEqual([expect.objectContaining({ model })])
    expect(failed).toEqual([])

    // From the main conversation, the shortcut reuses that draft instead of creating another.
    await row('first message').locator('> button').first().click()
    await expect.poll(shown, timeout).toBe('1')
    await page.keyboard.press('Control+Alt+n')
    await expect.poll(shown, timeout).toBe(draft)
    await expect.poll(focused, timeout).toBe('composer-input')
    expect(await titles()).toEqual(['New conversation', 'first message'])

    // Sending titles the draft's row and lists it first; it shows working while it runs, also when not shown.
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('hold_run', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Second answer.'),
    ])
    try {
      await send('second message')
      await expect.poll(titles, timeout).toEqual(['second message', 'first message'])
      const second = row('second message')
      await expect.poll(() => second.getByRole('img', { name: 'Working' }).count(), timeout).toBe(1)
      await row('first message').locator('> button').first().click()
      await expect.poll(shown, timeout).toBe('1')
      expect(await second.getByRole('img', { name: 'Working' }).count()).toBe(1)
    } finally {
      releaseRun()
    }

    // Its answer arrived while another was shown: marked until looked at.
    const second = row('second message')
    await expect
      .poll(() => second.getByRole('img', { name: 'New answer' }).count(), timeout)
      .toBe(1)
    await second.locator('> button').first().click()
    await expect.poll(() => second.getByRole('img').count(), timeout).toBe(0)

    // Archiving moves a row into the collapsed Archived group, which survives a reload.
    const first = row('first message')
    await first.hover()
    await first.getByRole('button', { name: 'Conversation actions' }).click()
    await page.getByRole('menuitem', { name: 'Archive' }).click()
    await expect.poll(titles, timeout).toEqual(['second message'])
    const archived = page.getByRole('button', { name: /^Archived/ })
    await expect.poll(() => archived.textContent(), timeout).toBe('Archived · 1')
    await page.reload()
    await expect.poll(() => archived.textContent(), timeout).toBe('Archived · 1')
    expect(await titles()).toEqual(['second message'])
    await archived.click()
    await expect
      .poll(
        () => page.getByRole('region', { name: 'Archived' }).locator('.truncate').allTextContents(),
        timeout,
      )
      .toEqual(['first message'])

    // Rename from the menu: Enter saves, and the row and the header trail show the new title.
    const renamed = rows.first()
    await renamed.hover()
    await renamed.getByRole('button', { name: 'Conversation actions' }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const input = page.getByRole('textbox', { name: 'Conversation title' })
    await expect.poll(() => input.inputValue(), timeout).toBe('second message')
    await input.fill('Sidebar work')
    await page.keyboard.press('Enter')
    await expect.poll(titles, timeout).toEqual(['Sidebar work'])
    const trail = page.locator('header').getByText('Sidebar work', { exact: true })
    await expect.poll(() => trail.count(), timeout).toBe(1)
    const rowFocused = () =>
      renamed
        .locator('> button')
        .first()
        .evaluate((element) => element === document.activeElement)
    await expect.poll(rowFocused, timeout).toBe(true)

    // A double-click edits too; Escape cancels without a request, and focus returns to the row.
    await renamed.locator('.truncate').dblclick()
    await input.fill('Discarded')
    await page.keyboard.press('Escape')
    await expect.poll(() => input.count(), timeout).toBe(0)
    await expect.poll(rowFocused, timeout).toBe(true)
    expect(await titles()).toEqual(['Sidebar work'])

    // Clear context asks first; the transcript then shows the reset, and the row keeps its title and place.
    await renamed.hover()
    await renamed.getByRole('button', { name: 'Conversation actions' }).click()
    await page.getByRole('menuitem', { name: 'Clear context…' }).click()
    const dialog = page.getByRole('dialog')
    await expect
      .poll(() => dialog.textContent(), timeout)
      .toContain('Clear the context of Sidebar work? The agent starts fresh')
    await dialog.getByRole('button', { name: 'Clear context' }).click()
    await expect.poll(() => dialog.count(), timeout).toBe(0)
    await expect
      .poll(() => page.locator('main').getByText('context reset').count(), timeout)
      .toBe(1)
    expect(await titles()).toEqual(['Sidebar work'])
    expect(await trail.count()).toBe(1)
    expect(calls).toEqual(['rename', 'reset'])
    expect(failed).toEqual([])
    expect(errors).toEqual([])
  } finally {
    releaseRun()
    await browser.close()
    await server.close()
  }
}, 120000)
