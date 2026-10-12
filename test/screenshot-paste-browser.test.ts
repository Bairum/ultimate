import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { fauxServer, post, skipWithoutChromium, temp, untilInput } from './helpers.ts'
import { context } from '../server/harness.ts'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
async function paste(page: Page) {
  await page.evaluate((data) => {
    const clipboard = new DataTransfer()
    clipboard.items.add(
      new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'screenshot.png', {
        type: 'image/png',
      }),
    )
    document
      .querySelector('textarea')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }),
      )
  }, png)
}
async function show(page: Page, id: number) {
  await page.evaluate(
    `import('/src/sdk/client.ts').then(({ uiState }) => uiState.set('shell.conversation', ${id}))`,
  )
  await page.waitForFunction(
    `import('/src/sdk/client.ts').then(({ store }) => store.getState().view?.conversation.id === ${id})`,
  )
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  )
}

it('pastes, removes, preserves failures, sends real images and reloads clickable thumbnails without conversation races', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-screenshot-browser-')
  const projectRoot = join(userHome, 'project')
  await mkdir(projectRoot)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    server.host.faux!.setResponses([fauxAssistantMessage('I see the screenshot.')])
    const page = await browser.newPage()
    page.setDefaultTimeout(8000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await untilInput(page)
    const input = page.locator('textarea')
    await input.waitFor()
    // Non-image paste remains a native textarea operation.
    expect(
      await page.evaluate(() => {
        const data = new DataTransfer()
        data.setData('text/plain', 'ordinary text')
        return document
          .querySelector('textarea')!
          .dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          )
      }),
    ).toBe(true)
    await paste(page)
    await page.getByRole('button', { name: 'Remove image 1' }).waitFor()
    await page.getByRole('button', { name: 'Remove image 1' }).click()
    expect(await page.getByAltText('Pasted image 1').count()).toBe(0)
    await paste(page)
    await page.getByRole('button', { name: 'Remove image 1' }).waitFor()
    await page.route('**/api/conversations/1/submit', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Rejected screenshot' }),
      }),
    )
    await input.fill('Please review')
    await input.press('Enter')
    await page.getByText('Rejected screenshot').waitFor()
    expect(await input.inputValue()).toBe('Please review')
    expect(await page.getByAltText('Pasted image 1').count()).toBe(1)
    await page.unroute('**/api/conversations/1/submit')
    await input.fill('')
    await input.press('Enter')
    await page.getByAltText('Attached image 1').waitFor()
    await server.harness.waitForIdle(context)
    await page.reload()
    await untilInput(page)
    await page.getByAltText('Attached image 1').click()
    await page.getByRole('dialog').waitFor()
    expect(await page.getByRole('dialog').getByAltText('Attached image 1').count()).toBe(1)
    await page.keyboard.press('Escape')
    const child = (await post(server, '/api/conversations', {})).data.id as number
    // Delay decoding and switch conversations before it completes.
    await page.evaluate(
      `window.originalRead = FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL = function(file) { const reader = this; window.finishRead = () => new Promise(resolve => { reader.addEventListener('loadend', resolve); window.originalRead.call(reader, file) }) }`,
    )
    const submitted: string[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/submit')) submitted.push(request.url())
    })
    await input.fill('Wait for image')
    await paste(page)
    await input.press('Enter')
    expect(submitted).toEqual([])
    await show(page, child)
    await page.evaluate(`window.finishRead()`)
    expect(await page.getByAltText('Pasted image 1').count()).toBe(0)
    await page.evaluate(`FileReader.prototype.readAsDataURL = window.originalRead`)
    await show(page, 1)
    await paste(page)
    await page.getByRole('button', { name: 'Remove image 1' }).waitFor()
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    await page.route('**/api/conversations/1/submit', async (route) => {
      await gate
      await route.continue()
    })
    const sent = page.waitForResponse((response) =>
      response.url().endsWith('/conversations/1/submit'),
    )
    await input.fill('Old conversation')
    await input.press('Enter')
    await show(page, child)
    await input.fill('New draft')
    release()
    expect((await sent).status()).toBe(202)
    await server.harness.waitForIdle(context)
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    expect(await input.inputValue()).toBe('New draft')
    expect(await page.getByAltText('Pasted image 1').count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 30000)
