import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { fauxServer, post, skipWithoutChromium, temp, untilInput, until } from './helpers.ts'

const timeout = { timeout: 15000 }

it('branches New from the root, branches at a message, nests the tree and concludes and resumes subtrees', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const directory = await temp('ultimate-tree-browser-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: directory,
    home: join(directory, 'state'),
  })
  server.vite.config.server.fs.allow.push(resolve('node_modules'))
  const route: FauxResponseFactory = () => {
    server.host.faux!.appendResponses([route])
    return fauxAssistantMessage('Ready to continue.')
  }
  server.host.faux!.setResponses([route])
  const anchor = defineTask<null, { phase: 'done' }, null>({
    name: 'tree-fixture',
    version: 1,
    initial: () => ({ phase: 'done' }),
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
    phases: {
      done: (_task, runtime, ctx) =>
        runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        ),
    },
  })
  server.host.registry.install(defineExtension({ name: 'tree-fixture', tasks: [anchor] }))
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await post(server, '/api/ui', { set: { 'ext.conversations.creationType': 'shared' } })
    const root = (await post(server, '/api/conversations')).data.id as number
    await post(server, '/api/extensions/lineage/actions/root', { args: { id: root } })
    const earlier = Number(server.root.id)
    await post(server, '/api/extensions/conversations/actions/rename', {
      args: { id: earlier, title: 'Earlier work' },
    })
    await page.goto(server.url)
    await page.locator('#composer-input').waitFor()
    await untilInput(page)
    const nav = page.getByRole('navigation', { name: 'Conversations', exact: true })
    const row = (id: number) => page.locator(`[data-conversation="${id}"]`)
    const newInput = page.getByPlaceholder('Branch from the root: what do you want to do?')
    const start = async (prompt: string) => {
      const response = page.waitForResponse((candidate) =>
        candidate.url().endsWith('/lineage/actions/branch'),
      )
      await newInput.fill(prompt)
      await newInput.press('Enter')
      const result = await response
      expect(result.status()).toBe(200)
      const id = (await result.json()).result.id as number
      await expect
        .poll(
          () => server.api.conversations().find((summary) => summary.id === id)?.inputAt,
          timeout,
        )
        .toBeDefined()
      await (await server.harness.conversation(id as ConversationId, context))!.waitForIdle(context)
      await untilInput(page)
      return id
    }
    // Even a brand-new root can be branched; no empty draft is created on opening New.
    const before = server.api.conversations().length
    await page.getByLabel('New conversation', { exact: true }).click()
    await newInput.waitFor()
    expect(server.api.conversations()).toHaveLength(before)
    const first = await start('Build the sidebar tree')
    expect(
      server.api.conversations().find((summary) => summary.id === first)?.branchOf?.conversationId,
    ).toBe(root)
    await expect
      .poll(
        () => nav.locator(`[data-branches-of="${root}"] [data-conversation="${first}"]`).count(),
        timeout,
      )
      .toBe(1)
    expect(await row(root).textContent()).toContain('root')
    // Shortcut and palette both open the same pending composer, from the root rather than the shown branch.
    await page.keyboard.press('Control+Alt+n')
    const second = await start('Review the implementation')
    expect(
      server.api.conversations().find((summary) => summary.id === second)?.branchOf?.conversationId,
    ).toBe(root)
    await expect
      .poll(
        () =>
          nav
            .locator('[data-conversation]')
            .evaluateAll((rows) =>
              rows.map((element) => Number(element.getAttribute('data-conversation'))),
            ),
        timeout,
      )
      .toEqual([root, second, first])
    // Hover action targets the stored entry, not the end of the shown conversation.
    await row(first).locator('> button').first().click()
    await untilInput(page)
    const source = await (await server.harness.conversation(
      first as ConversationId,
      context,
    ))!.context(context)
    const entry = source.entries.find((candidate) => candidate.kind === 'pi.user')!
    const message = page
      .getByText('Build the sidebar tree', { exact: true })
      .last()
      .locator('..')
      .locator('..')
    await message.hover()
    const branchButton = message.getByRole('button', { name: 'Branch from here', exact: true })
    await branchButton.click()
    const dialog = page.getByRole('dialog')
    expect(await dialog.textContent()).toContain(`at ${entry.id}`)
    const response = page.waitForResponse((candidate) =>
      candidate.url().endsWith('/lineage/actions/branch'),
    )
    await dialog.getByPlaceholder('What should the branch do?').fill('Polish the tree guides')
    await dialog.getByRole('button', { name: 'Branch', exact: true }).click()
    const nested = (await (await response).json()).result.id as number
    await expect
      .poll(
        () => server.api.conversations().find((summary) => summary.id === nested)?.branchOf,
        timeout,
      )
      .toEqual({ conversationId: first, at: entry.id })
    await expect
      .poll(
        () =>
          nav
            .locator(
              `[data-branches-of="${root}"] [data-branches-of="${first}"] [data-conversation="${nested}"]`,
            )
            .count(),
        timeout,
      )
      .toBe(1)
    await (await server.harness.conversation(nested as ConversationId, context))!.waitForIdle(
      context,
    )
    // Keep real subagent ownership separate from branch ancestry.
    const child = await server.harness.commit(async (tx) => {
      const owner = await tx.createTask(anchor, null, {
        ownership: { kind: 'conversation' },
        conversationId: first as ConversationId,
        background: true,
      })
      const record = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
      Object.assign(await tx.doc(Metadata, record.id), {
        label: 'scout',
        title: 'Checked sidebar spacing',
      })
      return record.id
    }, context)
    server.harness.resume()
    await expect
      .poll(() => page.getByLabel(`Sub-agents of conversation ${first}`).count(), timeout)
      .toBe(1)
    await page.getByLabel(`Sub-agents of conversation ${first}`).click()
    await page.locator(`[data-child-conversation="${child}"]`).waitFor()
    // Earlier is collapsed, separate from the tree.
    expect(await page.getByRole('button', { name: /^Earlier/ }).textContent()).toContain(
      'Earlier · 1',
    )
    expect(await row(earlier).count()).toBe(0)
    const conclude = async (id: number) => {
      await row(id).hover()
      await row(id).getByRole('button', { name: 'Conversation actions' }).click()
      await page.getByRole('menuitem', { name: 'Conclude', exact: true }).click()
    }
    await conclude(first)
    await expect.poll(() => nav.locator(`[data-conversation="${first}"]`).count(), timeout).toBe(0)
    expect(await nav.locator(`[data-conversation="${nested}"]`).count()).toBe(0)
    expect(await nav.locator(`[data-child-conversation="${child}"]`).count()).toBe(0)
    const concluded = page.getByRole('button', { name: /^Concluded/ })
    expect(await concluded.textContent()).toContain('Concluded · 2')
    await page.reload()
    await untilInput(page)
    await concluded.click()
    await row(nested).locator('> button').first().click()
    await untilInput(page)
    await page.locator('#composer-input').fill('Resume the nested branch')
    await page.locator('#composer-input').press('Enter')
    await expect.poll(() => nav.locator(`[data-conversation="${first}"]`).count(), timeout).toBe(1)
    expect(await nav.locator(`[data-conversation="${nested}"]`).count()).toBe(1)
    await until(
      async () =>
        ((await server.host.uiState(context))['ext.conversations.archived'] as number[]).length ===
        0,
    )
    // One concluded branch plus the live root, two branches, nested branch and subagent for visual verification.
    await page.keyboard.press('Control+k')
    await page.getByPlaceholder('Run a command…').fill('New conversation')
    await page.locator('[cmdk-item][data-value="New conversation conversations.new"]').click()
    const finished = await start('Completed experiment')
    await conclude(finished)
    await row(first).locator('> button').first().click()
    await untilInput(page)
    await post(server, '/api/extensions/conversations/actions/rename', {
      args: { id: root, title: 'Project idea' },
    })
    const lander = (await post(server, '/api/conversations')).data.id
    await server.harness.commit(async (tx) => {
      Object.assign(await tx.doc(Metadata, lander), { label: 'lander', title: 'Lander · main' })
    }, context)
    await expect.poll(() => row(lander).count(), timeout).toBe(1)
    await expect.poll(() => row(first).locator('[aria-current]').count(), timeout).toBe(1)
    if (process.env.TREE_SCREENSHOT_DIR) {
      const path = process.env.TREE_SCREENSHOT_DIR
      await mkdir(path, { recursive: true })
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(path, 'sidebar-tree.png'), fullPage: true })
      await message.hover()
      await branchButton.focus()
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(path, 'branch-from-here.png'), fullPage: true })
      await page.getByLabel('New conversation', { exact: true }).click()
      await newInput.waitFor()
      await page.screenshot({ path: join(path, 'new-branch-composer.png'), fullPage: true })
    }
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 60000)

