import { join, resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterEach, expect, it, vi } from 'vitest'
import type { TestContext } from 'vitest'
import {
  fauxServer,
  post,
  skipWithoutChromium,
  temp as tempDirectory,
  removeTemp,
  untilInput,
} from './helpers.ts'
import { Logins } from '../extensions/models/server.ts'
import { context } from '../server/harness.ts'

const directories: string[] = []
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
const browsers: Browser[] = []
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close()
  for (const server of servers.splice(0)) await server.close()
  for (const path of directories.splice(0)) await removeTemp(path)
})
const timeout = { timeout: 15000 }

/** A faux server with a stub API-key provider whose login waits for a key, and a headless browser. */
async function launch(test: TestContext) {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return test.skip()
  const userHome = await tempDirectory('ultimate-login-')
  directories.push(userHome)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    userHome,
    home: join(userHome, 'state'),
  })
  servers.push(server)
  const runtime = server.host.modelRuntime
  const stub = {
    id: 'stub',
    auth: {
      apiKey: { name: 'Stub', login: async () => ({ key: '' }), resolve: async () => undefined },
    },
  } as unknown as NonNullable<ReturnType<typeof runtime.getProvider>>
  const providers = runtime.getProviders.bind(runtime)
  const provider = runtime.getProvider.bind(runtime)
  const status = runtime.getProviderAuthStatus.bind(runtime)
  let configured = false
  const aborted: boolean[] = []
  vi.spyOn(runtime, 'getProviders').mockImplementation(() => [...providers(), stub])
  vi.spyOn(runtime, 'getProvider').mockImplementation((id) => (id === 'stub' ? stub : provider(id)))
  vi.spyOn(runtime, 'getProviderAuthStatus').mockImplementation((id) =>
    id !== 'stub' ? status(id) : configured ? { configured, source: 'stored' } : { configured },
  )
  vi.spyOn(runtime, 'login').mockImplementation(async (_provider, _type, interaction) => {
    interaction.notify({ type: 'info', message: 'Stub login' })
    try {
      const key = await interaction.prompt({ type: 'secret', message: 'Enter key' })
      configured = true
      return { type: 'api_key', key }
    } finally {
      aborted.push(interaction.signal?.aborted ?? false)
    }
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  browsers.push(browser)
  const errors: string[] = []
  /** A tab showing the conversation, with the login dialog's provider list open on the stub. */
  async function tab() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await expect.poll(() => page.locator('main #composer-input').count(), timeout).toBe(1)
    await untilInput(page)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('Log in to a provider')
    await page.keyboard.press('Enter')
    await page.getByPlaceholder('Search providers…').fill('stub')
    await expect
      .poll(() => page.getByRole('dialog').getByText('Stub', { exact: true }).count(), timeout)
      .toBe(1)
    return page
  }
  /** Choose the stub in `page`'s dialog and wait for its key prompt. */
  async function start(page: Page) {
    await page.getByPlaceholder('Search providers…').press('Enter')
    await expect.poll(() => page.locator('#login-answer').count(), timeout).toBe(1)
  }
  return { server, tab, start, aborted, errors }
}

it('closes the login dialog and cancels its flow when the tab shows another conversation', async (test) => {
  const { server, tab, start, aborted, errors } = await launch(test)
  const flows = async (id: number) =>
    Object.values(
      (await server.harness.snapshot(Logins, id as ConversationId, context))?.flows ?? {},
    )
  const page = await tab()
  await start(page)
  expect(await flows(ROOT_CONVERSATION_ID)).toMatchObject([{ provider: 'stub', status: 'running' }])

  // Any tab may switch the shown conversation; the flow's document stays on the first one.
  const other = Number((await post(server, '/api/conversations', {})).data.id)
  expect((await post(server, '/api/ui', { set: { 'shell.conversation': other } })).status).toBe(200)
  await expect.poll(() => page.getByRole('dialog').count(), timeout).toBe(0)
  await expect
    .poll(() => flows(ROOT_CONVERSATION_ID), timeout)
    .toMatchObject([{ provider: 'stub', status: 'cancel' }])
  expect(aborted).toEqual([true])
  expect(await flows(other)).toEqual([])
  expect(errors).toEqual([])
}, 120000)
