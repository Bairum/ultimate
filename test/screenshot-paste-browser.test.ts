import { mkdir, writeFile } from 'node:fs/promises'
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
async function pasteScreenshot(page: Page, selector: string, count = 1) {
  await page.evaluate(
    ({ target, copies }) => {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 640
      const drawing = canvas.getContext('2d')!
      drawing.fillStyle = '#615393'
      drawing.fillRect(0, 0, canvas.width, canvas.height)
      drawing.fillStyle = 'white'
      drawing.font = '24px sans-serif'
      drawing.fillText('Screenshot', 30, 90)
      const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), (c) => c.charCodeAt(0))
      const clipboard = new DataTransfer()
      for (let i = 0; i < copies; i++)
        clipboard.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
      document.querySelector(target)!.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      )
    },
    { target: selector, copies: count },
  )
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
    await pasteScreenshot(page, '#composer-input')
    const preview = page.getByAltText('Pasted image 1')
    await expect
      .poll(() => preview.evaluate((image) => image.getBoundingClientRect().height))
      .toBe(96)
    expect(await preview.evaluate((image) => getComputedStyle(image).maxHeight)).toBe('96px')
    await page.getByRole('button', { name: 'Remove image 1' }).click()
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

it('reconciles delayed submissions across navigation and preserves keyboard focus and newer drafts', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-send-lifecycle-')
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
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(8000)
    await page.goto(server.url)
    await untilInput(page)
    const input = page.locator('textarea')
    await input.waitFor()
    await untilInput(page)
    // Stay on A: disabling the textarea would blur it, unlike a read-only editor.
    let finish!: () => void
    const delayed = new Promise<void>((done) => {
      finish = done
    })
    await page.route('**/api/conversations/1/submit', async (route) => {
      await delayed
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: '{"submissionId":1}',
      })
    })
    await input.fill('Keyboard submission')
    const completed = page.waitForResponse((response) => response.url().endsWith('/1/submit'))
    await input.press('Enter')
    await expect.poll(() => input.getAttribute('readonly')).not.toBeNull()
    expect(await input.evaluate((element) => element === document.activeElement)).toBe(true)
    finish()
    await completed
    await expect.poll(() => input.getAttribute('readonly')).toBeNull()
    await page.keyboard.type('Keyboard draft')
    expect(await input.inputValue()).toBe('Keyboard draft')
    await page.unroute('**/api/conversations/1/submit')
    const other = (await post(server, '/api/conversations', {})).data.id as number
    for (const scenario of [
      { success: true, returnFirst: false, newer: false },
      { success: true, returnFirst: true, newer: false },
      { success: false, returnFirst: false, newer: false },
      { success: false, returnFirst: true, newer: false },
      { success: true, returnFirst: true, newer: true },
      { success: true, returnFirst: false, newer: true },
      { success: false, returnFirst: false, newer: true },
    ]) {
      await paste(page)
      await page.getByRole('button', { name: 'Remove image 1' }).waitFor()
      await input.fill('Submitted draft')
      let release!: () => void
      const gate = new Promise<void>((done) => {
        release = done
      })
      let requested!: () => void
      const started = new Promise<void>((done) => {
        requested = done
      })
      await page.route('**/api/conversations/1/submit', async (route) => {
        requested()
        await gate
        await route.fulfill({
          status: scenario.success ? 202 : 400,
          contentType: 'application/json',
          body: JSON.stringify(
            scenario.success ? { submissionId: 1 } : { error: 'Retry screenshot' },
          ),
        })
      })
      const received = page.waitForResponse((response) => response.url().endsWith('/1/submit'))
      await input.press('Enter')
      await started
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true)
      expect(await input.getAttribute('readonly')).not.toBeNull()
      await show(page, other)
      expect(await page.getByAltText('Pasted image 1').count()).toBe(0)
      await input.fill('Other conversation draft')
      if (scenario.newer)
        await page.evaluate(() => localStorage.setItem('ultimate.draft.1', 'Newer draft'))
      if (scenario.returnFirst) await show(page, 1)
      release()
      await received
      if (!scenario.returnFirst) await show(page, 1)
      await expect.poll(() => input.getAttribute('readonly')).toBeNull()
      const expected = scenario.newer ? 'Newer draft' : scenario.success ? '' : 'Submitted draft'
      expect(await input.inputValue()).toBe(expected)
      expect(await page.evaluate(() => localStorage.getItem('ultimate.draft.1'))).toBe(
        expected || null,
      )
      expect(await page.getByAltText('Pasted image 1').count()).toBe(scenario.success ? 0 : 1)
      expect(await page.getByText('Retry screenshot', { exact: true }).count()).toBe(
        scenario.success ? 0 : 1,
      )
      // Do not focus or fill: typing must land in the editor already focused by Enter/remount.
      await page.keyboard.press('End')
      await page.keyboard.type('Next message')
      expect(await input.inputValue()).toBe(expected + 'Next message')
      await page.unroute('**/api/conversations/1/submit')
      await page.route('**/api/conversations/1/submit', (route) =>
        route.fulfill({ status: 202, contentType: 'application/json', body: '{"submissionId":1}' }),
      )
      const retry = page.waitForResponse((response) => response.url().endsWith('/1/submit'))
      await input.press('Enter')
      await retry
      await expect.poll(() => input.inputValue()).toBe('')
      expect(await page.getByAltText('Pasted image 1').count()).toBe(0)
      await page.unroute('**/api/conversations/1/submit')
      await show(page, other)
      expect(await input.inputValue()).toBe('Other conversation draft')
      await show(page, 1)
    }
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 30000)

