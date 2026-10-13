import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { JsonObject } from '@earendil-works/pi-durable'
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  UsageDoc,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import type { ActionContext } from '../server/actions.ts'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { actions } from '../extensions/conversations/server.ts'
import {
  AssessmentAccepted,
  Summaries,
  summaryBehavior,
} from '../extensions/conversations/summary.ts'
import { temp, until } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

/** A summary provider whose models answer with a valid assessment; `requests` records what was asked. */
function summaryProvider(provider: string, ids: string[]) {
  const handle = fauxProvider({ provider, models: ids.map((id) => ({ id, reasoning: true })) })
  const requests: { model: string; reasoning: SimpleStreamOptions['reasoning'] }[] = []
  return {
    requests,
    provider: {
      ...handle.provider,
      streamSimple(model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) {
        requests.push({ model: `${model.provider}/${model.id}`, reasoning: options?.reasoning })
        const stream = createAssistantMessageEventStream()
        const answer = {
          ...fauxAssistantMessage(
            JSON.stringify({
              assessment: 'done',
              activity: 'Implemented the change.',
              title: 'Implement the change',
              summary: 'Implemented the change.',
            }),
          ),
          provider: model.provider,
          model: model.id,
          api: model.api,
        }
        queueMicrotask(() => {
          stream.push({ type: 'done', reason: 'stop', message: answer })
          stream.end(answer)
        })
        return stream
      },
    } as typeof handle.provider,
  }
}

async function launch({
  user,
  project = {},
  available = (model: Model<Api>) => model.provider !== 'faux',
  interrupt = false,
}: {
  user?: JsonObject
  project?: JsonObject
  available?: (model: Model<Api>) => boolean
  interrupt?: boolean
} = {}) {
  const userHome = await temp('ultimate-summary-model-')
  if (user) {
    await mkdir(join(userHome, '.ultimate'))
    await writeFile(join(userHome, '.ultimate/settings.json'), JSON.stringify(user))
  }
  const models = createModels()
  const main = fauxProvider({ tokensPerSecond: 100000 })
  const luna = summaryProvider('openai', ['gpt-6-luna'])
  const acme = summaryProvider('acme', ['mini', 'large'])
  models.setProvider(main.provider)
  models.setProvider(luna.provider)
  models.setProvider(acme.provider)
  const notices: string[] = []
  const settings = { project }
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const registry = createRegistry()
  let harness: Harness
  registry.install(
    defineExtension({
      name: 'conversations',
      ...summaryBehavior({
        harness: () => harness,
        metadata: Metadata,
        userHome,
        projectSettings: async () => settings.project,
        notice: (message) => notices.push(message),
        modelRuntime: { getAvailableSnapshot: () => models.getModels().filter(available) },
      }),
    }),
  )
  harness = await Harness.open(storage, { models, registry }, context)
  let interruption: Promise<void> | undefined
  harness.subscribeCommits((publication) => {
    if (
      interrupt &&
      !interruption &&
      publication.changes.some(
        (change) => change.type === 'task' && change.value.memos?.model !== undefined,
      )
    )
      interruption = harness.close(context)
  })
  let root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  await harness.commit(
    (tx) =>
      tx.appendEntry(root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Established context', timestamp: 1 }],
      }),
    context,
  )
  cleanups.push(() => harness.close(context))
  return {
    userHome,
    settings,
    notices,
    requests: () => [...luna.requests, ...acme.requests],
    read: () => harness.snapshot(Summaries, root.id, context),
    tasks: async () => (await harness.inspect(context)).tasks,
    assessed: async () =>
      (await root.context(context)).entries.flatMap((entry) =>
        AssessmentAccepted.is(entry) ? [entry.data] : [],
      ),
    ledger: async () =>
      Object.keys((await harness.snapshot(UsageDoc, root.id, context))?.models ?? {}),
    submit: async () => {
      main.setResponses([fauxAssistantMessage('Implemented the change.')])
      const submission = await root.submit(
        { type: 'input', content: 'Implement this change.' },
        context,
      )
      expect((await submission.wait(context)).status).toBe('done')
    },
    interrupted: () => interruption !== undefined,
    reopen: async () => {
      await (interruption ?? harness.close(context))
      interruption = undefined
      harness = await Harness.open(storage, { models, registry }, context)
      root = await harness.root(context)
      harness.resume()
    },
  }
}

