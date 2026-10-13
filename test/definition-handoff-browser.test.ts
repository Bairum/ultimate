import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, untilInput } from './helpers.ts'
import { parseDefinition } from '../extensions/subagents/agents.ts'

const timeout = { timeout: 15000 }

it('requires explicit subagent selection when editing inherited tools and persists the choice', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-tools-browser-')
  const project = join(userHome, 'project')
  const agents = join(userHome, '.ultimate/agents')
  await mkdir(agents, { recursive: true })
  await mkdir(project)
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['automations', 'subagents'] } }),
  )
  const path = join(agents, 'scout.md')
  await writeFile(path, '---\nname: scout\ndescription: Inherited scout\n---\nInspect read-only.\n')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await page.locator('#composer-input').waitFor(timeout)
    await untilInput(page)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('Automations…')
    await page.keyboard.press('Enter')
    await page.locator('aside').getByRole('button', { name: 'New automation' }).click()
    const automation = page.getByRole('dialog', { name: 'New automation' })
    await automation.getByRole('button', { name: 'Agent' }).click()
    await page.getByRole('menuitemradio', { name: /^scout/ }).click()
    await automation.getByRole('button', { name: 'Configure' }).click()
    const dialog = page.getByRole('dialog', { name: /^scout/ })
    const inherit = dialog.getByRole('switch', { name: 'Inherit all tools' })
    const subagent = dialog.getByRole('checkbox', { name: 'subagent', exact: true })
    await inherit.waitFor()
    const boxes = dialog.getByRole('checkbox')
    const total = await boxes.count()
    expect(await inherit.getAttribute('aria-checked')).toBe('true')
    expect(await subagent.isChecked()).toBe(false)
    expect(await subagent.isDisabled()).toBe(true)
    expect(await dialog.getByRole('checkbox', { checked: true }).count()).toBe(total - 1)
    await dialog
      .getByText(
        `${total - 1} of ${total} tools inherited from the main conversation; subagent requires explicit selection.`,
        { exact: true },
      )
      .waitFor()
    await inherit.click()
    expect(await subagent.isDisabled()).toBe(false)
    expect(await subagent.isChecked()).toBe(false)
    expect(await dialog.getByRole('checkbox', { checked: true }).count()).toBe(total - 1)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect
      .poll(async () => parseDefinition(await readFile(path, 'utf8'), path).tools?.length, timeout)
      .toBe(total - 1)
    expect(parseDefinition(await readFile(path, 'utf8'), path).tools).not.toContain('subagent')
    await subagent.check()
    await dialog
      .getByText(
        `${total} of ${total} tools selected. Select subagent explicitly to allow child delegation.`,
        { exact: true },
      )
      .waitFor()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect
      .poll(async () => parseDefinition(await readFile(path, 'utf8'), path).tools, timeout)
      .toContain('subagent')
    await page.keyboard.press('Escape')
    await automation.getByRole('button', { name: 'Configure' }).click()
    await expect.poll(() => subagent.isChecked(), timeout).toBe(true)
    await inherit.click()
    expect(await subagent.isChecked()).toBe(false)
    await inherit.click()
    expect(await subagent.isChecked()).toBe(false)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
})

it("opens a definition's config from the automations form over the bus, then takes focus back", async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-handoff-browser-')
  const project = join(userHome, 'project')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await mkdir(project)
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['automations', 'subagents'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await page.locator('#composer-input').waitFor(timeout)
    await untilInput(page)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('Automations…')
    await page.keyboard.press('Enter')
    const panel = page.locator('aside')
    await panel.getByRole('button', { name: 'New automation' }).click(timeout)
    const form = page.getByRole('dialog', { name: 'New automation' })
    await form.getByRole('button', { name: 'Agent' }).click()
    await page.getByRole('menuitemradio', { name: /^scout/ }).click()

    await form.getByRole('button', { name: 'Configure' }).click()
    const definition = page.getByRole('dialog', { name: /^scout/ })
    await expect.poll(() => definition.getByLabel('Description').count(), timeout).toBe(1)

    // Closing it returns focus to Configure, over the form that is still open.
    await page.keyboard.press('Escape')
    await expect.poll(() => definition.count(), timeout).toBe(0)
    expect(await form.count()).toBe(1)
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim()), timeout)
      .toBe('Configure')
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
})
