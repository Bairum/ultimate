import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, untilInput } from './helpers.ts'
import { projectDecision } from '../server/project-setup.ts'

const timeout = { timeout: 15000 }

/** A project whose setup has an explainer, an agent, and a folder in place of the built-in codemode. */
async function projectWithSetup(userHome: string) {
  const project = join(userHome, 'project')
  await mkdir(join(project, '.ultimate/extensions/codemode'), { recursive: true })
  await mkdir(join(project, '.ultimate/agents'), { recursive: true })
  await writeFile(join(project, '.ultimate/README.md'), 'Project setup for the browser test.')
  await writeFile(
    join(project, '.ultimate/agents/reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews\n---\nReview.',
  )
  await writeFile(
    join(project, '.ultimate/extensions/codemode/README.md'),
    '# codemode\n\nThe project codemode.',
  )
  return project
}

/** Open the Extensions panel from the palette. */
async function openExtensions(page: Page) {
  await page.keyboard.press('Control+k')
  await page.keyboard.type('Extensions…')
  await page.keyboard.press('Enter')
}

/**
 * No provider is logged in, whatever this machine's Pi has, until the stub's API-key login completes; `configured`
 * tells whether it has.
 */
function stubLogins(server: Awaited<ReturnType<typeof fauxServer>>) {
  const runtime = server.host.modelRuntime
  const stub = {
    id: 'stub',
    auth: {
      apiKey: { name: 'Stub', login: async () => ({ key: '' }), resolve: async () => undefined },
    },
  } as unknown as NonNullable<ReturnType<typeof runtime.getProvider>>
  const providers = runtime.getProviders.bind(runtime)
  const provider = runtime.getProvider.bind(runtime)
  let configured = false
  vi.spyOn(runtime, 'getProviders').mockImplementation(() => [...providers(), stub])
  vi.spyOn(runtime, 'getProvider').mockImplementation((id) => (id === 'stub' ? stub : provider(id)))
  vi.spyOn(runtime, 'getProviderAuthStatus').mockImplementation((id) =>
    id === 'stub' && configured ? { configured, source: 'stored' } : { configured: false },
  )
  vi.spyOn(runtime, 'login').mockImplementation(async (_provider, _type, interaction) => {
    const key = await interaction.prompt({ type: 'secret', message: 'Enter key' })
    configured = true
    return { type: 'api_key', key }
  })
  return { configured: () => configured }
}

it('first run: page 1 waits for a live login, page 2 applies the extensions and the project choice', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-onboarding-browser-')
  const project = await projectWithSetup(userHome)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
    localSetup: false,
    firstRun: true,
  })
  const logins = stubLogins(server)
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const dialog = page.getByRole('dialog')
    const onboarding = dialog.filter({ hasText: 'ULTIMATE' })
    const proceed = onboarding.getByRole('button', { name: 'Continue' })
    // As on a machine without the demo provider: the faux model is not available until a login.
    await page.route('**/api/models', async (route) => {
      const response = await route.fetch()
      const models = (await response.json()) as { models: { available: boolean }[] }
      if (!logins.configured()) for (const model of models.models) model.available = false
      await route.fulfill({ response, json: models })
    })
    await page.goto(server.url)

    // Page 1: neither a provider nor an available model, so Continue waits.
    await expect.poll(() => onboarding.getByText('Get ready').count(), timeout).toBe(1)
    await untilInput(page)
    await expect
      .poll(
        () => onboarding.getByText('A subscription or API key, shared with Pi').count(),
        timeout,
      )
      .toBe(1)
    expect(await onboarding.getByText('faux-1 · needs its provider').count()).toBe(1)
    expect(await proceed.isDisabled()).toBe(true)

    // Logging in through the models login dialog checks the row live, and focus moves on to Continue.
    await onboarding.getByRole('button', { name: 'Connect' }).click()
    await page.getByPlaceholder('Search providers…').fill('stub')
    await page.getByPlaceholder('Search providers…').press('Enter')
    await expect.poll(() => page.locator('#login-answer').count(), timeout).toBe(1)
    await page.locator('#login-answer').fill('not-a-real-key')
    await page.locator('#login-answer').press('Enter')
    await expect.poll(() => page.getByText('Logged in to Stub').count(), timeout).toBe(1)
    // The login dialog hides the page from role queries while it is open.
    await page.getByRole('button', { name: 'Done' }).click()
    // Both rows check live: the provider, and its model now available.
    await expect.poll(() => onboarding.getByText('Connected · Stub').count(), timeout).toBe(1)
    await expect.poll(() => onboarding.getByText('needs its provider').count(), timeout).toBe(0)
    expect(await proceed.isDisabled()).toBe(false)
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent), timeout)
      .toBe('Continue')
    await page.keyboard.press('Enter')

    // Page 2: the recommended set, checked, and the project's setup with its chips and README behind a disclosure.
    await expect.poll(() => onboarding.getByText('Recommended extensions').count(), timeout).toBe(1)
    const box = (name: string) =>
      onboarding.getByRole('checkbox', { name: new RegExp(`^${name} `) })
    for (const name of [
      'subagents',
      'plan',
      'automations',
      'documents',
      'tasks',
      'info',
      'parallel',
    ])
      expect(await box(name).getAttribute('aria-checked')).toBe('true')
    const chips = onboarding.getByRole('list', { name: 'What it brings' })
    await expect.poll(() => chips.getByText('replaces built-in').count(), timeout).toBe(1)
    expect(await chips.getByText('codemode').count()).toBe(1)
    expect(await chips.getByText('reviewer').count()).toBe(1)
    expect(await onboarding.getByText('Project setup for the browser test.').count()).toBe(0)
    await onboarding.getByRole('button', { name: "What's in it" }).click()
    await expect
      .poll(() => onboarding.getByText('Project setup for the browser test.').count(), timeout)
      .toBe(1)
    // Off to start with outside Ultimate's own clone.
    const toggle = onboarding.getByRole('switch', { name: "Use this project's setup" })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    await toggle.click()
    expect(await toggle.getAttribute('aria-checked')).toBe('true')

    // automations needs subagents: unchecking subagents unchecks it, checking it checks subagents again.
    await box('subagents').click()
    expect(await box('automations').getAttribute('aria-checked')).toBe('false')
    await box('automations').click()
    expect(await box('subagents').getAttribute('aria-checked')).toBe('true')
    await box('info').click()
    // Without web search, neither it nor secrets turns on.
    await box('parallel').click()
    await proceed.click()
    await expect.poll(() => dialog.count(), timeout).toBe(0)
    expect(
      JSON.parse(await readFile(join(userHome, '.ultimate/settings.json'), 'utf8')).extensions,
    ).toEqual({ enable: ['subagents', 'plan', 'automations', 'documents', 'tasks'] })
    expect(projectDecision(project, userHome)).toBe(true)
    await access(join(userHome, '.ultimate/onboarding.json'))

    // The panel shows the new state live: the project's setup in use, plan on, info not.
    await openExtensions(page)
    const on = page.getByRole('region', { name: 'On' })
    const available = page.getByRole('region', { name: 'Available' })
    await expect
      .poll(() => on.getByRole('switch', { name: 'plan for this project' }).count(), timeout)
      .toBe(1)
    expect(await available.getByRole('switch', { name: 'info for this project' }).count()).toBe(1)
    await expect.poll(() => on.getByText('replaces the built-in').count(), timeout).toBe(1)

    // A reload asks nothing again.
    await page.reload()
    await expect.poll(() => page.locator('main #composer-input').count(), timeout).toBe(1)
    await untilInput(page)
    await openExtensions(page)
    const clock = page.getByRole('switch', { name: 'clock for this project' })
    await expect
      .poll(
        () => available.getByRole('switch', { name: 'clock for this project' }).count(),
        timeout,
      )
      .toBe(1)

    // Space on the focused switch turns it on; the row moves to On and focus moves with it.
    await clock.focus()
    await page.keyboard.press('Space')
    await expect
      .poll(() => on.getByRole('switch', { name: 'clock for this project' }).count(), timeout)
      .toBe(1)
    const focused = () =>
      page.evaluate(() => {
        const active = document.activeElement
        return `${active?.closest('section')?.getAttribute('aria-label')}/${active?.getAttribute('aria-label')}`
      })
    await expect.poll(focused, timeout).toBe('On/clock for this project')
    expect(await clock.getAttribute('aria-checked')).toBe('true')
    await expect
      .poll(() => page.locator('aside [aria-live="polite"]').textContent(), timeout)
      .toBe('clock is on, under On')
    expect(
      JSON.parse(await readFile(join(project, '.ultimate/settings.json'), 'utf8')).extensions,
    ).toEqual({ enable: ['clock'] })
    expect(await dialog.count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    vi.restoreAllMocks()
    await browser.close()
    await server.close()
  }
}, 120000)

