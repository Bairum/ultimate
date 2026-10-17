import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import fauxExtension from '../extensions/faux/server.ts'
import { generateSummary } from '../extensions/conversations/summary.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, seedTally, sourceCopy, temp, until } from './helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

it('derives neutral faux summaries from the latest prompt and only flags the questions reply', async () => {
  const faux = fauxProvider()
  await fauxExtension({ faux, home: await temp('ultimate-faux-summary-demo-') } as ExtensionHost)
  const models = createModels()
  models.setProvider(faux.provider)
  const summarize = (source: string) =>
    generateSummary(
      models,
      source,
      new AbortController().signal,
      true,
      { model: { provider: 'faux', id: 'faux-1', thinking: 'off' } },
      'reply',
      false,
      true,
    )
  const prompt =
    'Review the ordinary layout and explain how the application works without changing it'
  const normal = await summarize(
    `user: Earlier prompt\n\nassistant: Earlier reply\n\nuser:  ${prompt}\n\nassistant: Complete.`,
  )
  expect(normal).toEqual({
    assessment: 'done',
    activity: 'Replied in the demo.',
    title: prompt.slice(0, 60),
    summary: 'Scripted demo conversation.',
    feature: 'Demo',
    abstract: `Ask: ${prompt.slice(0, 60)}\nState: scripted demo reply`,
  })
  const question = await summarize(
    'user: questions demo\n\nassistant: Should we keep the preview running?',
  )
  expect(question.assessment).toBe('needs_input')
  expect(question.title).toBe('questions demo')
  const answered = await summarize(
    'user: questions demo\n\nassistant: Should we keep the preview running?\n\nuser: Q: Should we keep the preview running?\nA: Yes\n\nassistant: Understood.',
  )
  expect(answered.assessment).toBe('done')
  expect(answered.feature).toBe('Demo')
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
