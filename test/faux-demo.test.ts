import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, seedTally, sourceCopy, temp, until } from './helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

it('submits the workspace from the faux demo with a divergence, so the lander queues it', async () => {
  const home = await temp('ultimate-faux-demo-')
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: projectRoot, env: { ...process.env, GIT_CONFIG_COUNT: '0' } })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  await writeFile(join(projectRoot, 'base.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'base')
  const ultimateRoot = await sourceCopy(home)
  const server = await fauxServer({ ultimateRoot, home, userHome: home, projectRoot })
  servers.push(server)
  await seedTally(server.harness)
  const { data } = await post(server, '/api/extensions/lineage/actions/branch', {
    args: { from: 1, prompt: 'submit workspace', isolated: true },
  })
  const id = data.result.id as ConversationId
  const submitted = async () => {
    const index = await server.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
    return [...(index?.queue ?? []), ...Object.values(index?.results ?? {})].find(
      (item) => item.conversationId === id,
    )
  }
  await until(async () => (await submitted()) !== undefined)
  expect((await submitted())?.divergence).toBe('None')
})
