import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { expect, it } from 'vitest'
import { defineExtension, defineTask } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { WorkspaceDoc } from '../server/workspaces/doc.ts'
import { git } from '../server/workspaces/worktree.ts'
import { fauxServer, post, skipWithoutChromium, temp, until, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }
const row = (page: Page, id: number) =>
  page.locator(`nav[aria-label="Conversations"] [data-conversation="${id}"]`)

it('opts in without model input, retries the same lost-response receipt, keeps shared reuse and manages every isolated draft safely', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const directory = await temp('ultimate-workspace-browser-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.email', 'test@example.com')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await writeFile(join(projectRoot, 'base.txt'), 'base')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'base')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: directory,
    home: join(directory, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  try {
    const shared = (await post(server, '/api/conversations')).data.id
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const errors: string[] = []
    const requests: { isolate: string; requestId: string }[] = []
    let receivedId = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/api/conversations', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const body = route.request().postDataJSON()
      if (body.isolate !== 'worktree') return route.continue()
      requests.push(body)
      const response = await route.fetch()
      receivedId = (await response.json()).id
      if (requests.length === 1)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Simulated lost creation response' }),
        })
      return route.fulfill({ response })
    })
    await page.goto(server.url)
    await untilInput(page)
    await page.getByRole('button', { name: 'Conversation creation options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'New isolated conversation…', exact: true }).click()
    await page.getByRole('button', { name: 'Create isolated conversation', exact: true }).click()
    await expect
      .poll(() => page.getByRole('alert').textContent(), timeout)
      .toContain('Simulated lost creation response')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.reload()
    await untilInput(page)
    await page.getByRole('button', { name: 'Conversation creation options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'New isolated conversation…', exact: true }).click()
    await page.getByRole('button', { name: 'Create isolated conversation', exact: true }).click()
    await expect
      .poll(
        () => row(page, receivedId).getByRole('button').first().getAttribute('aria-current'),
        timeout,
      )
      .toBe('true')
    expect(requests).toHaveLength(2)
    expect(requests[0].requestId).toBe(requests[1].requestId)
    expect(requests[0].requestId.length).toBeGreaterThan(10)
    await server.host.workspaces.ready(receivedId as ConversationId, context)
    const active = (await server.host.workspaces.info(receivedId as ConversationId, context))!
    await expect
      .poll(() => row(page, receivedId).textContent(), timeout)
      .toContain(`W${receivedId}`)
    expect(await row(page, receivedId).textContent()).not.toContain(active.branch)
    await page.getByRole('button', { name: 'New conversation', exact: true }).click()
    await expect
      .poll(
        () => row(page, shared).getByRole('button').first().getAttribute('aria-current'),
        timeout,
      )
      .toBe('true')
    expect(
      server.api
        .conversations()
        .filter((conversation) => conversation.parentConversationId === undefined),
    ).toHaveLength(3)
    for (const id of [shared, receivedId]) {
      const conversation = await server.harness.conversation(id as ConversationId, context)
      const view = await conversation!.viewState(context)
      expect(
        view.value.entries.filter(
          (entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant',
        ),
      ).toHaveLength(0)
      view.dispose()
    }
    const fixtures: Record<string, number> = {}
    for (const state of ['pending', 'error', 'discarded']) {
      const id = (
        await post(server, '/api/conversations', {
          isolate: 'worktree',
          requestId: `presentation-${state}`,
        })
      ).data.id
      await server.host.workspaces.ready(id, context)
      if (state === 'discarded')
        await post(server, '/api/extensions/workspaces/actions/discard', {
          args: { id, confirm: true },
          conversationId: id,
        })
      else
        await server.harness.commit(async (tx) => {
          const workspace = (await tx.doc(WorkspaceDoc, id)).workspace!
          workspace.preparation = state as 'pending' | 'error'
          if (state === 'error') workspace.error = 'Recorded setup failure for inspection'
        }, context)
      fixtures[state] = id
    }
    for (const id of Object.values(fixtures))
      await expect.poll(() => row(page, id).count(), timeout).toBe(1)
    await row(page, receivedId).getByRole('button').first().click()
    await row(page, receivedId)
      .getByRole('button', { name: 'Conversation actions', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Workspace details', exact: true }).click()
    const panel = page.locator('aside').last()
    const card = page.locator(`[data-workspace="${receivedId}"]`)
    await expect.poll(() => panel.textContent(), timeout).toContain(active.path)
    await page.getByRole('button', { name: `Copy path of W${receivedId}`, exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), timeout)
      .toBe(active.path)
    expect(await panel.textContent()).toContain(active.branch)
    expect(await panel.textContent()).toContain(active.source)
    await page.getByRole('button', { name: `Workspace W${fixtures.pending}`, exact: true }).click()
    expect(await panel.textContent()).toContain('Setting up…')
    await page.getByRole('button', { name: `Workspace W${fixtures.error}`, exact: true }).click()
    expect(await panel.textContent()).toContain('Recorded setup failure for inspection')
    expect(await panel.textContent()).toContain('create a new isolated conversation')
    expect(await panel.textContent()).toContain('Removed')
    // Close presentation fixtures so only the real active workspace's controls are selected below.
    await page.getByRole('button', { name: `Workspace W${fixtures.pending}`, exact: true }).click()
    await page.getByRole('button', { name: `Workspace W${fixtures.error}`, exact: true }).click()
    const holding = defineTask<null, { phase: 'wait' }, null>({
      name: 'workspace-ui-hold',
      version: 1,
      initial: () => ({ phase: 'wait' }),
      phases: {
        wait: async (_task, runtime, caller) => {
          await gate
          await runtime.commit(
            () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
            caller,
          )
        },
      },
      abort: (_task, runtime, caller) =>
        runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
    })
    server.host.registry.install(defineExtension({ name: 'workspace-ui-hold', tasks: [holding] }))
    const task = await server.harness.commit(
      (tx) =>
        tx.createTask(holding, null, {
          conversationId: receivedId as ConversationId,
          ownership: { kind: 'conversation' },
        }),
      context,
    )
    await expect
      .poll(
        () => card.getByRole('button', { name: 'Land verified tip', exact: true }).isDisabled(),
        timeout,
      )
      .toBe(true)
    expect(await panel.textContent()).toContain('Conversation is busy')
    release()
    await server.harness.waitForTask(task, context)
    await expect
      .poll(
        () => card.getByRole('button', { name: 'Land verified tip', exact: true }).isDisabled(),
        timeout,
      )
      .toBe(false)
    await writeFile(join(active.path, 'change.txt'), 'change')
    await card.getByRole('button', { name: 'Remove checkout…', exact: true }).click()
    expect(await panel.textContent()).toContain('branch, commits and conversation history stay')
    await card.getByRole('button', { name: 'Confirm clean-only removal', exact: true }).click()
    await expect
      .poll(() => panel.getByRole('alert').textContent(), timeout)
      .toContain('contains modified or untracked files')
    await git(active.path, 'add', '.')
    await git(active.path, 'commit', '-m', 'workspace change')
    const firstTip = await git(active.path, 'rev-parse', 'HEAD')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await card.getByRole('button', { name: 'Land verified tip', exact: true }).click()
    await expect.poll(() => panel.textContent(), timeout).toContain(firstTip)
    await writeFile(join(active.path, 'later.txt'), 'later')
    await git(active.path, 'add', '.')
    await git(active.path, 'commit', '-m', 'later workspace change')
    await page.getByRole('button', { name: `Refresh W${receivedId}`, exact: true }).click()
    await expect.poll(() => panel.textContent(), timeout).toContain('1 commit ahead')
    expect(await panel.textContent()).toContain('Ready')
    expect(await panel.textContent()).toContain('not a claim that the current tip is applied')
    // Archive and reset do not invoke removal or alter the saved branch tip.
    const laterTip = await git(active.path, 'rev-parse', 'HEAD')
    await row(page, receivedId).hover()
    await row(page, receivedId)
      .getByRole('button', { name: 'Conversation actions', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
    expect(await git(active.path, 'rev-parse', 'HEAD')).toBe(laterTip)
    await post(server, '/api/extensions/conversations/actions/reset', { args: { id: receivedId } })
    expect(await git(active.path, 'rev-parse', 'HEAD')).toBe(laterTip)
    await card.getByRole('button', { name: 'Remove checkout…', exact: true }).click()
    await card.getByRole('button', { name: 'Confirm clean-only removal', exact: true }).click()
    await until(
      async () =>
        (await server.host.workspaces.info(receivedId as ConversationId, context))?.state ===
        'discarded',
    )
    expect(await git(projectRoot, 'rev-parse', active.branch)).toBe(laterTip)
    expect(errors).toEqual([])
  } finally {
    release()
    await browser.close()
    await server.close()
  }
}, 90000)

it.for(['missing', 'false', 'truthy'] as const)(
  'never sends an isolate request when the streamed core capability is %s',
  { timeout: 45000 },
  async (capability, test) => {
    const executablePath = await skipWithoutChromium(test)
    if (!executablePath) return
    const directory = await temp('ultimate-workspace-old-core-browser-')
    const projectRoot = join(directory, 'project')
    await mkdir(projectRoot)
    const server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot,
      userHome: directory,
      home: join(directory, 'state'),
    })
    const browser = await chromium.launch({ executablePath, headless: true })
    try {
      const page = await browser.newPage()
      const isolation: unknown[] = []
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/conversations' &&
          request.postDataJSON()?.isolate
        )
          isolation.push(request.postDataJSON())
      })
      await page.addInitScript(
        `const Original=window.EventSource;window.EventSource=class extends Original {addEventListener(name, listener, options){if(name!=='system')return super.addEventListener(name,listener,options);return super.addEventListener(name,event=>{const value=JSON.parse(event.data);${capability === 'missing' ? 'delete value.execution.workspaces' : `value.execution.workspaces=${capability === 'false' ? 'false' : '1'}`};listener(new MessageEvent('system',{data:JSON.stringify(value)}))},options)}}`,
      )
      await page.goto(server.url)
      await untilInput(page)
      expect(
        await page
          .getByRole('button', { name: 'Conversation creation options', exact: true })
          .count(),
      ).toBe(0)
      await page.evaluate(
        `import('/src/sdk/actions.ts').then(({actions})=>actions.open('conversations.new-isolated'))`,
      )
      await expect
        .poll(
          () =>
            page
              .getByRole('button', { name: 'Create isolated conversation', exact: true })
              .isDisabled(),
          timeout,
        )
        .toBe(true)
      expect(await page.getByRole('alert').textContent()).toContain('Upgrade and restart the core')
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.locator('button[aria-label="New conversation"]').click()
      expect(isolation).toEqual([])
    } finally {
      await browser.close()
      await server.close()
    }
  },
)