it('outside the first run, an undecided project setup asks with one compact card', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-onboarding-card-')
  const project = await projectWithSetup(userHome)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
    localSetup: false,
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const card = page.getByRole('dialog')
    await page.goto(server.url)

    await expect.poll(() => card.getByText("Use this project's setup?").count(), timeout).toBe(1)
    await untilInput(page)
    const chips = card.getByRole('list', { name: 'What it brings' })
    await expect.poll(() => chips.getByText('reviewer').count(), timeout).toBe(1)
    expect(await chips.getByText('replaces built-in').count()).toBe(1)
    expect(await card.getByText('Get ready').count()).toBe(0)
    await card.getByRole('button', { name: "What's in it" }).click()
    await expect
      .poll(() => card.getByText('Project setup for the browser test.').count(), timeout)
      .toBe(1)

    expect(await card.getByText('Runs its extensions on this machine').isVisible()).toBe(true)

    // Keep global keeps the global setup, remembered, so a reload does not ask again.
    await card.getByRole('button', { name: 'Keep global' }).click()
    await expect.poll(() => card.count(), timeout).toBe(0)
    expect(projectDecision(project, userHome)).toBe(false)
    await page.reload()
    await expect.poll(() => page.locator('main #composer-input').count(), timeout).toBe(1)
    await untilInput(page)
    expect(await card.count()).toBe(0)

    // The Extensions panel opens the card again, and Use it takes the project's setup.
    await openExtensions(page)
    await page.getByRole('button', { name: 'About this setup' }).click()
    await expect.poll(() => card.getByText("Use this project's setup?").count(), timeout).toBe(1)
    await card.getByRole('button', { name: 'Use it' }).click()
    await expect.poll(() => card.count(), timeout).toBe(0)
    expect(projectDecision(project, userHome)).toBe(true)
    await expect
      .poll(
        () => page.getByRole('region', { name: 'On' }).getByText('replaces the built-in').count(),
        timeout,
      )
      .toBe(1)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 120000)
