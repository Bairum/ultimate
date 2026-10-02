import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../extensions/browser/server.ts'
import { context } from '../server/harness.ts'
import { createServer } from '../server/main.ts'

const directories: string[] = []
const servers: Awaited<ReturnType<typeof createServer>>[] = []
const browsers: Browser[] = []
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close()
  for (const server of servers.splice(0)) await server.close()
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true, maxRetries: 5 })
})
const timeout = { timeout: 15000 }
async function temp() {
  const path = await mkdtemp(join(tmpdir(), 'ultimate-surfaces-'))
  directories.push(path)
  return path
}

/** A test-only app surface in the project's `.ultimate/`: action data, a failing action, the agent docked. */
async function fixture(projectRoot: string) {
  const path = join(projectRoot, '.ultimate/extensions/fixture')
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'server.ts'),
    `import { defineExtension } from '@earendil-works/pi-durable'
export default defineExtension({ name: 'fixture' })
export const actions = {
  items: async (args) => {
    await new Promise((done) => setTimeout(done, 600))
    return Array.from({ length: args.count }, (_, index) => 'item ' + (index + 1))
  },
  broken: async () => {
    throw new Error('deliberate')
  },
}
`,
  )
  await writeFile(
    join(path, 'web.tsx'),
    `import { FlaskConicalIcon } from 'lucide-react'
import { Conversation, Dock, Header, StatusLine, defineWebExtension, useAction } from '@/sdk'
function Fixture() {
  const items = useAction<string[]>('fixture', 'items', { count: 3 })
  const broken = useAction('fixture', 'broken')
  return (
    <>
      <Header />
      <div className="flex min-h-0 flex-1">
        <main className="flex-1" data-testid="fixture">
          {items.loading && <p data-testid="loading">loading</p>}
          {items.data?.map((item) => <p data-testid="item" key={item}>{item}</p>)}
          {broken.error && <p data-testid="error">{broken.error.message}</p>}
        </main>
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </>
  )
}
export default defineWebExtension({
  surfaces: [{ id: 'fixture', title: 'Fixture', icon: FlaskConicalIcon, description: 'A test surface', component: Fixture }],
})
`,
  )
}

