import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { attach, fauxServer, post, skipWithoutChromium, temp, untilInput } from './helpers.ts'

it('remembers hub model and thinking choices and applies them before submitting to an isolated conversation', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-new-composer-')
  const projectRoot = join(userHome, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['canvas'] } }),
  )
  execFileSync('git', ['init', '-b', 'main', projectRoot])
  execFileSync('git', ['-C', projectRoot, 'add', '.'])
  execFileSync('git', [
    '-C',
    projectRoot,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'fixture',
  ])
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
  })
  // Exercise supported thinking choices without calling a paid provider.
  server.vite.config.server.fs.allow.push(resolve('node_modules'))
  server.host.faux!.getModel().reasoning = true
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    await post(server, '/api/ui', { set: { 'shell.surface': 'canvas' } })
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.setDefaultTimeout(10000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await untilInput(page)
    const hub = page.locator('[data-hub]')
    await hub.locator('button[title*="pick a model"]').click()
    await page.locator('[cmdk-item][data-value="faux/faux-1"]').click()
    await hub.locator('button[title*="Thinking level"]').click()
    await page
      .locator('[data-slot="popover-content"]')
      .getByRole('button', { name: 'high', exact: true })
      .click()
    await expect.poll(() => hub.locator('button[title*="Thinking level"]').innerText()).toBe('high')
    const input = page.locator('#canvas-hub-input')
    await input.focus()
    await input.press('Shift+Tab')
    await expect.poll(() => hub.locator('button[title*="Thinking level"]').innerText()).toBe('off')
    await hub.locator('button[title*="Thinking level"]').click()
    await page
      .locator('[data-slot="popover-content"]')
      .getByRole('button', { name: 'high', exact: true })
      .click()
    await page.reload()
    await input.waitFor()
    await untilInput(page)
    await expect.poll(() => hub.innerText()).toContain('high')
    await input.fill('Run the faux demo')
    await expect
      .poll(() =>
        hub.getByRole('button', { name: 'Start the conversation', exact: true }).isDisabled(),
      )
      .toBe(false)
    const submitted = page.waitForRequest((request) => request.url().endsWith('/submit'))
    await input.press('Enter')
    const request = await submitted
    const id = Number(/conversations\/(\d+)\/submit/.exec(request.url())![1])
    const stream = await attach(server, `?conversation=${id}`)
    const view = stream.view()
    await stream.close()
    expect(view.docs['pi.agent']).toMatchObject({
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'high',
    })
    const workspace = await post(server, '/api/extensions/workspaces/actions/info', {
      args: { id },
    })
    expect(workspace.data.result).toMatchObject({ state: 'ready' })
    expect(workspace.data.result.path).not.toBe(projectRoot)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 30000)
