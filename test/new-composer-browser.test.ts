import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  until,
  attach,
  fauxServer,
  post,
  skipWithoutChromium,
  temp,
  untilInput,
} from './helpers.ts'

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
    const submitted = page.waitForResponse((response) =>
      response.url().endsWith('/lineage/actions/branch'),
    )
    await input.press('Enter')
    const request = await submitted
    const id = (await request.json()).result.id
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
    await until(
      async () =>
        (await post(server, '/api/extensions/workspaces/actions/info', { args: { id } })).data
          .result.state === 'ready',
    )
    expect(
      server.api.conversations().find((summary) => summary.id === id)?.branchOf?.conversationId,
    ).toBe(1)
    expect(workspace.data.result.path).not.toBe(projectRoot)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 30000)

it('uses root defaults while another conversation is shown and keeps a thinking-only choice after starting', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-root-composer-')
  const projectRoot = join(userHome, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['canvas'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
  })
  server.vite.config.server.fs.allow.push(resolve('node_modules'))
  server.host.faux!.getModel().reasoning = true
  await post(server, '/api/conversations/1/configure', { thinkingLevel: 'low' })
  const shown = (await post(server, '/api/conversations')).data.id
  await post(server, `/api/conversations/${shown}/configure`, { thinkingLevel: 'off' })
  await post(server, '/api/ui', {
    set: {
      'shell.surface': 'canvas',
      'shell.conversation': shown,
      'ext.conversations.creationType': 'shared',
    },
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.setDefaultTimeout(10000)
    await page.goto(`${server.url}/?conversation=${shown}`)
    const input = page.locator('#canvas-hub-input')
    await input.waitFor()
    await untilInput(page)
    const hub = page.locator('[data-hub]')
    const thinking = hub.locator('button[title*="Thinking level"]')
    await expect.poll(() => thinking.innerText()).toBe('low')
    expect(await hub.locator('button[title*="pick a model"]').innerText()).toBe('faux-1')
    await hub.locator('button[title*="pick a model"]').click()
    expect(
      await page.locator('[cmdk-item][data-value="faux/faux-1"] .text-brand').count(),
    ).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await input.focus()
    await input.press('Shift+Tab')
    await expect.poll(() => thinking.innerText()).toBe('medium')
    expect((await server.host.uiState(context))['ultimate.newConversation']).toEqual({
      thinkingLevel: 'medium',
    })
    for (const message of ['Thinking only', 'Remember thinking']) {
      const submitted = page.waitForResponse((response) =>
        response.url().endsWith('/lineage/actions/branch'),
      )
      await input.fill(message)
      await input.press('Enter')
      const id = (await (await submitted).json()).result.id
      const stream = await attach(server, `?conversation=${id}`)
      expect(stream.view().docs['pi.agent']).toMatchObject({
        model: { provider: 'faux', modelId: 'faux-1' },
        thinkingLevel: 'medium',
      })
      await stream.close()
      await expect.poll(() => input.inputValue()).toBe('')
      await expect.poll(() => thinking.innerText()).toBe('medium')
      expect((await server.host.uiState(context))['ultimate.newConversation']).toEqual({
        thinkingLevel: 'medium',
      })
      await page.reload()
      await page.locator('[data-canvas-map]').waitFor()
      await untilInput(page)
      await page.keyboard.press('Escape')
      await page.locator('[data-canvas-map]').focus()
      await page.keyboard.press('h')
      await input.waitFor()
      await expect.poll(() => thinking.innerText()).toBe('medium')
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 30000)

it('returns login to its explicit picker target, without leaking a dismissed hub target into standalone login', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-picker-target-')
  const projectRoot = join(userHome, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['canvas'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
  })
  server.vite.config.server.fs.allow.push(resolve('node_modules'))
  const runtime = server.host.modelRuntime
  const stub = {
    id: 'stub',
    auth: {
      apiKey: { name: 'Stub', login: async () => ({ key: '' }), resolve: async () => undefined },
    },
  } as unknown as NonNullable<ReturnType<typeof runtime.getProvider>>
  const providers = runtime.getProviders.bind(runtime)
  const provider = runtime.getProvider.bind(runtime)
  vi.spyOn(runtime, 'getProviders').mockImplementation(() => [...providers(), stub])
  vi.spyOn(runtime, 'getProvider').mockImplementation((id) => (id === 'stub' ? stub : provider(id)))
  vi.spyOn(runtime, 'login').mockResolvedValue({ type: 'api_key', key: 'fixture' })
  const shown = (await post(server, '/api/conversations')).data.id
  await post(server, '/api/ui', { set: { 'shell.surface': 'canvas', 'shell.conversation': shown } })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.setDefaultTimeout(10000)
    await page.goto(`${server.url}/?conversation=${shown}`)
    const hub = page.locator('[data-hub]')
    await hub.waitFor()
    await untilInput(page)
    await hub.locator('button[title*="pick a model"]').click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+k')
    await page.getByPlaceholder('Run a command…').fill('auth.login')
    await page.getByRole('option', { name: 'Log in to a provider', exact: true }).click()
    await page.getByPlaceholder('Search providers…').fill('stub')
    await page.getByPlaceholder('Search providers…').press('Enter')
    await page.getByText('Logged in to Stub').waitFor()
    await page.getByRole('button', { name: 'Pick a model', exact: true }).click()
    const configured = page.waitForRequest((request) =>
      request.url().endsWith(`/conversations/${shown}/configure`),
    )
    await page.locator('[cmdk-item][data-value="faux/faux-1"]').click()
    expect((await configured).postDataJSON()).toEqual({
      model: { provider: 'faux', modelId: 'faux-1' },
    })
    expect((await server.host.uiState(context))['ultimate.newConversation']).toBeUndefined()
    // Login entered from the hub picker must instead return to pending choices.
    await hub.locator('button[title*="pick a model"]').click()
    await page.getByRole('option', { name: /Log in to a provider/ }).click()
    await page.getByPlaceholder('Search providers…').fill('stub')
    await page.getByPlaceholder('Search providers…').press('Enter')
    await page.getByText('Logged in to Stub').waitFor()
    await page.getByRole('button', { name: 'Pick a model', exact: true }).click()
    await page.locator('[cmdk-item][data-value="faux/faux-1"]').click()
    await expect
      .poll(async () => (await server.host.uiState(context))['ultimate.newConversation'])
      .toMatchObject({ model: { provider: 'faux', modelId: 'faux-1' } })
  } finally {
    await browser.close()
    await server.close()
  }
}, 30000)
