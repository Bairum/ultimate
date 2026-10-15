import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import { git } from '../extensions/workspaces/git.ts'
import { fauxServer, post, temp } from './helpers.ts'

const definition = (tools: string) =>
  `---\nname: lander\ndescription: Project lander\ntools: [${tools}]\nonFailure: fix\n---\nLand it here.\n`

it('reconfigures the lander when the project setup is chosen, edited, and given up, without reopening', async () => {
  const directory = await temp('ultimate-lander-trust-')
  const projectRoot = join(directory, 'project')
  await mkdir(join(projectRoot, '.ultimate/agents'), { recursive: true })
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.email', 'test@example.com')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await writeFile(join(projectRoot, '.ultimate/agents/lander.md'), definition('read'))
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'base')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: directory,
    home: join(directory, 'state'),
    localSetup: false,
  })
  try {
    const tools = async () => {
      const index = await server.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
      const id = Object.values(index!.landerConversations)[0] as ConversationId
      const agent = await (await server.harness.conversation(id, context))!.agent(context)
      return agent.tools.map((tool) => tool.name).toSorted()
    }
    const decide = (local: boolean) =>
      post(server, '/api/extensions/onboarding/actions/decide', { args: { local } })
    const poll = { timeout: 15000 }
    // Global: the clone's lander definition.
    await expect.poll(tools, poll).toEqual(['bash', 'read'])
    await decide(true)
    await expect.poll(tools, poll).toEqual(['read'])
    // The project's definition folder is watched once the project is local.
    await writeFile(join(projectRoot, '.ultimate/agents/lander.md'), definition('bash'))
    await expect.poll(tools, poll).toEqual(['bash'])
    await decide(false)
    await expect.poll(tools, poll).toEqual(['bash', 'read'])
  } finally {
    await server.close()
  }
})
