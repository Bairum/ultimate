import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, post, skipWithoutChromium, temp, untilInput } from './helpers.ts'

async function shown(page: Page, id: number) {
  await page.waitForFunction(
    `import('/src/sdk/client.ts').then(({ store }) => store.getState().view?.conversation.id === ${id})`,
  )
  await expect
    .poll(() => new URL(page.url()).searchParams.get('conversation'), { timeout: 8000 })
    .toBe(String(id))
}
async function switchTo(page: Page, id: number) {
  await page.evaluate(
    `import('/src/sdk/actions.ts').then(({ actions }) => actions.switchConversation(${id}))`,
  )
  await shown(page, id)
}

it('deep links, reloads and traverses shared conversation selection without history loops', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-conversation-url-')
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
    const child = (await post(server, '/api/conversations', {})).data.id as number
    await post(server, '/api/ui', { set: { 'shell.conversation': child } })
    const page = await browser.newPage()
    page.setDefaultTimeout(8000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // A missing parameter restores saved selection and replaces the initial entry.
    await page.goto(`${server.url}/?other=keep#anchor`)
    await untilInput(page)
    await shown(page, child)
    const initialLength = await page.evaluate(() => history.length)
    await switchTo(page, 1)
    expect(await page.evaluate(() => history.length)).toBe(initialLength + 1)
    await switchTo(page, 1)
    expect(await page.evaluate(() => history.length)).toBe(initialLength + 1)
    expect(new URL(page.url()).searchParams.get('other')).toBe('keep')
    expect(new URL(page.url()).hash).toBe('#anchor')
    await page.goBack()
    await shown(page, child)
    await page.goForward()
    await shown(page, 1)
    expect(await page.evaluate(() => history.length)).toBe(initialLength + 1)
    // Persist a conflicting saved value, then prove the explicit URL wins and reloads.
    await post(server, '/api/ui', { set: { 'shell.conversation': child } })
    await page.goto(`${server.url}/?other=keep&conversation=1#anchor`)
    await shown(page, 1)
    const linkedLength = await page.evaluate(() => history.length)
    await page.reload()
    await shown(page, 1)
    expect(await page.evaluate(() => history.length)).toBe(linkedLength)
    await post(server, '/api/ui', { set: { 'shell.conversation': 1 } })
    await page.goto(`${server.url}/?other=keep&conversation=${child}#anchor`)
    await shown(page, child)
    await page.reload()
    await shown(page, child)
    await switchTo(page, 1)
    // A second tab still follows durable shared selection, including its URL.
    const peer = await browser.newPage()
    await peer.goto(server.url)
    await shown(peer, 1)
    await switchTo(page, child)
    await shown(peer, child)
    await peer.close()
    for (const invalid of ['', 'abc', '-1', '0', '1.5', '9007199254740992', '999999']) {
      await post(server, '/api/ui', { set: { 'shell.conversation': child } })
      await page.goto(`${server.url}/?other=keep&conversation=${invalid}#anchor`)
      const length = await page.evaluate(() => history.length)
      await shown(page, 1)
      await untilInput(page)
      expect(await page.evaluate(() => history.length)).toBe(length)
      expect(new URL(page.url()).searchParams.get('other')).toBe('keep')
      expect(new URL(page.url()).hash).toBe('#anchor')
    }
    // An unavailable switch pushes once, then fallback corrects that entry in place.
    const beforeInvalid = await page.evaluate(() => history.length)
    await page.evaluate(
      `import('/src/sdk/actions.ts').then(({ actions }) => actions.switchConversation(999999))`,
    )
    await shown(page, 1)
    expect(await page.evaluate(() => history.length)).toBe(beforeInvalid + 1)
    await page.goBack()
    await shown(page, 1)
    expect(await page.evaluate(() => history.length)).toBe(beforeInvalid + 1)
    // History entries without a usable ID select root and canonicalize without pushing.
    for (const query of ['?other=keep', '?other=keep&conversation=bad']) {
      await switchTo(page, child)
      const length = await page.evaluate(() => history.length)
      await page.evaluate((search) => {
        history.replaceState(history.state, '', `${search}#anchor`)
        dispatchEvent(new PopStateEvent('popstate'))
      }, query)
      await shown(page, 1)
      expect(await page.evaluate(() => history.length)).toBe(length)
      expect(new URL(page.url()).hash).toBe('#anchor')
    }
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 30000)
