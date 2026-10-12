import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, until, untilInput } from './helpers.ts'
import { Summaries, summaryBehavior } from '../extensions/conversations/summary.ts'
import { Overview } from '../extensions/conversations/overview.ts'
import { Metadata } from '../server/metadata.ts'
import { context } from '../server/harness.ts'

const timeout = { timeout: 15000 }

it('automatically renders a timestamped title action and keeps it after reload', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-title-action-browser-')
  const project = join(userHome, 'project')
  await mkdir(project)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  const title = 'Review <script>alert(1)</script> & sidebar accessibility'
  const existing = server.host.registry.snapshot().extension('conversations')!
  server.host.registry.install(
    defineExtension({
      ...existing,
      ...summaryBehavior(
        {
          harness: () => server.harness,
          metadata: Metadata,
          modelRuntime: {
            getAvailableSnapshot: () =>
              server.host.modelRuntime
                .getModels()
                .filter((model) => model.provider === 'openai' && model.id === 'gpt-6-luna'),
          },
        },
        async () => ({
          assessment: 'done',
          activity: 'Reviewed the sidebar.',
          title,
          summary: 'Reviewed accessibility.',
        }),
      ),
    }),
  )
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await untilInput(page)
    server.host.faux!.setResponses([fauxAssistantMessage('Reviewed the sidebar accessibility.')])
    await (
      await server.root.submit({ type: 'input', content: 'Review the sidebar.' }, context)
    ).wait(context)
    const row = page.getByText(`Title changed to “${title}”`, { exact: true })
    await expect.poll(() => row.count(), timeout).toBe(1)
    const stamp = row.locator('..').locator('time')
    const at = await stamp.getAttribute('datetime')
    expect(Number.isNaN(Date.parse(at!))).toBe(false)
    expect(await stamp.textContent()).not.toBe('')
    expect(await stamp.getAttribute('title')).not.toBe('')
    await page.reload()
    await untilInput(page)
    await expect.poll(() => row.count(), timeout).toBe(1)
    expect(await stamp.getAttribute('datetime')).toBe(at)
    await page.setViewportSize({ width: 480, height: 800 })
    await row.scrollIntoViewIfNeeded()
    expect(await row.locator('..').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
      true,
    )
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 60000)

