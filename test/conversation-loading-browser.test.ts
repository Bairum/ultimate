import { AgentDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { fauxServer, skipWithoutChromium, temp, untilInput, post } from './helpers.ts'

it('keeps a delayed conversation switch neutral and inert, then restores target configuration and genuine warnings', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-conversation-loading-')
  const project = join(userHome, 'project')
  await mkdir(project)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  const created = await post(server, '/api/conversations', { title: 'Loading target' })
  const target = (created.data as { id: ConversationId }).id
  const conversation = (await server.harness.conversation(target, context))!
  await conversation.configure(
    { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'high' },
    context,
  )
  await server.root.configure(
    { model: { provider: 'faux', modelId: 'faux-source' }, thinkingLevel: 'low' },
    context,
  )
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    const actions: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (/\/(submit|configure)$/.test(request.url())) actions.push(request.url())
    })
    await page.route('**/api/models', async (route) => {
      const response = await route.fetch()
      const data = await response.json()
      for (const model of data.models) if (model.provider === 'faux') model.reasoning = true
      const faux = data.models.find((model: { provider: string }) => model.provider === 'faux')
      data.models.push({ ...faux, id: 'faux-source' })
      await route.fulfill({ response, json: data })
    })
    await page.goto(server.url)
    await untilInput(page)
    await page.locator('#composer-input').waitFor({ timeout: 15000 })
    await expect
      .poll(() => page.getByTitle('Thinking level (Shift+Tab cycles)').textContent())
      .toBe('low')
    expect(await page.getByTitle('Pick a model').textContent()).toContain('faux-source')
    await page.route('**/api/events?**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('conversation') === String(target))
        await gate
      await route.continue()
    })
    await page.getByTitle('Pick a model').click()
    const picker = page.getByRole('dialog', { name: 'Pick a model', exact: true })
    await picker.waitFor()
    await page.evaluate(
      `import('/src/sdk/client.ts').then(({ uiState }) => uiState.set('shell.conversation', ${target}))`,
    )
    const input = page.locator('#composer-input')
    expect(await page.locator('main').textContent()).not.toContain('No model configured')
    await expect.poll(() => input.getAttribute('readonly')).toBe('')
    const model = page.getByRole('button', { name: 'Loading model', includeHidden: true })
    const thinking = page.getByRole('button', {
      name: 'Loading thinking level',
      includeHidden: true,
    })
    const send = page.getByRole('button', { name: 'Loading conversation', includeHidden: true })
    expect(await model.isDisabled()).toBe(true)
    expect(await thinking.isDisabled()).toBe(true)
    expect(await send.isDisabled()).toBe(true)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await send.locator('svg').evaluate((icon) => getComputedStyle(icon).animationName)).toBe(
      'none',
    )
    expect(await model.textContent()).not.toContain('no model')
    expect(await thinking.textContent()).not.toContain('low')
    // A picker opened before the switch must not configure the requested target while pending.
    const targetOption = picker.locator('[cmdk-item][data-value="faux/faux-1"]')
    await targetOption.click()
    expect(actions).toEqual([])
    await picker.getByRole('combobox').fill('faux-1')
    await picker.getByRole('combobox').press('Enter')
    expect(actions).toEqual([])
    expect(await picker.count()).toBe(1)
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })

    // The command palette must not reopen the picker until the snapshot arrives.
    const pickFromPalette = async () => {
      await page.keyboard.press('Control+k')
      await page.getByPlaceholder('Run a command…').fill('model.pick')
      await page.getByRole('option', { name: 'Pick a model', exact: true }).click()
      await page.getByPlaceholder('Run a command…').waitFor({ state: 'detached' })
    }
    await pickFromPalette()
    expect(await picker.count()).toBe(0)
    expect(actions).toEqual([])
    await input.press('a')
    await input.press('Enter')
    await input.press('Shift+Tab')
    await input.evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(new File(['image'], 'test.png', { type: 'image/png' }))
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
      element
        .closest('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(actions).toEqual([])
    expect(await page.getByAltText('Pasted image 1').count()).toBe(0)
    expect(await input.inputValue()).toBe('')

    release()
    await expect
      .poll(() => page.getByTitle('Thinking level (Shift+Tab cycles)').textContent())
      .toBe('high')
    expect(await page.getByTitle('Pick a model').textContent()).toContain('faux-1')
    expect(await input.getAttribute('readonly')).toBeNull()
    await pickFromPalette()
    await targetOption.click()
    await expect
      .poll(() => actions)
      .toEqual([`${server.url}/api/conversations/${target}/configure`])
    await picker.waitFor({ state: 'detached' })
    expect((await conversation.agent(context)).model).toEqual({
      provider: 'faux',
      modelId: 'faux-1',
    })
    await input.fill('Ready draft')
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled()).toBe(true)

    await conversation.commit(async (tx) => {
      delete (await tx.doc(AgentDoc, target)).model
    }, context)
    await page.reload()
    await expect.poll(() => page.locator('main').textContent()).toContain('No model configured')
    expect(await page.getByTitle('Pick a model').textContent()).toContain('no model')
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true)
    await conversation.configure(
      { model: { provider: 'missing-provider', modelId: 'missing-model' } },
      context,
    )
    await page.reload()
    await expect
      .poll(() => page.locator('main').textContent())
      .toContain('missing-provider/missing-model is not available')
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true)
    expect(errors).toEqual([])
  } finally {
    release()
    await browser.close()
    await server.close()
  }
}, 60000)
