import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { expect, it } from 'vitest'
import { defineExtension, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import { git } from '../extensions/workspaces/git.ts'
import { LanderLog } from '../extensions/workspaces/lander.ts'
import { Canvas } from '../extensions/canvas/documents.ts'
import { fauxServer, post, skipWithoutChromium, temp, until, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }
const row = (page: Page, id: number) => page.locator(`[data-conversation="${id}"]`)

it('manages every isolated draft safely without removing checkout history', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const directory = await temp('ultimate-workspace-browser-')
  const projectRoot = join(directory, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['canvas', 'tasks'] } }),
  )
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
  server.vite.config.server.fs.allow.push(resolve('node_modules'))
  const browser = await chromium.launch({ executablePath, headless: true })
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  let releaseShared!: () => void
  const sharedGate = new Promise<void>((done) => {
    releaseShared = done
  })
  try {
    await post(server, '/api/conversations')
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const receivedId = (
      await post(server, '/api/extensions/workspaces/actions/create', { args: {} })
    ).data.result.id
    await post(server, '/api/ui', { set: { 'shell.conversation': receivedId } })
    await page.goto(server.url)
    await untilInput(page)
    await page.getByRole('button', { name: /^Earlier/ }).click()
    const info = async (id: number) =>
      (await post(server, '/api/extensions/workspaces/actions/info', { args: { id } })).data.result
    await until(async () => (await info(receivedId)).state === 'ready')
    const active = await info(receivedId)
    await expect
      .poll(() => row(page, receivedId).textContent(), timeout)
      .toContain(`#${receivedId}`)
    expect((await row(page, receivedId).textContent())?.match(/#\d+/g)).toEqual([`#${receivedId}`])
    expect(await row(page, receivedId).textContent()).not.toContain(`W${receivedId}`)
    expect(await row(page, receivedId).textContent()).not.toContain(active.branch)
    const fixtures: Record<string, number> = {}
    for (const state of ['pending', 'error', 'discarded']) {
      const id = (await post(server, '/api/extensions/workspaces/actions/create', { args: {} }))
        .data.result.id
      await until(async () => (await info(id)).state === 'ready')
      if (state === 'discarded')
        await post(server, '/api/extensions/workspaces/actions/discard', {
          args: { id },
          conversationId: id,
        })
      else
        await server.harness.commit(async (tx) => {
          const workspace = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)]
          workspace.state = state === 'pending' ? 'preparing' : 'failed'
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
    await page.getByRole('button', { name: `Copy path of #${receivedId}`, exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), timeout)
      .toBe(active.path)
    expect(await panel.textContent()).toContain(active.branch)
    expect(await panel.textContent()).toContain(active.source)
    const stats = page.getByRole('region', { name: 'Workspace statistics' })
    await expect.poll(() => stats.textContent(), timeout).toContain('1 removed')
    expect(await stats.textContent()).toContain('1 ready · 1 setting up · 1 failed')
    expect(await page.locator('[data-workspace]').count()).toBe(1)
    const holding = defineTask<'shared' | null, { phase: 'wait' }, null>({
      name: 'workspace-ui-hold',
      version: 1,
      initial: () => ({ phase: 'wait' }),
      phases: {
        wait: async (task, runtime, caller) => {
          await (task.input === 'shared' ? sharedGate : gate)
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
    const conversation = (await server.harness.conversation(receivedId as ConversationId, context))!
    await (
      await conversation.submit({ type: 'input', content: 'Inspect the checkout.' }, context)
    ).wait(context)
    const sharedId = (await post(server, '/api/conversations')).data.id
    const sharedTask = await server.harness.commit(
      (tx) =>
        tx.createTask(holding, 'shared', {
          conversationId: sharedId as ConversationId,
          ownership: { kind: 'conversation' },
        }),
      context,
    )
    const task = await server.harness.commit(
      (tx) =>
        tx.createTask(holding, null, {
          conversationId: receivedId as ConversationId,
          ownership: { kind: 'conversation' },
        }),
      context,
    )
    await expect
      .poll(() => card.getByRole('button', { name: 'Land', exact: true }).isDisabled(), timeout)
      .toBe(true)
    expect(await panel.textContent()).toContain('Conversation is running')
    const snapshot = async (name: string) => {
      if (process.env.CONVERSATION_IDS_SCREENSHOTS) {
        await page
          .getByLabel('Loading Ultimate', { exact: true })
          .waitFor({ state: 'detached', ...timeout })
        // Let the Canvas camera finish its transition before capturing the frame.
        await page.waitForTimeout(600)
        await page.screenshot({
          path: join(process.env.CONVERSATION_IDS_SCREENSHOTS, `${name}.png`),
          fullPage: true,
        })
      }
    }
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    const taskRow = page
      .locator('aside')
      .last()
      .getByRole('button')
      .filter({ hasText: new RegExp(`#(${receivedId}|${sharedId})\\b`) })
    const isolatedRow = taskRow.filter({ hasText: `#${receivedId}` })
    const sharedRow = taskRow.filter({ hasText: `#${sharedId}` })
    await expect.poll(() => taskRow.count(), timeout).toBe(2)
    expect((await isolatedRow.textContent())?.match(/#\d+/g)).toEqual([`#${receivedId}`])
    expect(await isolatedRow.textContent()).not.toContain(`W${receivedId}`)
    expect(await isolatedRow.getByLabel('Isolated checkout').count()).toBe(1)
    expect(await sharedRow.getByLabel('Isolated checkout').count()).toBe(0)
    expect((await sharedRow.textContent())?.match(/#\d+/g)).toEqual([`#${sharedId}`])
    await snapshot('sidebar-task-graph')
    releaseShared()
    await server.harness.waitForTask(sharedTask, context)
    await post(server, '/api/ui', { set: { 'shell.surface': 'canvas' } })
    const canvasAgent = page.locator(`[data-agent="${receivedId}"]`)
    await canvasAgent.waitFor(timeout)
    await canvasAgent.click()
    await page.keyboard.press('Enter')
    await canvasAgent.getByRole('button', { name: `#${receivedId}`, exact: true }).waitFor(timeout)
    const canvasMetadata = canvasAgent
      .getByRole('button', { name: `#${receivedId}`, exact: true })
      .locator('..')
    expect((await canvasMetadata.textContent())?.match(/#\d+/g)).toEqual([`#${receivedId}`])
    expect(await canvasMetadata.textContent()).not.toContain(`W${receivedId}`)
    await snapshot('canvas')
    await canvasAgent.getByRole('button', { name: `#${receivedId}`, exact: true }).click()
    await expect.poll(() => card.count(), timeout).toBe(1)
    const workspaceHeader = card.getByRole('button', {
      name: `Workspace #${receivedId}`,
      exact: true,
    })
    expect((await workspaceHeader.textContent())?.match(/#\d+/g)).toEqual([`#${receivedId}`])
    await post(server, '/api/ui', { set: { 'shell.surface': 'agent' } })
    await snapshot('workspace')
    release()
    await server.harness.waitForTask(task, context)
    // Settled trees retain generated #N reasons, but their own label shares the panel ID.
    const ownReason = `#${receivedId}: 1 commit not landed`
    const otherReason = `#${fixtures.pending}: 2 commits not landed`
    await server.harness.commit(async (tx) => {
      const canvas = await tx.doc(Canvas, ROOT_CONVERSATION_ID)
      canvas.trees[String(receivedId)] = {
        decision: {
          reasons: [
            { kind: 'unlanded', conversationId: receivedId, detail: ownReason },
            { kind: 'unlanded', conversationId: fixtures.pending, detail: otherReason },
            { kind: 'needs_input', conversationId: fixtures.error, detail: 'needs input' },
          ],
        },
      }
    }, context)
    await post(server, '/api/ui', { set: { 'shell.surface': 'canvas' } })
    await expect
      .poll(() => canvasAgent.locator('[data-reason="unlanded"]').allTextContents(), timeout)
      .toEqual(['1 commit not landed', otherReason])
    expect(await canvasAgent.locator('[data-reason="needs_input"]').textContent()).toBe(
      `#${fixtures.error} needs input`,
    )
    expect((await canvasAgent.textContent())?.match(/#\d+/g)).toEqual([
      `#${receivedId}`,
      `#${fixtures.pending}`,
      `#${fixtures.error}`,
    ])
    const recorded = await server.harness.commit(
      async (tx) =>
        (await tx.doc(Canvas, ROOT_CONVERSATION_ID)).trees[String(receivedId)].decision?.reasons[0]
          .detail,
      context,
    )
    expect(recorded).toBe(ownReason)
    await snapshot('canvas-settled-unlanded')
    await canvasAgent.click()
    await page.keyboard.press('Enter')
    await expect.poll(() => canvasMetadata.textContent(), timeout).toContain('1 commit not landed')
    expect((await canvasMetadata.textContent())?.match(/#\d+/g)).toEqual([
      `#${fixtures.pending}`,
      `#${fixtures.error}`,
      `#${receivedId}`,
    ])
    await snapshot('canvas-settled-header')
    await post(server, '/api/ui', { set: { 'shell.surface': 'agent' } })
    await expect
      .poll(() => card.getByRole('button', { name: 'Land', exact: true }).isDisabled(), timeout)
      .toBe(false)
    await writeFile(join(active.path, 'change.txt'), 'change')
    await card.getByRole('button', { name: 'Remove…', exact: true }).click()
    expect(await panel.textContent()).toContain(
      'Remove this checkout? Its branch and commits stay.',
    )
    await card.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect
      .poll(() => panel.getByRole('alert').textContent(), timeout)
      .toContain('contains modified or untracked files')
    await git(active.path, 'add', '.')
    await git(active.path, 'commit', '-m', 'workspace change')
    const firstTip = await git(active.path, 'rev-parse', 'HEAD')
    await card.getByRole('button', { name: 'Land', exact: true }).click()
    await expect.poll(() => panel.textContent(), timeout).toContain('Landed 1 commit.')
    await expect.poll(() => panel.textContent(), timeout).toContain(firstTip.slice(0, 7))
    await snapshot('workspace-landed')
    await writeFile(join(active.path, 'later.txt'), 'later')
    await git(active.path, 'add', '.')
    await git(active.path, 'commit', '-m', 'later workspace change')
    await page.getByRole('button', { name: `Refresh #${receivedId}`, exact: true }).click()
    await expect.poll(() => card.textContent(), timeout).toContain('Ahead1 commit')
    expect(await panel.textContent()).toContain('Ready')
    expect(await panel.textContent()).toContain('Last landed')
    // Archive and reset do not invoke removal or alter the saved branch tip.
    const laterTip = await git(active.path, 'rev-parse', 'HEAD')
    await page.getByRole('button', { name: /^Earlier/ }).click()
    await row(page, receivedId).hover()
    await row(page, receivedId)
      .getByRole('button', { name: 'Conversation actions', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Conclude', exact: true }).click()
    expect(await git(active.path, 'rev-parse', 'HEAD')).toBe(laterTip)
    await post(server, '/api/extensions/conversations/actions/reset', { args: { id: receivedId } })
    expect(await git(active.path, 'rev-parse', 'HEAD')).toBe(laterTip)
    // Archiving showed another conversation, so its card left the panel.
    expect(await card.count()).toBe(0)
    await post(server, '/api/extensions/workspaces/actions/discard', { args: { id: receivedId } })
    await until(async () => (await info(receivedId))?.state === 'removed')
    expect(await git(projectRoot, 'rev-parse', active.branch)).toBe(laterTip)
    await page.goto(`${server.url}/?conversation=1`)
    await untilInput(page)
    await server.harness.commit(
      (tx) =>
        tx.appendEntry(LanderLog, ROOT_CONVERSATION_ID, {
          data: {
            submission: 'Sfixture',
            conversationId: receivedId,
            tip: laterTip,
            target: 'main',
            at: Date.now(),
            step: 'started',
          },
        }),
      context,
    )
    const landingHeader = page
      .locator('.font-mono')
      .filter({ has: page.getByRole('button', { name: `open #${receivedId}`, exact: true }) })
      .last()
    await expect.poll(() => landingHeader.count(), timeout).toBe(1)
    expect((await landingHeader.textContent())?.match(/#\d+/g)).toEqual([`#${receivedId}`])
    expect(await landingHeader.textContent()).not.toContain(`W${receivedId}`)
    await landingHeader.scrollIntoViewIfNeeded()
    await snapshot('landing-started')
    for (const prefix of ['#', 'W'])
      await (
        await server.root.submit(
          {
            type: 'input',
            content: `[lander] Submission S${prefix === '#' ? 'new' : 'historic'} (${prefix}${receivedId}, ${laterTip.slice(0, 7)}) landed as ${laterTip.slice(0, 7)} on main.\nLog: lander conversation #${fixtures.pending}.`,
          },
          context,
        )
      ).wait(context)
    const reports = page.locator('[data-lander-report="landed"]')
    await expect.poll(() => reports.count(), timeout).toBe(2)
    for (const report of await reports.all()) {
      expect(await report.textContent()).not.toContain('[lander] Submission')
      await report.getByRole('button', { name: 'Steps', exact: true }).click()
      expect(
        await report
          .getByRole('button', { name: `full log in #${fixtures.pending}`, exact: true })
          .count(),
      ).toBe(1)
    }
    await snapshot('landing-cards')
    expect(errors).toEqual([])
  } finally {
    releaseShared()
    release()
    await browser.close()
    await server.close()
  }
}, 90000)