it('expands real agent roles and outcomes, separates Replied from Luna Done, and uses one index stream', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-agent-tree-browser-')
  const project = join(userHome, 'project')
  await mkdir(project)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const anchor = defineTask<null, { phase: 'done' }, null>({
    name: 'tree-anchor',
    version: 1,
    initial: () => ({ phase: 'done' }),
    phases: {
      done: (_task, runtime, caller) =>
        runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          caller,
        ),
    },
    abort: (_task, runtime, caller) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
  })
  server.host.registry.install(
    defineExtension({
      name: 'tree-test',
      tasks: [anchor],
      tools: [
        defineTool({
          name: 'tree_wait',
          description: 'Wait',
          parameters: Type.Object({}),
          execute: async () => {
            await gate
            return { content: [{ type: 'text', text: 'Released.' }] }
          },
        }),
      ],
    }),
  )
  const existing = server.host.registry.snapshot().extension('conversations')!
  server.host.registry.install(
    defineExtension({
      ...existing,
      ...summaryBehavior(
        {
          harness: () => server.harness,
          metadata: Metadata,
          modelRuntime: {
            getAvailableSnapshot: () =>
              server.host.modelRuntime
                .getModels()
                .filter((model) => model.provider === 'openai' && model.id === 'gpt-6-luna'),
          },
        },
        async (_models, input) => ({
          assessment: input.includes('UNCERTAIN_RESULT')
            ? 'neutral'
            : input.includes('SCOUT_RESULT')
              ? 'needs_input'
              : input.includes('REVIEW_RESULT')
                ? 'neutral'
                : 'done',
          activity: input.includes('SCOUT_RESULT')
            ? 'Compared deployment targets; needs the coordinator to choose.'
            : input.includes('REVIEW_RESULT')
              ? 'Flagged missing evidence without claiming completion.'
              : 'Implemented the sidebar and added regression coverage.',
          title: 'Coordinate the sidebar implementation',
          summary:
            'Implemented the sidebar with focused regression coverage; deployment needs a coordinator decision.',
        }),
      ),
    }),
  )
  server.host.faux!.setResponses([fauxAssistantMessage('ROOT_RESULT')])
  await (
    await server.root.submit({ type: 'input', content: 'Implement the sidebar.' }, context)
  ).wait(context)
  await until(
    async () =>
      (await server.harness.snapshot(Summaries, server.root.id, context))?.assessmentStatus ===
      'ready',
  )
  const children = await server.harness.commit(async (tx) => {
    const result = []
    for (const role of ['scout', 'worker', 'reviewer']) {
      const owner = await tx.createTask(anchor, null, {
        ownership: { kind: 'conversation' },
        conversationId: server.root.id,
        background: true,
      })
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
      Object.assign(await tx.doc(Metadata, child.id), {
        label: role,
        title: `${role} the sidebar change`,
      })
      result.push(child.id)
    }
    return result
  }, context)
  for (const [position, id] of children.entries()) {
    server.host.faux!.setResponses([
      fauxAssistantMessage(['SCOUT_RESULT', 'WORKER_RESULT', 'REVIEW_RESULT'][position]),
    ])
    await (
      await (await server.harness.conversation(id, context))!.submit(
        { type: 'input', content: 'Complete the assigned work.' },
        context,
      )
    ).wait(context)
    await until(
      async () =>
        (await server.harness.snapshot(Summaries, id, context))?.assessmentStatus === 'ready',
    )
  }
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(
      `window.overviewStreams=[]; const Original=window.EventSource; window.EventSource=class extends Original { constructor(url, options) { super(url, options); if(new URL(url,location.href).searchParams.get('docs')==='ultimate.conversation-overview') window.overviewStreams.push(this); } close() { window.overviewStreams=window.overviewStreams.filter(stream=>stream!==this); super.close(); } }`,
    )
    await page.goto(server.url)
    await untilInput(page)
    await page.getByRole('button', { name: 'Agents of conversation 1', exact: true }).click()
    const childRow = (id: number) => page.locator(`[data-child-conversation="${id}"]`)
    const [scout, worker, reviewer] = children
    await expect.poll(() => childRow(scout).textContent(), timeout).toContain('scout')
    expect(await childRow(scout).textContent()).toContain('coordinator to choose')
    expect(
      await childRow(scout)
        .getByRole('img', { name: /May need input \(Luna's opinion, not verified\)/ })
        .count(),
    ).toBe(1)
    expect(await childRow(worker).textContent()).toContain('Replied')
    expect(
      await childRow(worker)
        .getByRole('img', { name: /Done \(Luna's opinion, not verified\)/ })
        .count(),
    ).toBe(1)
    expect(await childRow(reviewer).getByRole('img').count()).toBe(0)
    await childRow(scout).click()
    await expect.poll(() => childRow(scout).getAttribute('aria-current'), timeout).toBe('true')
    await expect
      .poll(
        () =>
          page
            .getByRole('region', { name: 'Conversation summary' })
            .getAttribute('data-summary-conversation'),
        timeout,
      )
      .toBe('1')
    expect(await page.evaluate('window.overviewStreams.length')).toBe(1)
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('tree_wait', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('UNCERTAIN_RESULT'),
    ])
    const work = await (await server.harness.conversation(worker, context))!.submit(
      { type: 'input', content: 'Start new work.' },
      context,
    )
    await expect
      .poll(
        () => childRow(worker).getByRole('img', { name: 'Working', exact: true }).count(),
        timeout,
      )
      .toBe(1)
    expect(
      await childRow(worker)
        .getByRole('img', { name: /Done \(Luna/ })
        .count(),
    ).toBe(0)
    expect(
      await page
        .locator('[data-conversation="1"]')
        .getByRole('img', { name: /Done \(Luna/ })
        .count(),
    ).toBe(0)
    expect(await childRow(worker).locator('.animate-pulse-dot').count()).toBe(1)
    const rootRow = page.locator('[data-conversation="1"]')
    expect(await rootRow.locator('.animate-pulse-dot').count()).toBe(1)
    release()
    expect((await work.wait(context)).status).toBe('done')
    await until(
      async () =>
        (await server.harness.snapshot(Overview, server.root.id, context))?.conversations[worker]
          ?.assessment?.value === 'neutral',
    )
    await expect
      .poll(
        () =>
          childRow(worker)
            .getByRole('img')
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute('aria-label')),
            ),
        timeout,
      )
      .toEqual([])
    await expect.poll(() => rootRow.locator('.animate-pulse-dot').count(), timeout).toBe(0)
    expect(await childRow(worker).locator('.animate-pulse-dot').count()).toBe(0)
    await expect
      .poll(() => rootRow.getByRole('img', { name: /Done \(Luna/ }).count(), timeout)
      .toBe(1)
    server.host.faux!.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'invalid_request_error: deterministic fixture failure',
      }),
    ])
    await (
      await (await server.harness.conversation(reviewer, context))!.submit(
        { type: 'input', content: 'Attempt a failing run.' },
        context,
      )
    ).wait(context)
    await expect.poll(() => childRow(reviewer).textContent(), timeout).toContain('Run failed')
    expect(await childRow(reviewer).getByRole('img').count()).toBe(0)
    await page.getByRole('button', { name: 'Agents of conversation 1', exact: true }).click()
    expect(await childRow(scout).count()).toBe(0)
    await page.reload()
    await untilInput(page)
    expect(await childRow(scout).count()).toBe(0)
    await page.getByRole('button', { name: 'Agents of conversation 1', exact: true }).click()
    await expect.poll(() => childRow(scout).count(), timeout).toBe(1)
    expect(errors).toEqual([])
  } finally {
    release()
    await browser.close()
    await server.close()
  }
}, 120000)

