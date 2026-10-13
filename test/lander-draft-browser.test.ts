import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import { git } from '../extensions/workspaces/git.ts'
import { fauxServer, skipWithoutChromium, temp, until, untilInput } from './helpers.ts'

it('never offers the standing lander as a new shared conversation', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const directory = await temp('ultimate-lander-draft-browser-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
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
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    let lander = 0
    await until(async () => {
      const index = await server.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
      lander = Object.values(index?.landerConversations ?? {})[0] ?? 0
      return lander > 0
    })
    // The pristine lander: top level, no workspace, no entries, and newer than the root.
    expect(lander).toBeGreaterThan(1)
    const page = await browser.newPage()
    page.setDefaultTimeout(15000)
    await page.goto(`${server.url}/?conversation=${lander}`)
    await untilInput(page)
    const shown = () =>
      page.evaluate(
        `import('/src/sdk/client.ts').then(({ store }) => store.getState().view?.conversation.id)`,
      )
    await expect.poll(shown, { timeout: 15000 }).toBe(lander)
    await page.getByRole('button', { name: 'Conversation creation options', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Shared (not isolated)', exact: true }).click()
    await page.getByLabel('New conversation', { exact: true }).click()
    // The pristine root is the draft it reuses, not the lander.
    await expect.poll(shown, { timeout: 15000 }).toBe(1)
  } finally {
    await browser.close()
    await server.close()
  }
}, 60000)
