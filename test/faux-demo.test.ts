import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { Board } from '../extensions/board/server.ts'
import { BoardQuestions } from '../extensions/questions/server.ts'
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

it('sends the questions demo to the Board and extracts the two decisions', async () => {
  const home = await temp('ultimate-faux-questions-demo-')
  const ultimateRoot = await sourceCopy(home)
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  await (
    await server.root.submit({ type: 'input', content: 'questions demo' }, context)
  ).wait(context)
  await until(
    async () =>
      Object.keys(
        (await server.harness.snapshot(BoardQuestions, ROOT_CONVERSATION_ID, context))?.asked ?? {},
      ).length === 1,
  )
  const message = (await server.harness.snapshot(Board, ROOT_CONVERSATION_ID, context))!.messages[0]
  expect(message).toMatchObject({ from: 1, to: 'user', reply: true, state: 'delivered' })
  const questions = (await server.harness.snapshot(BoardQuestions, ROOT_CONVERSATION_ID, context))!
    .asked[String(message.id)]
  expect(questions.map((question) => question.text)).toEqual([
    'Should we keep the preview running?',
    'Which layout should we use?',
  ])
  const view = await server.root.viewState(context)
  expect(
    view.value.entries.findLast((entry) => entry.model?.[0]?.role === 'assistant')?.model?.[0],
  ).toMatchObject({
    role: 'assistant',
    content: [{ type: 'text', text: 'Sent.' }],
  })
  view.dispose()
  const reply = await post(server, '/api/extensions/questions/actions/answer', {
    args: { messageId: message.id, answers: [{ question: questions[0].text, answer: 'Yes' }] },
  })
  expect(reply.status).toBe(200)
  const log = (await server.harness.snapshot(Board, ROOT_CONVERSATION_ID, context))!
  expect(log.messages.find((item) => item.id === reply.data.result.id)).toMatchObject({
    from: 'user',
    to: 1,
    re: message.id,
    text: 'Q: Should we keep the preview running?\nA: Yes',
  })
  expect(log.messages.find((item) => item.id === message.id)?.state).toBe('answered')
  await server.root.waitForIdle(context)
})

it("asks the two decisions in @ultimate's final answer and takes the card's answers as typed input", async () => {
  const home = await temp('ultimate-faux-ask-demo-')
  const ultimateRoot = await sourceCopy(home)
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const id = (
    await post(server, '/api/extensions/subagents/actions/standing', { args: { name: 'ultimate' } })
  ).data.result as ConversationId
  const ultimate = (await server.harness.conversation(id, context))!
  const asked = await (
    await ultimate.submit({ type: 'input', content: 'ask demo' }, context)
  ).wait(context)
  await until(
    async () =>
      (await server.harness.snapshot(BoardQuestions, ROOT_CONVERSATION_ID, context))?.reply
        ?.entry === asked.answer,
  )
  const { questions } = (await server.harness.snapshot(
    BoardQuestions,
    ROOT_CONVERSATION_ID,
    context,
  ))!.reply!
  expect(questions.map((question) => question.text)).toEqual([
    'Should we keep the preview running?',
    'Which layout should we use?',
  ])
  const reply = await post(server, '/api/extensions/questions/actions/reply', {
    args: { entryId: asked.answer, answers: [{ question: questions[1].text, answer: 'Compact' }] },
  })
  expect(reply.status).toBe(200)
  await server.root.waitForIdle(context)
  const view = await ultimate.viewState(context)
  expect(
    view.value.entries.filter((entry) => entry.kind === 'pi.user').map((e) => e.model?.[0]),
  ).toMatchObject([
    { content: 'ask demo' },
    { content: 'Q: Which layout should we use?\nA: Compact' },
  ])
  view.dispose()
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