it('lists, creates, marks, archives, renames and clears conversations in the sidebar', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-conversations-browser-')
  const project = join(userHome, 'project')
  await mkdir(project)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  let releaseRun!: () => void
  const runGate = new Promise<void>((done) => {
    releaseRun = done
  })
  server.host.registry.install(
    defineExtension({
      name: 'conversations-test',
      tools: [
        defineTool({
          name: 'hold_run',
          description: 'Hold the run until the test releases it',
          parameters: Type.Object({}),
          execute: async () => {
            await runGate
            return {}
          },
        }),
      ],
    }),
  )
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const calls: string[] = []
    page.on('request', (request) => {
      const action = /\/api\/extensions\/conversations\/actions\/(\w+)$/.exec(request.url())?.[1]
      if (action) calls.push(action)
    })
    const configured: unknown[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/configure')) configured.push(request.postDataJSON())
    })
    const failed: string[] = []
    page.on('response', (response) => {
      if (response.url().endsWith('/configure') && response.status() >= 400)
        failed.push(`${response.status()} ${response.url()}`)
    })
    const sidebar = page.getByRole('navigation', { name: 'Conversations' })
    const rows = sidebar.locator('[data-conversation]')
    const titles = () => rows.locator('.truncate').allTextContents()
    const row = (title: string) => rows.filter({ hasText: title })
    const shown = () =>
      page.locator('[data-conversation]:has([aria-current])').getAttribute('data-conversation')
    const focused = () => page.evaluate(() => document.activeElement?.id)
    const send = async (text: string) => {
      await page.locator('#composer-input').fill(text)
      await page.keyboard.press('Enter')
      await expect.poll(() => page.locator('#composer-input').inputValue(), timeout).toBe('')
    }

    // After a turn, the main conversation is listed under its first message.
    await page.goto(server.url)
    await page.locator('#composer-input').waitFor(timeout)
    await untilInput(page)
    server.host.faux!.setResponses([fauxAssistantMessage('First answer.')])
    await send('first message')
    await expect.poll(titles, timeout).toEqual(['first message'])

    // New conversation shows an empty draft, configured with the shown one's model, listed first, the composer focused.
    const { model } = await server.root.agent(context)
    await page.getByRole('button', { name: 'New conversation' }).click()
    await expect.poll(titles, timeout).toEqual(['New conversation', 'first message'])
    await expect.poll(shown, timeout).not.toBe('1')
    const draft = await shown()
    await expect.poll(focused, timeout).toBe('composer-input')
    await expect.poll(() => configured, timeout).toEqual([expect.objectContaining({ model })])
    expect(failed).toEqual([])

    // From the main conversation, the shortcut reuses that draft instead of creating another.
    await row('first message').locator('> button').first().click()
    await expect.poll(shown, timeout).toBe('1')
    await page.keyboard.press('Control+Alt+n')
    await expect.poll(shown, timeout).toBe(draft)
    await expect.poll(focused, timeout).toBe('composer-input')
    expect(await titles()).toEqual(['New conversation', 'first message'])

    // Sending titles the draft's row and lists it first; it shows working while it runs, also when not shown.
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('hold_run', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Second answer.'),
    ])
    try {
      await send('second message')
      await expect.poll(titles, timeout).toEqual(['second message', 'first message'])
      const second = row('second message')
      await expect.poll(() => second.getByRole('img', { name: 'Working' }).count(), timeout).toBe(1)
      await row('first message').locator('> button').first().click()
      await expect.poll(shown, timeout).toBe('1')
      expect(await second.getByRole('img', { name: 'Working' }).count()).toBe(1)
    } finally {
      releaseRun()
    }

    // Its answer arrived while another was shown: marked until looked at.
    const second = row('second message')
    await expect
      .poll(() => second.getByRole('img', { name: 'New answer' }).count(), timeout)
      .toBe(1)
    await second.locator('> button').first().click()
    await expect.poll(() => second.getByRole('img').count(), timeout).toBe(0)

    // Archiving moves a row into the collapsed Archived group, which survives a reload.
    const first = row('first message')
    await first.hover()
    await first.getByRole('button', { name: 'Conversation actions' }).click()
    await page.getByRole('menuitem', { name: 'Archive' }).click()
    await expect.poll(titles, timeout).toEqual(['second message'])
    const archived = page.getByRole('button', { name: /^Archived/ })
    await expect.poll(() => archived.textContent(), timeout).toBe('Archived · 1')
    await page.reload()
    await expect.poll(() => archived.textContent(), timeout).toBe('Archived · 1')
    await untilInput(page)
    expect(await titles()).toEqual(['second message'])
    await archived.click()
    await expect
      .poll(
        () => page.getByRole('region', { name: 'Archived' }).locator('.truncate').allTextContents(),
        timeout,
      )
      .toEqual(['first message'])

    // Renaming a row that is not shown saves on Enter and keeps the shown conversation.
    const hiddenRow = page.getByRole('region', { name: 'Archived' }).locator('[data-conversation]')
    await hiddenRow.hover()
    await hiddenRow.getByRole('button', { name: 'Conversation actions' }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const input = page.getByRole('textbox', { name: 'Conversation title' })
    await expect.poll(() => input.inputValue(), timeout).toBe('first message')
    await input.fill('Earlier work')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => hiddenRow.locator('.truncate').textContent(), timeout)
      .toBe('Earlier work')
    expect(await shown()).toBe(draft)

    // Rename from the menu: Enter saves, and the row and the header trail show the new title.
    const renamed = rows.first()
    await renamed.hover()
    await renamed.getByRole('button', { name: 'Conversation actions' }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    await expect.poll(() => input.inputValue(), timeout).toBe('second message')
    await input.fill('Sidebar work')
    await page.keyboard.press('Enter')
    await expect.poll(titles, timeout).toEqual(['Sidebar work'])
    const trail = page.locator('header').getByText('Sidebar work', { exact: true })
    await expect.poll(() => trail.count(), timeout).toBe(1)
    const rowFocused = () =>
      renamed
        .locator('> button')
        .first()
        .evaluate((element) => element === document.activeElement)
    await expect.poll(rowFocused, timeout).toBe(true)

    // A double-click edits too; Escape cancels without a request, and focus returns to the row.
    await renamed.locator('.truncate').dblclick()
    await input.fill('Discarded')
    await page.keyboard.press('Escape')
    await expect.poll(() => input.count(), timeout).toBe(0)
    await expect.poll(rowFocused, timeout).toBe(true)
    expect(await titles()).toEqual(['Sidebar work'])

    // Clear context asks first; the transcript then shows the reset, and the row keeps its title and place.
    await renamed.hover()
    await renamed.getByRole('button', { name: 'Conversation actions' }).click()
    await page.getByRole('menuitem', { name: 'Clear context…' }).click()
    const dialog = page.getByRole('dialog')
    await expect
      .poll(() => dialog.textContent(), timeout)
      .toContain('Clear the context of Sidebar work? The agent starts fresh')
    await dialog.getByRole('button', { name: 'Clear context' }).click()
    await expect.poll(() => dialog.count(), timeout).toBe(0)
    await expect
      .poll(() => page.locator('main').getByText('context reset').count(), timeout)
      .toBe(1)
    expect(await titles()).toEqual(['Sidebar work'])
    expect(await trail.count()).toBe(1)
    expect(calls).toEqual(['rename', 'rename', 'reset'])
    expect(failed).toEqual([])
    expect(errors).toEqual([])
  } finally {
    releaseRun()
    await browser.close()
    await server.close()
  }
}, 120000)