it('asks the configured summary model with its thinking level and records it', async () => {
  const f = await launch({ user: { summaryModel: 'acme/mini:low' } })
  await f.submit()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  expect(f.requests()).toEqual([{ model: 'acme/mini', reasoning: 'low' }])
  expect(await f.assessed()).toMatchObject([{ value: 'done', model: 'acme/mini' }])
  expect(await f.ledger()).toEqual(['faux/faux-1', 'acme/mini'])
})

it('uses GPT-6 Luna with medium thinking when no summary model is set', async () => {
  const f = await launch()
  await f.submit()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  expect(f.requests()).toEqual([{ model: 'openai/gpt-6-luna', reasoning: 'medium' }])
  expect(await f.assessed()).toMatchObject([{ model: 'openai/gpt-6-luna' }])
})

it("lets the project's summary model override the user's", async () => {
  const f = await launch({
    user: { summaryModel: 'acme/mini' },
    project: { summaryModel: 'acme/large:high' },
  })
  await f.submit()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  expect(f.requests()).toEqual([{ model: 'acme/large', reasoning: 'high' }])
})

it('applies a changed setting to the next request without a restart', async () => {
  const f = await launch({ user: { summaryModel: 'acme/mini' } })
  await f.submit()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  f.settings.project = { summaryModel: 'acme/large' }
  await f.submit()
  await until(async () => (await f.assessed()).length === 2)
  expect(f.requests().map((request) => request.model)).toEqual(['acme/mini', 'acme/large'])
})

it.each([
  ['unavailable', 'acme/mini', []],
  ['unknown', 'acme/nothing', []],
  [
    'invalid',
    'not a model',
    [
      'Invalid summaryModel "not a model" in user settings: expected "provider/id[:thinking]"; summaries are off',
    ],
  ],
])('skips summaries quietly for an %s summary model', async (_case, summaryModel, notices) => {
  const f = await launch({
    user: { summaryModel },
    available: (model) => model.provider === 'openai',
  })
  await f.submit()
  await until(async () => (await f.tasks()).length === 0)
  expect(f.requests()).toEqual([])
  expect((await f.read())?.assessmentStatus).toBeUndefined()
  expect(f.notices).toEqual(notices)
})

it('resumes an interrupted request with the model it chose, not a newer setting', async () => {
  const f = await launch({ user: { summaryModel: 'acme/mini' }, interrupt: true })
  await f.submit()
  await until(f.interrupted)
  f.settings.project = { summaryModel: 'acme/large' }
  await f.reopen()
  await until(async () => (await f.assessed()).length === 1)
  expect(await f.assessed()).toMatchObject([{ model: 'acme/mini' }])
  expect(f.requests().every((request) => request.model === 'acme/mini')).toBe(true)
})

it('reads and writes the user summary model through the conversations actions', async () => {
  const userHome = await temp('ultimate-summary-model-action-')
  const path = join(userHome, '.ultimate/settings.json')
  await mkdir(join(userHome, '.ultimate'))
  await writeFile(path, JSON.stringify({ extensions: { enable: ['canvas'] } }))
  const project: JsonObject = {}
  const ctx = {
    host: { userHome, projectSettings: async () => project },
  } as unknown as ActionContext
  expect(await actions.summaryModel(null, ctx)).toEqual({
    value: 'openai/gpt-6-luna:medium',
    source: 'default',
    default: 'openai/gpt-6-luna:medium',
  })
  expect(await actions.setSummaryModel({ value: 'acme/mini:low' }, ctx)).toMatchObject({
    value: 'acme/mini:low',
    source: 'user',
  })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    extensions: { enable: ['canvas'] },
    summaryModel: 'acme/mini:low',
  })
  project.summaryModel = 'acme/large'
  expect(await actions.summaryModel(null, ctx)).toMatchObject({
    value: 'acme/large',
    source: 'project',
  })
  delete project.summaryModel
  await expect(actions.setSummaryModel({ value: 'mini' }, ctx)).rejects.toThrow('provider/id')
  expect(await actions.setSummaryModel({ value: null }, ctx)).toMatchObject({ source: 'default' })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ extensions: { enable: ['canvas'] } })
})
