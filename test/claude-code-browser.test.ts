import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, untilInput } from './helpers.ts'

it('opens external setup from the palette, shows missing CLI and retries status errors', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const home = await temp()
  const cli = join(home, 'claude')
  const payload = join(home, 'status.json')
  await writeFile(
    cli,
    `#!${process.execPath}\nimport { readFileSync } from 'node:fs'; process.stdout.write(readFileSync(${JSON.stringify(payload)}, 'utf8'))\n`,
  )
  await writeFile(payload, JSON.stringify({ loggedIn: false }))
  // Initially not executable, then installed externally while the page stays open.
  vi.stubEnv('PI_CLAUDE_CODE_COMMAND', cli)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['claude-code'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await page.locator('#composer-input').waitFor({ timeout: 15000 })
    await untilInput(page)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('Claude Code setup')
    await page.keyboard.press('Enter')
    const panel = page.locator('aside')
    await expect
      .poll(() => panel.getByText('CLI not installed', { exact: true }).count(), { timeout: 15000 })
      .toBe(1)
    expect(await panel.getByText(/claude auth login/).count()).toBe(1)
    expect(await panel.getByText('Billing is not guaranteed').count()).toBe(1)
    expect(await panel.getByRole('button', { name: /login|sign in/i }).count()).toBe(0)

    await page.route('**/api/extensions/claude-code/actions/status', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'private CLI output must not be shown' }),
      }),
    )
    await panel.getByRole('button', { name: 'Refresh status' }).click()
    await expect
      .poll(() => panel.getByText('Status check failed', { exact: true }).count(), {
        timeout: 15000,
      })
      .toBe(1)
    expect(await panel.getByText(/private CLI output/).count()).toBe(0)
    await page.unroute('**/api/extensions/claude-code/actions/status')
    await panel.getByRole('button', { name: 'Refresh status' }).click()
    await expect
      .poll(() => panel.getByText('CLI not installed', { exact: true }).count(), { timeout: 15000 })
      .toBe(1)
    const pickerRow = page.locator('[cmdk-item][data-value="claude-code/claude-sonnet-5"]')
    const checkPicker = async (available: boolean) => {
      await page.getByTitle('Pick a model', { exact: true }).click()
      const input = page.getByPlaceholder(/Search .* models/)
      // Blank search shows only available models; search reveals unavailable ones too.
      await input.fill('')
      await expect.poll(() => pickerRow.count(), { timeout: 15000 }).toBe(available ? 1 : 0)
      await page.keyboard.press('Escape')
    }
    await checkPicker(false)
    await chmod(cli, 0o755)
    await panel.getByRole('button', { name: 'Refresh status' }).click()
    await expect
      .poll(() => panel.getByText('Login not confirmed', { exact: true }).count(), {
        timeout: 15000,
      })
      .toBe(1)
    await writeFile(payload, JSON.stringify({ loggedIn: true, subscriptionType: 'max' }))
    await panel.getByRole('button', { name: 'Refresh status' }).click()
    await expect
      .poll(() => panel.getByText('Subscription connected', { exact: true }).count(), {
        timeout: 15000,
      })
      .toBe(1)
    await checkPicker(true)
    await writeFile(payload, JSON.stringify({ loggedIn: false }))
    await panel.getByRole('button', { name: 'Refresh status' }).click()
    await expect
      .poll(() => panel.getByText('Login not confirmed', { exact: true }).count(), {
        timeout: 15000,
      })
      .toBe(1)
    await checkPicker(false)
    await page.getByRole('button', { name: 'Toggle panel', exact: true }).click()
    await expect.poll(() => panel.getByText('Billing is not guaranteed').count()).toBe(0)
    await page.getByTitle('Pick a model', { exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Pick a model', exact: true })
    await picker.getByPlaceholder(/Search .* models/).fill('claude-code')
    await expect.poll(() => pickerRow.count()).toBe(1)
    expect(await picker.getByText('external setup · ↵ opens setup', { exact: true }).count()).toBe(
      1,
    )
    expect(await picker.getByText('not logged in · ↵ logs in', { exact: true }).count()).toBe(0)
    expect(
      await picker.getByText(/Unavailable Claude Code models open external setup/).count(),
    ).toBe(1)
    await pickerRow.click()
    await expect.poll(() => picker.count()).toBe(0)
    await expect.poll(() => panel.getByText('Billing is not guaranteed').count()).toBe(1)
    await expect
      .poll(() => panel.getByText('Login not confirmed', { exact: true }).count(), {
        timeout: 15000,
      })
      .toBe(1)
    expect(
      await page.getByRole('dialog', { name: 'Log in to a provider', exact: true }).count(),
    ).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 60000)
