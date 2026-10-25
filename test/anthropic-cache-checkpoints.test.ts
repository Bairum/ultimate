import { expect, it } from 'vitest'
import type { Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamCodex } from '@earendil-works/pi-ai/api/openai-codex-responses'

// Pi upstream: exercises the pi-ai 1.4.0 rolling Anthropic checkpoint patch through request assembly.
const model: Model<'anthropic-messages'> = {
  id: 'claude-sonnet-4-5',
  name: 'Claude',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 200000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

type Block = { type: string; cache_control?: unknown; text?: string }
type Payload = {
  system?: Block[]
  tools?: Block[]
  messages: { role: string; content: Block[] }[]
  prompt_cache_key?: string
}

function history(rounds: number): Context {
  const messages: Context['messages'] = [
    {
      role: 'system',
      content: 'Stable instructions',
      timestamp: 0,
      toolsAdded: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    },
    { role: 'user', content: 'Inspect the repository', timestamp: 0 },
  ]
  for (let i = 0; i < rounds; i++) {
    messages.push(
      {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          { type: 'thinking', thinking: `Reason ${i}`, thinkingSignature: 'signature' },
          { type: 'toolCall', id: `call_${i}`, name: 'read', arguments: { path: `${i}` } },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: `call_${i}`,
        toolName: 'read',
        content: [{ type: 'text', text: `Result ${i}` }],
        isError: false,
        timestamp: 0,
      },
    )
  }
  return { messages }
}

async function capture(context: Context, options: SimpleStreamOptions = {}, codex = false) {
  let payload: Payload | undefined
  const tokenBody = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
  ).toString('base64')
  const requestOptions: SimpleStreamOptions = {
    apiKey: codex ? `header.${tokenBody}.signature` : 'sk-ant-test',
    cacheRetention: 'long',
    ...options,
    fetch: async () => {
      throw new Error('Unexpected network request')
    },
    onPayload(value) {
      payload = structuredClone(value) as Payload
      throw new Error('Payload captured; do not send')
    },
  }
  await (
    codex
      ? streamCodex(
          { ...model, api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-5.4' },
          normalizeContext(context),
          requestOptions,
        )
      : streamSimple(model, normalizeContext(context), requestOptions)
  ).result()
  expect(payload).toBeDefined()
  return payload!
}

function markers(payload: Payload) {
  return [
    ...(payload.system ?? []),
    ...(payload.tools ?? []),
    ...payload.messages.flatMap((message) => message.content),
  ].filter((block) => block.cache_control)
}

it.each(['sk-ant-test', 'sk-ant-oat-test'])(
  'respects the four-marker budget with %s',
  async (apiKey) => {
    const payload = await capture(history(200), { apiKey })
    expect(markers(payload)).toHaveLength(4)
    expect(payload.system?.filter((block) => block.cache_control)).toHaveLength(1)
    const cache = { type: 'ephemeral', ttl: '1h' }
    expect(payload.system?.map((block) => block.cache_control)).toEqual(
      apiKey.includes('oat') ? [undefined, cache] : [cache],
    )
    expect(payload.tools?.at(-1)?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(payload.messages.at(-1)?.content.at(-1)?.cache_control).toBeDefined()
    const thinking = payload.messages
      .flatMap((message) => message.content)
      .filter((b) => b.type === 'thinking')
    expect(thinking).toHaveLength(200)
    expect(thinking.every((block) => !block.cache_control)).toBe(true)
    const checkpoints = payload.messages.flatMap((message, index) =>
      index < payload.messages.length - 1 && message.content.at(-1)?.cache_control ? [index] : [],
    )
    expect(checkpoints).toEqual([384])
  },
)

it('keeps the OAuth identity marker when there is no system text', async () => {
  const context = history(200)
  const initial = context.messages[0]
  if (initial.role !== 'system') throw new Error('Expected leading system message')
  const payload = await capture(
    { messages: [{ ...initial, content: '' }, ...context.messages.slice(1)] },
    { apiKey: 'sk-ant-oat-test' },
  )
  expect(payload.system).toHaveLength(1)
  expect(payload.system?.[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(payload.messages[384].content.at(-1)?.cache_control).toBeDefined()
  expect(markers(payload)).toHaveLength(4)
})

it('keeps checkpoint positions and bytes stable when three messages are appended', async () => {
  const context = history(200)
  const shorter = await capture(context)
  const extra = history(201).messages.slice(-2)
  const longer = await capture({
    messages: [...context.messages, ...extra, { role: 'user', content: 'Continue', timestamp: 0 }],
  })
  expect(longer.messages).toHaveLength(shorter.messages.length + 3)
  const bytes = (message: Payload['messages'][number]) =>
    JSON.stringify(message, (key, value) => (key === 'cache_control' ? undefined : value))
  const checkpoints = shorter.messages.flatMap((message, index) =>
    index < shorter.messages.length - 1 && message.content.at(-1)?.cache_control ? [index] : [],
  )
  expect(checkpoints).toEqual([384])
  for (const index of checkpoints) {
    expect(bytes(shorter.messages[index])).toBe(bytes(longer.messages[index]))
    expect(longer.messages[index].role).toBe('user')
    expect(longer.messages[index].content.at(-1)?.type).toBe('tool_result')
  }
  expect(longer.messages[400].content.at(-1)?.cache_control).toBeDefined()
})

it.each(['sk-ant-test', 'sk-ant-oat-test'])(
  'adds no markers with retention none (%s)',
  async (apiKey) => {
    expect(markers(await capture(history(200), { apiKey, cacheRetention: 'none' }))).toHaveLength(0)
  },
)

it('keeps Codex session affinity without Anthropic cache controls', async () => {
  const payload = await capture(
    { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] },
    { sessionId: 'stable-conversation' },
    true,
  )
  expect(payload.prompt_cache_key).toBe('stable-conversation')
  expect(JSON.stringify(payload)).not.toContain('cache_control')
})
