import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Api, Model, ProviderStreams, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { JsonObject } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import type { ActionContext } from '../server/actions.ts'
import { actions, fastModels, fastStream } from '../extensions/fast/server.ts'
import { temp } from './helpers.ts'

/** An OpenAI Responses stand-in that records the payload each request would send. */
function recordingApi() {
  const payloads: unknown[] = []
  const streamSimple = (model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream()
    const answer = { ...fauxAssistantMessage('ok'), provider: model.provider, model: model.id }
    void (async () => {
      payloads.push((await options?.onPayload?.({ model: model.id }, model)) ?? { model: model.id })
      stream.push({ type: 'done', reason: 'stop', message: answer })
      stream.end(answer)
    })()
    return stream
  }
  return { payloads, api: { streamSimple } as unknown as ProviderStreams }
}

const model = (id: string) => ({ provider: 'openai', id, api: 'openai-responses' }) as Model<Api>
const context = normalizeContext({ messages: [] })

it('asks for the priority tier only for listed models and keeps the caller payload hook', async () => {
  const { payloads, api } = recordingApi()
  const stream = fastStream(async () => new Set(['openai/gpt-6.1-sol']), api)
  await stream(model('gpt-6.1-sol'), context).result()
  await stream(model('gpt-6-luna'), context).result()
  await stream(model('gpt-6.1-sol'), context, {
    onPayload: (payload) => ({ ...(payload as object), store: false }),
  }).result()
  expect(payloads).toEqual([
    { model: 'gpt-6.1-sol', service_tier: 'priority' },
    { model: 'gpt-6-luna' },
    { model: 'gpt-6.1-sol', store: false, service_tier: 'priority' },
  ])
})

it('reads fastModels from project settings over user settings and rejects other providers', async () => {
  const userHome = await temp()
  const notices: string[] = []
  const host = (project: JsonObject) => ({
    userHome,
    projectSettings: async () => project,
    notice: (message: string) => notices.push(message),
  })
  expect(await fastModels(host({}))).toEqual(new Set())
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ fastModels: ['openai/gpt-6.1-sol'] }),
  )
  expect(await fastModels(host({}))).toEqual(new Set(['openai/gpt-6.1-sol']))
  expect(await fastModels(host({ fastModels: [] }))).toEqual(new Set())
  expect(await fastModels(host({ fastModels: ['anthropic/claude-opus-5-5'] }))).toEqual(new Set())
  expect(notices).toEqual([
    'Invalid fastModels ["anthropic/claude-opus-5-5"]: expected ["openai/<id>", …]; fast mode is off',
  ])
})

it('toggles a model in the user settings and refuses while the project decides', async () => {
  const userHome = await temp()
  let project: JsonObject = {}
  const ctx = {
    host: { userHome, projectSettings: async () => project, notice: () => {} },
  } as unknown as ActionContext
  const file = join(userHome, '.ultimate/settings.json')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(file, JSON.stringify({ summaryModel: 'openai/gpt-6-luna' }))
  expect(await actions.set({ model: 'openai/gpt-6.1-sol', on: true }, ctx)).toEqual({
    models: ['openai/gpt-6.1-sol'],
    project: false,
  })
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
    summaryModel: 'openai/gpt-6-luna',
    fastModels: ['openai/gpt-6.1-sol'],
  })
  await actions.set({ model: 'openai/gpt-6.1-sol', on: false }, ctx)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ summaryModel: 'openai/gpt-6-luna' })
  await expect(actions.set({ model: 'anthropic/claude-opus-5-5', on: true }, ctx)).rejects.toThrow(
    'Expected',
  )
  project = { fastModels: [] }
  await expect(actions.set({ model: 'openai/gpt-6.1-sol', on: true }, ctx)).rejects.toThrow(
    'project settings',
  )
  expect(await actions.status(null, ctx)).toEqual({ models: [], project: true })
})
