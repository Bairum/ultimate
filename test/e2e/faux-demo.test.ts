import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { Messages } from '../../extensions/messages/api.ts'
import { MessageQuestions } from '../../extensions/questions/server.ts'
import { Workspaces } from '../../extensions/workspaces/workspaces.ts'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import fauxExtension from '../../extensions/faux/server.ts'
import { generateSummary } from '../../extensions/conversations/summary.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, seedTally, sourceCopy, temp, until } from '../helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

it('derives faux summaries from the latest prompt and marks only the questions reply as awaiting a decision', async () => {
  const faux = fauxProvider()
  await fauxExtension({
    faux,
    home: await temp('ultimate-faux-summary-demo-'),
    need: () => undefined,
    onClose: () => {},
  } as unknown as ExtensionHost)
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
    activity: 'Replied in the demo.',
    title: prompt.slice(0, 60),
    summary: 'Scripted demo conversation.',
    feature: 'Demo',
    abstract: `Ask: ${prompt.slice(0, 60)}\nState: scripted demo reply`,
  })
  const question = await summarize(
    'user: questions demo\n\nassistant: Should we keep the preview running?',
  )
  expect(question.title).toBe('questions demo')
  expect(question.abstract).toBe('Ask: questions demo\nState: awaiting a decision')
  const answered = await summarize(
    'user: questions demo\n\nassistant: Should we keep the preview running?\n\nuser: Q: Should we keep the preview running?\nA: Yes\n\nassistant: Understood.',
  )
  expect(answered.abstract).toBe(
    'Ask: Q: Should we keep the preview running? A: Yes\nState: scripted demo reply',
  )
  expect(answered.feature).toBe('Demo')
})

it('sends the questions demo through messages and extracts the two decisions', async () => {
  const home = await temp('ultimate-faux-questions-demo-')
  const ultimateRoot = await sourceCopy(home)
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  // Only @ultimate may message the user.
  const id = (
    await post(server, '/api/extensions/subagents/actions/standing', { args: { name: 'ultimate' } })
  ).data.result as ConversationId
  const ultimate = (await server.harness.conversation(id, context))!
  await (await ultimate.submit({ type: 'input', content: 'questions demo' }, context)).wait(context)
  await until(
    async () =>
      Object.keys(
        (await server.harness.snapshot(MessageQuestions, ROOT_CONVERSATION_ID, context))?.asked ??
          {},
      ).length === 1,
  )
  const message = (await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
    .messages[0]
  expect(message).toMatchObject({ from: id, to: 'user', reply: true, state: 'delivered' })
  const questions = (await server.harness.snapshot(
    MessageQuestions,
    ROOT_CONVERSATION_ID,
    context,
  ))!.asked[String(message.id)]
  expect(questions.map((question) => question.text)).toEqual([
    'Should we keep the preview running?',
    'Which layout should we use?',
  ])
  const view = await ultimate.viewState(context)
  // Messaging the user ends the turn without a final answer restating the message.
  expect(view.value.entries.at(-1)?.kind).toBe('pi.tool-result')
  expect(
    view.value.entries.findLast((entry) => entry.model?.[0]?.role === 'assistant')?.model?.[0],
  ).toMatchObject({
    role: 'assistant',
    content: [{ type: 'toolCall', name: 'message' }],
  })
  view.dispose()
  const reply = await post(server, '/api/extensions/questions/actions/answer', {
    args: { messageId: message.id, answers: [{ question: questions[0].text, answer: 'Yes' }] },
  })
  expect(reply.status).toBe(200)
  const log = (await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
  expect(log.messages.find((item) => item.id === reply.data.result.id)).toMatchObject({
    from: 'user',
    to: id,
    re: message.id,
    text: 'Should we keep the preview running?: Yes',
  })
  expect(log.messages.find((item) => item.id === message.id)?.state).toBe('answered')
  await ultimate.waitForIdle(context)
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