it('shares Hub clipboard validation and blocks images until a branch has started', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-hub-paste-')
  const projectRoot = join(userHome, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['canvas'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    await post(server, '/api/ui', { set: { 'shell.surface': 'canvas' } })
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.setDefaultTimeout(10000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await untilInput(page)
    const input = page.locator('#canvas-hub-input')
    const send = page.getByRole('button', { name: 'Start the conversation', exact: true })
    await input.waitFor()
    const clipboard = async (mimeTypes: string[], size = 1) =>
      page.evaluate(
        ({ types, bytes }) => {
          const data = new DataTransfer()
          for (const type of types)
            data.items.add(new File([new Uint8Array(bytes)], 'shot', { type }))
          if (!types.length) data.setData('text/plain', 'native text')
          return document
            .querySelector('#canvas-hub-input')!
            .dispatchEvent(
              new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
            )
        },
        { types: mimeTypes, bytes: size },
      )
    expect(await clipboard([])).toBe(true)
    for (const [types, bytes] of [
      [['image/svg+xml'], 1],
      [['image/png'], 2 * 1024 * 1024 + 1],
      [Array(5).fill('image/png'), 1],
    ] as [string[], number][]) {
      expect(await clipboard(types, bytes)).toBe(false)
      await page
        .getByText('Paste up to 4 PNG, JPEG, WebP or GIF images, at most 2 MiB each.')
        .waitFor()
      expect(await page.getByAltText('Pasted image 1').count()).toBe(0)
    }
    await clipboard(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    await page.getByAltText('Pasted image 4').waitFor()
    await clipboard(['image/png'])
    expect(await page.getByAltText(/Pasted image/).count()).toBe(4)
    for (let i = 4; i > 0; i--)
      await page.getByRole('button', { name: `Remove image ${i}` }).click()
    expect(await send.isDisabled()).toBe(true)
    await pasteScreenshot(page, '#canvas-hub-input', 4)
    await expect.poll(() => page.getByAltText('Pasted image 4').count()).toBe(1)
    await expect
      .poll(() =>
        page
          .getByAltText('Pasted image 4')
          .evaluate((image) => image.getBoundingClientRect().height),
      )
      .toBe(40)
    const geometry = await page.locator('[data-hub]').evaluate((hub) => {
      const bounds = hub.getBoundingClientRect()
      const images = Array.from(hub.querySelectorAll('img'))
      const row = images[0].parentElement!.parentElement!.parentElement!.getBoundingClientRect()
      const editor = hub.querySelector('textarea')!.getBoundingClientRect()
      const button = hub
        .querySelector('[aria-label="Start the conversation"]')!
        .getBoundingClientRect()
      return {
        height: bounds.height,
        imageHeights: images.map((image) => image.getBoundingClientRect().height),
        maxHeights: images.map((image) => getComputedStyle(image).maxHeight),
        rowHeight: row.height,
        editorHeight: editor.height,
        separate: row.bottom <= editor.top && editor.bottom <= button.top,
        contained: button.bottom <= bounds.bottom,
      }
    })
    expect(geometry).toMatchObject({
      height: 224,
      imageHeights: [40, 40, 40, 40],
      maxHeights: ['40px', '40px', '40px', '40px'],
      separate: true,
      contained: true,
    })
    expect(geometry.rowHeight).toBeLessThanOrEqual(56)
    expect(geometry.editorHeight).toBeGreaterThan(14)
    await input.fill('Usable with four screenshots')
    for (let i = 4; i > 0; i--)
      await page.getByRole('button', { name: `Remove image ${i}` }).click()
    await clipboard(['image/png'], 2 * 1024 * 1024)
    await page.getByAltText('Pasted image 1').waitFor()
    await input.fill('Keep this draft')
    await page.evaluate(
      `window.originalRead = FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL = function() { this.dispatchEvent(new Event('error')) }`,
    )
    await paste(page)
    await page.getByText('Could not read pasted image', { exact: true }).waitFor()
    expect(await input.inputValue()).toBe('Keep this draft')
    expect(await page.getByAltText('Pasted image 1').count()).toBe(1)
    await page.evaluate('FileReader.prototype.readAsDataURL = window.originalRead')
    await page.getByRole('button', { name: 'Remove image 1' }).click()
    await page.evaluate(
      `window.originalRead = FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL = function(file) { const reader = this; window.finishRead = () => new Promise(resolve => { reader.addEventListener('loadend', resolve); window.originalRead.call(reader, file) }) }`,
    )
    await input.fill('Wait for image')
    await paste(page)
    expect(await send.isDisabled()).toBe(true)
    const submissions: { text: string; images: { data: string; mimeType: string }[] }[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/submit')) submissions.push(request.postDataJSON())
    })
    await input.press('Enter')
    expect(submissions).toEqual([])
    await page.evaluate('window.finishRead()')
    await page.getByAltText('Pasted image 1').waitFor()
    await page.evaluate('FileReader.prototype.readAsDataURL = window.originalRead')
    await page.getByRole('button', { name: 'Remove image 1' }).click()
    for (const text of ['Review screenshot', '']) {
      await input.fill(text)
      await paste(page)
      await page.getByAltText('Pasted image 1').waitFor()
      expect(await send.isDisabled()).toBe(true)
      await page.getByText('Images can be added after the branch starts', { exact: true }).waitFor()
      await input.press('Enter')
      expect(submissions).toEqual([])
      expect(await input.inputValue()).toBe(text)
      expect(await page.getByAltText('Pasted image 1').count()).toBe(1)
      await page.getByRole('button', { name: 'Remove image 1' }).click()
    }
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 60000)
