import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, untilInput } from './helpers.ts'
import { context } from '../server/harness.ts'
import { Subagents } from '../extensions/subagents/server.ts'

it(
  'renders attributed Markdown, leaves human lookalikes alone, and navigates source and return',
  async (test) => {
    const executablePath = await skipWithoutChromium(test)
    if (!executablePath) return
    const userHome = await temp('ultimate-agent-messages-browser-')
    const project = join(userHome, 'project')
    await mkdir(join(project, '.ultimate'), { recursive: true })
    await writeFile(
      join(project, '.ultimate/settings.json'),
      JSON.stringify({ extensions: { enable: ['subagents', 'workspaces'] } }),
    )
    const server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot: project,
      userHome,
      home: join(userHome, 'state'),
    })
    // The linked font resolves outside the copied fixture root; explicitly allow this test's dependencies.
    server.vite.config.server.fs.allow.push(resolve('node_modules'))
    const markdown =
      '**Verified result**\n\n- First item\n- Second item\n\n- [x] Checked\n\n```ts\nconst result = 42\n```\n\n' +
      'A long report stays readable. '.repeat(250)
    const route: FauxResponseFactory = (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      if (last.role === 'user' && (last.content === 'delegate' || last.content === 'foreground'))
        return fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              action: 'start',
              agent: 'scout',
              task: '**Inspect task**\n\n- [x] Read the files',
              background: last.content === 'delegate',
            }),
          ],
          { stopReason: 'toolUse' },
        )
      if (
        last.role === 'user' &&
        typeof last.content === 'string' &&
        last.content.startsWith('**Inspect')
      )
        return fauxAssistantMessage(markdown)
      return fauxAssistantMessage('Received.')
    }
    server.host.faux!.setResponses([route])
    const browser = await chromium.launch({ executablePath, headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      const errors: string[] = []
      const queries: unknown[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => {
        if (request.url().endsWith('/subagents/actions/provenance'))
          queries.push(request.postDataJSON())
      })
      await page.goto(server.url)
      await untilInput(page)
      await (
        await server.root.submit({ type: 'input', content: 'delegate' }, context)
      ).wait(context)
      const report = page.locator('[data-agent-origin="report"]')
      await report.waitFor({ timeout: 10000 })
      expect(await report.locator('[data-streamdown="strong"]').textContent()).toBe(
        'Verified result',
      )
      expect(await report.locator('li').count()).toBe(3)
      expect(await report.locator('input[type="checkbox"]').isChecked()).toBe(true)
      expect(await report.locator('code').textContent()).toContain('const result = 42')
      expect(await report.textContent()).not.toContain('[subagent')
      const [child] = Object.values(
        (await server.harness.snapshot(Subagents, server.root.id, context))!.agents,
      )
      expect(await report.locator('header').textContent()).toContain(`#${child.conversationId}`)
      await report.getByRole('button', { name: 'source', exact: true }).click()
      const instruction = page.locator('[data-agent-origin="instruction"]')
      await instruction.waitFor()
      expect(await instruction.locator('[data-streamdown="strong"]').textContent()).toBe(
        'Inspect task',
      )
      expect(await instruction.locator('header').textContent()).toContain('#1')
      await page.getByRole('button', { name: 'return #1', exact: true }).click()
      await report.waitFor()
      const position = await report.boundingBox()
      expect(position!.y).toBeLessThan(900)
      await (
        await server.root.submit(
          {
            type: 'input',
            content: `[subagent ${child.conversationId} (scout) answered] **Human text**`,
          },
          context,
        )
      ).wait(context)
      const human = page.getByText(
        `[subagent ${child.conversationId} (scout) answered] **Human text**`,
        { exact: true },
      )
      await human.waitFor()
      expect(await human.locator('xpath=ancestor::*[@data-agent-origin]').count()).toBe(0)
      expect(await page.locator('[data-agent-origin="report"]').count()).toBe(1)
      await (
        await server.root.submit({ type: 'input', content: 'foreground' }, context)
      ).wait(context)
      const foreground = Object.values(
        (await server.harness.snapshot(Subagents, server.root.id, context))!.actions,
      ).at(-1)!
      const open = page.getByRole('button', {
        name: `open #${foreground.conversationId}`,
        exact: true,
      })
      await open.waitFor()
      const receiver = await open.evaluate((element) =>
        element.closest('[data-entry-id]')!.getAttribute('data-entry-id'),
      )
      await open.click()
      const answer = page.locator(`[data-entry-id="${foreground.answer}"]`)
      await answer.waitFor()
      await expect
        .poll(async () => {
          const box = await answer.boundingBox()
          return !!box && box.y >= 0 && box.y < 900
        })
        .toBe(true)
      await page.waitForTimeout(250)
      expect((await answer.boundingBox())!.y).toBeGreaterThanOrEqual(0)
      await page.getByRole('button', { name: 'return #1', exact: true }).click()
      await open.waitFor()
      await expect
        .poll(async () => {
          const box = await page.locator(`[data-entry-id="${receiver}"]`).boundingBox()
          return !!box && box.y >= 0 && box.y < 900
        })
        .toBe(true)
      await report.getByRole('button', { name: 'Expand full message' }).click()
      expect(await report.getByRole('button', { name: 'Compact view' }).count()).toBe(1)
      await report.getByRole('button', { name: 'Compact view' }).click()
      const settledQueries = queries.length
      await page.waitForTimeout(300)
      expect(queries.length).toBe(settledQueries)
      expect(errors).toEqual([])
      if (process.env.AGENT_MESSAGES_SCREENSHOT || process.env.AGENT_MESSAGES_PREVIEW_MS) {
        await report.scrollIntoViewIfNeeded()
        await report.evaluate((element) => element.scrollIntoView({ block: 'start' }))
        if (process.env.AGENT_MESSAGES_SCREENSHOT)
          await page.screenshot({
            path: process.env.AGENT_MESSAGES_SCREENSHOT,
            fullPage: true,
          })
        if (process.env.AGENT_MESSAGES_PREVIEW_MS) {
          console.log(`Agent message preview: ${server.url}`)
          await page.waitForTimeout(Number(process.env.AGENT_MESSAGES_PREVIEW_MS))
        }
      }
    } finally {
      await browser.close()
      await server.close()
    }
  },
  30000 + Number(process.env.AGENT_MESSAGES_PREVIEW_MS ?? 0),
)