it('keeps a failed branch prompt, guards duplicate sends, and makes the isolated palette command explicit', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const directory = await temp('ultimate-creation-browser-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: directory,
    home: join(directory, 'state'),
  })
  server.vite.config.server.fs.allow.push(resolve('node_modules'))
  const browser = await chromium.launch({ executablePath, headless: true })
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  try {
    await post(server, '/api/ui', { set: { 'ext.conversations.creationType': 'shared' } })
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    const calls: unknown[] = []
    await page.route('**/api/extensions/lineage/actions/branch', async (route) => {
      calls.push(route.request().postDataJSON().args)
      await gate
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: '{"error":"Cannot isolate"}',
      })
    })
    await page.goto(server.url)
    await page.locator('#composer-input').waitFor()
    await untilInput(page)
    await page.keyboard.press('Control+k')
    await page.getByPlaceholder('Run a command…').fill('New isolated conversation')
    await page
      .locator('[cmdk-item][data-value="New isolated conversation conversations.new-isolated"]')
      .click()
    const input = page.getByPlaceholder('Branch from the root: what do you want to do?')
    await input.fill('Keep this intent')
    await input.press('Enter')
    await expect.poll(() => calls.length).toBe(1)
    await input.dispatchEvent('keydown', { key: 'Enter' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ isolated: true, prompt: 'Keep this intent' })
    expect((await server.host.uiState(context))['ext.conversations.creationType']).toBe('shared')
    release()
    await page.getByText('Cannot isolate', { exact: true }).waitFor()
    expect(await input.inputValue()).toBe('Keep this intent')
    await input.press('Enter')
    await expect.poll(() => calls.length).toBe(2)
  } finally {
    release()
    await browser.close()
    await server.close()
  }
}, 30000)
