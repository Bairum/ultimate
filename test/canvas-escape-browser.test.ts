import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, post, skipWithoutChromium, temp, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }

it('minimizes busy and idle Canvas chats without stopping workers, while explicit Stop and Agent Escape still stop', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-canvas-escape-')
  const project = join(userHome, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(
    join(project, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['canvas', 'subagents'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  server.vite.config.server.fs.allow.push(resolve('node_modules'))
  let release!: () => void
  const answered = new Promise<void>((done) => {
    release = done
  })
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (last.role === 'user' && last.content === 'Keep working')
      return fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 120' })], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && last.content === 'Delegate')
      return fauxAssistantMessage(
        [fauxToolCall('subagent', { action: 'start', agent: 'scout', task: 'Wait for release' })],
        { stopReason: 'toolUse' },
      )
    if (last.role === 'user' && last.content === 'Wait for release') await answered
    return fauxAssistantMessage('Finished.')
  }
  server.host.faux!.setResponses([route])
  await post(server, '/api/ui', { set: { 'shell.surface': 'canvas' } })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await untilInput(page)
    const hub = page.getByRole('textbox', { name: 'Start a conversation' })
    await hub.waitFor(timeout)
    await page.getByRole('switch', { name: 'Isolated' }).click()
    const map = page.locator('[data-canvas-map]')
    const focused = page.locator('[data-canvas-focus]')

    for (const stopWithEscape of [false, true]) {
      await map.focus()
      await page.keyboard.press('n')
      // N focuses the Hub after the camera animation. Filling it first would leave a pending
      // focus callback that can steal focus from a later composer or dismiss a surface menu.
      await expect.poll(() => hub.evaluate((input) => input === document.activeElement)).toBe(true)
      await hub.fill('Keep working')
      await hub.press('Enter')
      await expect
        .poll(
          () => server.api.conversations().find((summary) => summary.busy && summary.inputAt)?.id,
          timeout,
        )
        .toBeDefined()
      const running = server.api
        .conversations()
        .find((summary) => summary.busy && summary.inputAt)!.id
      await page
        .locator(`[data-agent="${running}"] [data-tool="bash"][data-tool-status="running"]`)
        .waitFor(timeout)
      await map.focus()
      await page.keyboard.press('Enter')
      await focused.locator('#composer-input').waitFor(timeout)
      await focused.locator('#composer-input').focus()
      await page.keyboard.press('Escape')
      await focused.waitFor({ state: 'detached', ...timeout })
      await expect
        .poll(() => map.evaluate((element) => element === document.activeElement))
        .toBe(true)
      expect(server.api.conversations().find((summary) => summary.id === running)!.busy).toBe(true)
      await page.keyboard.press('Enter')
      await focused.waitFor(timeout)
      await map.focus()
      await page.keyboard.press('Escape')
      await focused.waitFor({ state: 'detached', ...timeout })
      expect(server.api.conversations().find((summary) => summary.id === running)!.busy).toBe(true)
      await page.keyboard.press('Enter')
      await focused.locator('#composer-input').waitFor(timeout)
      if (stopWithEscape) {
        // Agent is the first surface; use its keyboard shortcut, not the unrelated surface menu.
        await page.keyboard.press('Control+1')
        await focused.waitFor({ state: 'detached', ...timeout })
        await page.locator('#composer-input').focus()
        await page.keyboard.press('Escape')
      } else {
        await focused.getByTitle('Stop', { exact: true }).click()
      }
      await expect
        .poll(
          () => server.api.conversations().find((summary) => summary.id === running)!.busy,
          timeout,
        )
        .toBe(false)
      await page.evaluate(
        `import('/src/sdk/actions.ts').then(({ actions }) => actions.showSurface('canvas'))`,
      )
      await map.waitFor(timeout)
      // Idle Escape also restores focus for the next keyboard command.
      await map.focus()
      await page.keyboard.press('Enter')
      await focused.locator('#composer-input').waitFor(timeout)
      await focused.locator('#composer-input').focus()
      await page.keyboard.press('Escape')
      await focused.waitFor({ state: 'detached', ...timeout })
      await expect
        .poll(() => map.evaluate((element) => element === document.activeElement))
        .toBe(true)
    }

    await post(server, '/api/conversations/1/submit', { text: 'Delegate' })
    await expect
      .poll(
        () => server.api.conversations().find((summary) => summary.label === 'scout')?.id,
        timeout,
      )
      .toBeDefined()
    const child = server.api.conversations().find((summary) => summary.label === 'scout')!.id
    await page.evaluate(
      `import('/src/sdk/actions.ts').then(({ actions }) => actions.switchConversation(${child}))`,
    )
    await expect
      .poll(() => page.evaluate(() => new URL(location.href).searchParams.get('conversation')))
      .toBe(String(child))
    await page.locator(`[data-agent="${child}"]`).waitFor(timeout)
    await map.focus()
    await page.keyboard.press('Enter')
    await focused.locator('#composer-input').waitFor(timeout)
    await focused.locator('#composer-input').focus()
    await page.keyboard.press('Escape')
    await focused.waitFor({ state: 'detached', ...timeout })
    await expect
      .poll(() => map.evaluate((element) => element === document.activeElement))
      .toBe(true)
    expect(server.api.conversations().find((summary) => summary.id === child)!.busy).toBe(true)
    expect(server.api.conversations().find((summary) => summary.id === 1)!.busy).toBe(true)
    await page.keyboard.press('Enter')
    await focused.waitFor(timeout)
    await page.getByRole('button', { name: 'Back to the map' }).click()
    await focused.waitFor({ state: 'detached', ...timeout })
    await expect
      .poll(() => map.evaluate((element) => element === document.activeElement))
      .toBe(true)
    release()
    await expect
      .poll(() => server.api.conversations().find((summary) => summary.id === child)!.busy, timeout)
      .toBe(false)
    await expect
      .poll(() => server.api.conversations().find((summary) => summary.id === 1)!.busy, timeout)
      .toBe(false)
    expect(errors).toEqual([])
  } finally {
    release()
    await browser.close()
    await server.close()
  }
}, 120000)
