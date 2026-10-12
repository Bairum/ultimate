import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, post, skipWithoutChromium, temp, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }
// An edge can be a straight vertical or horizontal line: present, though its box has no width or height.
const present = { state: 'attached', timeout: 15000 } as const

it('starts a conversation at the hub and follows its tools, writing, subagent and wait, then opens it and comes back', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-canvas-browser-')
  const project = join(userHome, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(
    join(project, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['canvas', 'subagents'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  server.vite.config.server.fs.allow.push(resolve('node_modules'))
  // The parent's command runs until the test creates `go`; the scout answers when the test releases it.
  const go = join(project, 'go')
  let release!: () => void
  const answered = new Promise<void>((done) => {
    release = done
  })
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (last.role === 'user' && last.content === 'Count the files twice')
      return fauxAssistantMessage(
        [fauxToolCall('bash', { command: `while [ ! -f ${go} ]; do sleep 0.05; done; echo 12` })],
        { stopReason: 'toolUse' },
      )
    if (last.role === 'toolResult' && last.toolName === 'bash')
      return fauxAssistantMessage(
        [
          fauxText('Twelve so far; a scout counts again to be sure.'),
          fauxToolCall('subagent', { action: 'start', agent: 'scout', task: 'Count the files.' }),
        ],
        { stopReason: 'toolUse' },
      )
    if (last.role === 'user' && last.content === 'Count the files.') {
      await answered
      return fauxAssistantMessage('Twelve files.')
    }
    return fauxAssistantMessage('Both counts agree: twelve files.')
  }
  server.host.faux!.setResponses([route])
  await post(server, '/api/ui', { set: { 'shell.surface': 'canvas' } })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await untilInput(page)

    // The hub starts a shared conversation (the Isolated toggle is on by default) and shows it.
    const hub = page.getByRole('textbox', { name: 'Start a conversation' })
    await hub.waitFor(timeout)
    await page.getByRole('button', { name: 'Isolated' }).click()
    await hub.fill('Count the files twice')
    await hub.press('Enter')
    await expect
      .poll(() => server.api.conversations().find((summary) => summary.inputAt)?.id, timeout)
      .toBeDefined()
    const parent = server.api.conversations().find((summary) => summary.inputAt)!.id
    const panel = page.locator(`[data-agent="${parent}"]`)
    await panel.waitFor(timeout)
    await expect
      .poll(() => page.evaluate(() => new URL(location.href).searchParams.get('conversation')))
      .toBe(String(parent))
    // Its panel hangs off the hub.
    await page.getByTestId(`rf__edge-hub-${parent}`).waitFor(present)

    // A running command shows as a chip, then the answer streams in as the writing tail.
    await panel.locator('[data-tool="bash"][data-tool-status="running"]').waitFor(timeout)
    await writeFile(go, '')
    await expect
      .poll(() => panel.locator('[data-tail="writing"]').textContent(), timeout)
      .toContain('a scout counts again')

    // The scout's panel appears, connected to its parent, which waits on it: blue, with the edge flowing.
    await expect
      .poll(
        () => server.api.conversations().find((summary) => summary.label === 'scout')?.id,
        timeout,
      )
      .toBeDefined()
    const child = server.api.conversations().find((summary) => summary.label === 'scout')!.id
    await page.locator(`[data-agent="${child}"]`).waitFor(timeout)
    const edge = page.getByTestId(`rf__edge-${parent}-${child}`)
    await edge.waitFor(present)
    await expect.poll(() => panel.getAttribute('data-status'), timeout).toBe('waiting')
    expect(await panel.getAttribute('class')).toContain('border-sky')
    await edge.locator('[data-edge-flow="waiting"]').waitFor(present)

    // The scout answers: the wait ends, a dot runs back to the parent, and the parent replies; the finished scout
    // shrinks to a pill.
    release()
    await edge.locator('[data-edge-answer]').waitFor(present)
    await expect.poll(() => panel.getAttribute('data-status'), timeout).toBe('replied')
    await edge.locator('[data-edge-flow="waiting"]').waitFor({ state: 'detached', ...timeout })
    await expect
      .poll(() => page.locator(`[data-agent="${child}"]`).getAttribute('data-shape'), timeout)
      .toBe('pill')

    // Enter zooms the selected panel into the real transcript and composer; Escape returns to the map.
    await page.locator('[data-canvas-map]').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('Enter')
    const focused = page.locator('[data-canvas-focus]')
    await focused.waitFor(timeout)
    await focused.getByText('Both counts agree: twelve files.').waitFor(timeout)
    await focused.locator('#composer-input').waitFor(timeout)
    await page.locator('[data-canvas-map]').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('Escape')
    await focused.waitFor({ state: 'detached', ...timeout })
    await panel.locator('[data-tail], [data-summary]').first().waitFor(timeout)
    expect(errors).toEqual([])
  } finally {
    release()
    await browser.close()
    await server.close()
  }
}, 120000)