it('switches surfaces without interrupting the conversation, and tells the agent', async (test) => {
  let executablePath: string
  try {
    executablePath = await browserBinary()
  } catch (error) {
    console.warn(`Skipping browser integration: ${String(error)}`)
    test.skip()
    return
  }
  const projectRoot = await temp()
  const userHome = await temp()
  await fixture(projectRoot)
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: true,
    port: 0,
  })
  servers.push(server)
  const browser = await chromium.launch({ executablePath, headless: true })
  browsers.push(browser)
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const ui = () => server.host.uiState(context)
  /** The surface lines of the system prompt, in the order the conversation saw them change. */
  async function surfaceLines() {
    const view = await server.root.viewState(context)
    try {
      return view.value.entries.flatMap((entry) => {
        const message = entry.kind === 'pi.system' ? entry.model?.[0] : undefined
        const line = message?.role === 'system' ? message.sections?.surface : undefined
        return typeof line === 'string' ? [line.replace(/<\/?surface>/g, '').trim()] : []
      })
    } finally {
      view.dispose()
    }
  }
  const idle = async () => {
    await expect.poll(() => page.title(), timeout).not.toMatch(/^●/)
  }

  await page.goto(server.url)
  await expect.poll(() => page.locator('main #composer-input').count(), timeout).toBe(1)
  await expect
    .poll(async () => (await ui())['shell.shownSurface'], timeout)
    .toEqual({
      id: 'agent',
      title: 'Agent',
    })

  // A run started on Agent keeps going while the user switches to the fixture surface.
  await page.locator('#composer-input').fill('hello surfaces')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.title(), timeout).toMatch(/^●/)
  await page.keyboard.press('Control+2')
  await expect.poll(() => page.getByTestId('fixture').count(), timeout).toBe(1)
  expect(await page.title()).toMatch(/Fixture · Ultimate$/)
  await idle()
  const dock = page.locator('aside:has([role=separator])')
  await expect.poll(() => dock.getByText('hello surfaces').count(), timeout).toBe(1)
  await expect.poll(() => dock.getByText('The scratch file was updated.').count(), timeout).toBe(1)

  // useAction: loading, then data; a failing action has an error and a notice.
  await expect
    .poll(() => page.getByTestId('item').allTextContents(), timeout)
    .toEqual(['item 1', 'item 2', 'item 3'])
  await expect
    .poll(() => page.getByTestId('error').textContent(), timeout)
    .toBe('Extension action failed')
  await expect
    .poll(() => page.getByRole('status').textContent(), timeout)
    .toContain('fixture/broken: Extension action failed')

  // The choice is durable, and the agent's prompt names the surface.
  expect(await ui()).toMatchObject({
    'shell.surface': 'fixture',
    'shell.shownSurface': { id: 'fixture', title: 'Fixture' },
  })
  const section = server.host.registry.snapshot().extension('surfaces')!.sections![0]
  const render = (conversationId: number) =>
    section.render({ conversationId } as unknown as Parameters<typeof section.render>[0], context)
  expect(await render(ROOT_CONVERSATION_ID)).toBe(
    'The user is looking at the Fixture surface (fixture).',
  )
  expect(await render(ROOT_CONVERSATION_ID + 1)).toBeUndefined()
  expect(await surfaceLines()).toEqual([
    'The user is looking at the Agent surface (agent).',
    'The user is looking at the Fixture surface (fixture).',
  ])

  await page.reload()
  await expect.poll(() => page.getByTestId('fixture').count(), timeout).toBe(1)
  await expect.poll(() => page.getByTestId('loading').count(), timeout).toBe(1)
  await expect.poll(() => page.getByTestId('item').count(), timeout).toBe(3)

  // Another run on the same surface leaves the prompt's surface line alone.
  await page.locator('#composer-input').fill('second run')
  await page.keyboard.press('Enter')
  await expect.poll(() => dock.getByText('second run').count(), timeout).toBe(1)
  await idle()
  expect(await surfaceLines()).toHaveLength(2)

  // Back to Agent through the switcher: the transcript is all there.
  await page.locator('header button[title="Switch surface"]').click()
  await expect(page.locator('[role=menuitem]').allTextContents()).resolves.toEqual([
    'AgentThe conversation, with panels beside itCtrl1',
    'FixtureA test surfaceCtrl2',
  ])
  await page.locator('[role=menuitem][data-surface=agent]').click()
  await expect.poll(() => page.getByTestId('fixture').count(), timeout).toBe(0)
  await expect.poll(() => page.locator('main').getByText('hello surfaces').count(), timeout).toBe(1)
  expect(await page.locator('main').getByText('second run').count()).toBe(1)
  await expect.poll(async () => (await ui())['shell.surface'], timeout).toBe('agent')

  // ⌘K lists the other surface, not the shown one.
  await page.keyboard.press('Control+k')
  await page.keyboard.type('switch to')
  await expect
    .poll(() => page.locator('[cmdk-item]').allTextContents(), timeout)
    .toEqual(['Switch to FixtureCtrl2'])
  await page.keyboard.press('Enter')
  await expect.poll(() => page.getByTestId('fixture').count(), timeout).toBe(1)
  await expect.poll(async () => (await ui())['shell.surface'], timeout).toBe('fixture')

  // A chosen surface that is gone falls back to Agent with a notice.
  await fetch(server.url + '/api/ui', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: server.url },
    body: JSON.stringify({ set: { 'shell.surface': 'gone' } }),
  })
  await expect.poll(() => page.locator('main #composer-input').count(), timeout).toBe(1)
  await expect
    .poll(() => page.getByRole('status').textContent(), timeout)
    .toContain('The gone surface is not installed, so Agent shows.')
  expect(errors).toEqual([])
}, 120000)
