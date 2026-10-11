import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import type { TestContext } from 'vitest'
import {
  skipWithoutChromium,
  fauxServer as createServer,
  temp as tempDirectory,
  removeTemp,
  untilInput,
} from './helpers.ts'
import { context } from '../server/harness.ts'

const directories: string[] = []
const servers: Awaited<ReturnType<typeof createServer>>[] = []
const browsers: Browser[] = []
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close()
  for (const server of servers.splice(0)) await server.close()
  for (const path of directories.splice(0)) await removeTemp(path)
})
const timeout = { timeout: 15000 }
async function temp() {
  const path = await tempDirectory('ultimate-surfaces-')
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

/** A faux server for `projectRoot` and a headless page; skips the test when no browser is installed. */
async function launch(test: TestContext, projectRoot: string) {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return test.skip()
  const userHome = await temp()
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['surfaces'] } }),
  )
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return { server, page, errors, ui: () => server.host.uiState(context) }
}

/** The prompt's surface line for a top-level conversation (the main one by default), as the agent would see it now. */
function surfaceSection(server: Awaited<ReturnType<typeof createServer>>) {
  const section = server.host.registry.snapshot().extension('surfaces')!.sections![0]
  return (conversationId: number = ROOT_CONVERSATION_ID) =>
    section.render({ conversationId } as unknown as Parameters<typeof section.render>[0], context)
}

