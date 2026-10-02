import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createModels, toToolDeclaration } from '@earendil-works/pi-ai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { createServer } from '../server/main.ts'

it('emits draft-2020-compatible browser fill schemas for Anthropic and OpenRouter', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-browser-schema-'))
  const server = await createServer({ repoRoot: resolve('.'), home, faux: true, port: 0 })
  try {
    const tools = (await server.root.agent(context)).tools?.map(toToolDeclaration)
    const models = createModels()
    models.setProvider(anthropicProvider())
    models.setProvider(openrouterProvider())
    for (const [provider, modelId] of [
      ['anthropic', 'claude-opus-4-6'],
      ['openrouter', 'anthropic/claude-opus-4.6'],
    ]) {
      const model = models.getModel(provider, modelId)
      if (!model) throw new Error(`Missing test model ${provider}/${modelId}`)
      expect(model.api).toBe('anthropic-messages')
      let schemas: { name: string; input_schema: unknown }[] = []
      const forbiddenFetch = vi.fn<typeof fetch>(async () => {
        throw new Error('Network forbidden')
      })
      const result = await models.complete(
        model,
        {
          tools,
          messages: [{ role: 'user', content: 'OK', timestamp: 0 }],
        },
        {
          apiKey: 'schema-test-not-a-secret',
          maxRetries: 0,
          fetch: forbiddenFetch,
          onPayload(payload) {
            schemas = (JSON.parse(JSON.stringify(payload)) as { tools: typeof schemas }).tools
            throw new Error('Schema captured')
          },
        },
      )
      expect(result.errorMessage).toContain('Schema captured')
      expect(forbiddenFetch).not.toHaveBeenCalled()
      expect(schemas.find((tool) => tool.name === 'browser')?.input_schema).toHaveProperty(
        'properties.steps.items.anyOf.1.properties.fill',
        {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 2,
          description: '[selector, value]',
        },
      )
    }
  } finally {
    await server.vite.watcher.close()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})