it('switches surfaces without interrupting the conversation, and tells the agent', async (test) => {
  const projectRoot = await temp()
  await fixture(projectRoot)
  const { server, page, errors, ui } = await launch(test, projectRoot)
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
  await untilInput(page)
  await expect
    .poll(async () => (await ui())['shell.shownSurface'], timeout)
    .toEqual({
      id: 'agent',
      title: 'Agent',
    })

  let releaseRun!: () => void
  const runGate = new Promise<void>((done) => {
    releaseRun = done
  })
  server.host.registry.install(
    defineExtension({
      name: 'surface-test',
      tools: [
        defineTool({
          name: 'hold_surface_run',
          description: 'Hold the run until the surface switches',
          parameters: Type.Object({}),
          execute: async () => {
            await runGate
            return {}
          },
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('hold_surface_run', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Surface run completed.'),
  ])
  // Wait for submit acknowledgement before unmounting the composer; keep the run busy separately.
  try {
    await page.locator('#composer-input').fill('hello surfaces')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('#composer-input').inputValue(), timeout).toBe('')
    await expect.poll(() => page.title(), timeout).toMatch(/^●/)
    await page.keyboard.press('Control+2')
    await expect.poll(() => page.getByTestId('fixture').count(), timeout).toBe(1)
    expect(await page.title()).toMatch(/Fixture · Ultimate$/)
    await expect.poll(ui, timeout).toMatchObject({
      'shell.surface': 'fixture',
      'shell.shownSurface': { id: 'fixture', title: 'Fixture' },
    })
  } finally {
    releaseRun()
  }
  await idle()
  const dock = page.locator('aside:has([role=separator])')
  await expect.poll(() => dock.getByText('hello surfaces').count(), timeout).toBe(1)
  expect(await dock.locator('#composer-input').inputValue()).toBe('')
  const submitted = await server.root.viewState(context)
  try {
    expect(submitted.value.entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
  } finally {
    submitted.dispose()
  }
  await expect.poll(() => dock.getByText('Surface run completed.').count(), timeout).toBe(1)

  // Server actions render through the surface, including failure notices.
  await expect
    .poll(() => page.getByTestId('item').allTextContents(), timeout)
    .toEqual(['item 1', 'item 2', 'item 3'])
  await expect.poll(() => page.getByTestId('error').textContent(), timeout).toBe('deliberate')
  await expect
    .poll(
      () =>
        page.getByRole('status').filter({ hasText: 'fixture/broken: deliberate' }).textContent(),
      timeout,
    )
    .toContain('fixture/broken: deliberate')

  // The agent's prompt names the persisted surface.
  const render = surfaceSection(server)
  expect(await render(ROOT_CONVERSATION_ID)).toBe(
    'The user is looking at the Fixture surface (fixture).',
  )
  expect(await surfaceLines()).toEqual([
    'The user is looking at the Agent surface (agent).',
    'The user is looking at the Fixture surface (fixture).',
  ])

  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  await page.route(
    '**/api/extensions/fixture/actions/items',
    async (route) => {
      await gate
      await route.continue()
    },
    { times: 1 },
  )
  try {
    await page.reload()
    await expect.poll(() => page.getByTestId('fixture').count(), timeout).toBe(1)
    await expect.poll(() => page.getByTestId('loading').count(), timeout).toBe(1)
  } finally {
    release()
  }
  await expect.poll(() => page.getByTestId('item').count(), timeout).toBe(3)
  await untilInput(page)

  // Another run on the same surface leaves the prompt's surface line alone.
  server.host.faux!.setResponses([fauxAssistantMessage('Another answer.')])
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
    .poll(
      () =>
        page
          .getByRole('status')
          .filter({ hasText: 'The gone surface is not installed, so Agent shows.' })
          .textContent(),
      timeout,
    )
    .toContain('The gone surface is not installed, so Agent shows.')
  expect(errors).toEqual([])
}, 120000)

it('names the surface that shows after one throws, and aborts a manual action call on unmount', async (test) => {
  const projectRoot = await temp()
  const path = join(projectRoot, '.ultimate/extensions/probe')
  await mkdir(path, { recursive: true })
  // `slow` logs to the project root whether it was aborted or ran to the end.
  await writeFile(
    join(path, 'server.ts'),
    `import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
export default defineExtension({ name: 'probe' })
export const actions = {
  slow: async (_args, ctx) => {
    const log = join(ctx.host.projectRoot, 'slow.log')
    await appendFile(log, 'started\\n')
    await new Promise((done) => {
      if (ctx.signal.aborted) done()
      else ctx.signal.addEventListener('abort', () => done(), { once: true })
    })
    await appendFile(log, ctx.signal.aborted ? 'aborted\\n' : 'finished\\n')
    return 'late'
  },
}
`,
  )
  await writeFile(
    join(path, 'web.tsx'),
    `import { FlaskConicalIcon } from 'lucide-react'
import { Header, StatusLine, defineWebExtension, useAction } from '@/sdk'
function Manual() {
  const slow = useAction('probe', 'slow', null, { enabled: false })
  return (
    <>
      <Header />
      <main className="flex-1" data-testid="manual">
        <button onClick={() => void slow.refetch()} type="button">Load</button>
        {slow.loading && <p data-testid="manual-loading">loading</p>}
      </main>
      <StatusLine />
    </>
  )
}
function Broken() {
  throw new Error('deliberate render failure')
}
export default defineWebExtension({
  surfaces: [
    { id: 'manual', title: 'Manual', icon: FlaskConicalIcon, component: Manual },
    { id: 'broken', title: 'Broken', icon: FlaskConicalIcon, component: Broken },
  ],
})
`,
  )
  const { server, page, errors, ui } = await launch(test, projectRoot)
  const log = () => readFile(join(projectRoot, 'slow.log'), 'utf8').catch(() => '')

  await page.goto(server.url)
  await expect.poll(() => page.locator('main #composer-input').count(), timeout).toBe(1)
  await untilInput(page)
  // Agent, Broken, Manual: by title after Agent.
  await page.keyboard.press('Control+3')
  await expect.poll(() => page.getByTestId('manual').count(), timeout).toBe(1)
  await expect
    .poll(async () => (await ui())['shell.shownSurface'], timeout)
    .toEqual({ id: 'manual', title: 'Manual' })

  // A disabled action called by hand is aborted when its surface goes away.
  await page.getByRole('button', { name: 'Load' }).click()
  await expect.poll(log, timeout).toBe('started\n')
  await expect(page.getByTestId('manual-loading').count()).resolves.toBe(1)

  // Broken throws, so Agent shows; the prompt, the title, and the context name Agent, not Broken.
  await page.keyboard.press('Control+2')
  await expect.poll(() => page.getByTestId('manual').count(), timeout).toBe(0)
  await expect.poll(log, timeout).toBe('started\naborted\n')
  await expect.poll(() => page.locator('main #composer-input').count(), timeout).toBe(1)
  await expect
    .poll(
      () =>
        page
          .getByRole('status')
          .filter({
            hasText: 'The Broken surface (probe) failed, so Agent shows: deliberate render failure',
          })
          .textContent(),
      timeout,
    )
    .toContain('The Broken surface (probe) failed, so Agent shows: deliberate render failure')
  await expect
    .poll(async () => (await ui())['shell.shownSurface'], timeout)
    .toEqual({ id: 'agent', title: 'Agent' })
  expect((await ui())['shell.surface']).toBe('broken')
  expect(await surfaceSection(server)()).toBe('The user is looking at the Agent surface (agent).')
  expect(await page.title()).toBe('Ultimate')
  await page.keyboard.press('Control+k')
  await page.keyboard.type('switch to')
  await expect
    .poll(() => page.locator('[cmdk-item]').allTextContents(), timeout)
    .toEqual(['Switch to BrokenCtrl2', 'Switch to ManualCtrl3'])
  expect(errors).toEqual([])
}, 120000)
