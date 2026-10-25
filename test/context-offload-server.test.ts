import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from '@earendil-works/pi-durable'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import type { ToolHooks, HookApi } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../server/extensions.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { temp } from './helpers.ts'
import contextOffload from '../extensions/context-offload/server.ts'

it.each(['success', 'timeout', 'long lines'])(
  'preserves the entire Pi bash spill before commit on %s',
  async (outcome) => {
    const home = await temp()
    const spill = join(home, 'bash-spill.txt')
    const full =
      outcome === 'long lines'
        ? Array.from({ length: 8 }, (_, i) => `warn row ${i + 1}: ${'警'.repeat(20000)}`).join('\n')
        : Array.from({ length: 6000 }, (_, i) => `row ${i + 1} ${'x'.repeat(40)}`).join('\n')
    await writeFile(spill, full)
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', {}, { id: 'large-call' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Done.'),
    ])
    const registry = createRegistry()
    registry.install(
      contextOffload({
        home,
        implement: () => {},
        userHome: home,
        projectSettings: async () => ({}),
        onOpen: () => {},
      } as unknown as ExtensionHost),
    )
    registry.install(
      defineExtension({
        name: 'test-output',
        tools: [
          defineTool({
            name: 'bash',
            description: 'Fake spilled bash output',
            parameters: Type.Object({}),
            structuredOutputSchema: Type.Object({
              output: Type.String(),
              truncated: Type.Boolean(),
              fullOutputPath: Type.Optional(Type.String()),
              exitCode: Type.Number(),
            }),
            outputLimits: { retain: 'tail' },
            execute: async (_args, api) => {
              // Exact bash.js shape: streamed tail and diagnostic on both paths; structured output only on success.
              api.output(full.slice(-50000))
              api.diagnostic({
                severity: 'info',
                code: 'full_output',
                message: `Full output: ${spill}`,
              })
              if (outcome === 'timeout') throw new Error('Command timed out after 1 seconds')
              return {
                structuredOutput: {
                  output: full.slice(-50000),
                  truncated: true,
                  fullOutputPath: spill,
                  exitCode: 0,
                },
              }
            },
          }),
        ],
      }),
    )
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
    try {
      const root = await harness.root(context, {
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
      })
      const run = await root.submit({ type: 'input', content: 'Run bash.' }, context)
      expect((await run.wait(context)).status).toBe('done')
      const entries = (await root.context(context)).entries
      const stored = entries.flatMap((entry) =>
        entry.kind === 'pi.tool-result' ? (entry.model as ToolResultMessage[]) : [],
      )
      expect(stored).toHaveLength(1)
      const output = stored[0].content[0]
      expect(output.type).toBe('text')
      if (output.type !== 'text') throw new Error('Missing text')
      expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(8192)
      expect(output.text).toContain(outcome === 'long lines' ? 'warn row 1:' : 'row 1 ')
      expect(output.text).toContain(outcome === 'long lines' ? 'warn row 8:' : 'row 6000 ')
      expect(output.text).toContain(outcome === 'long lines' ? 'chars]' : 'lines omitted')
      expect(output.text).not.toContain('row 3000 ')
      expect(output.text.slice(-2000)).toContain('Full output: ')
      expect(output.text).not.toContain(spill)
      expect(stored[0].isError).toBe(outcome === 'timeout')
      const path = join(home, 'outputs', String(root.id), 'large-call.txt')
      expect(output.text).toContain(path)
      expect(await readFile(path, 'utf8')).toBe(full)
    } finally {
      await harness.close(context)
    }
  },
)

it('skips settings for empty results, caches settings, and notices invalid settings once without result diagnostics', async () => {
  const home = await temp()
  const projectSettings = vi.fn<ExtensionHost['projectSettings']>(async () => ({
    contextOffload: { thresholdBytes: 0 },
  }))
  const notice = vi.fn<ExtensionHost['notice']>()
  const extension = contextOffload({
    home,
    implement: () => {},
    userHome: home,
    projectSettings,
    notice,
    onOpen: () => {},
  } as unknown as ExtensionHost)
  const hooks = extension.hooks![0].handlers as ToolHooks
  const call = { type: 'toolCall' as const, id: 'settings', name: 'test', arguments: {} }
  const api = { conversationId: 1 } as HookApi
  expect(await hooks.afterTool(call, { output: [] }, api, context)).toBeUndefined()
  expect(projectSettings).not.toHaveBeenCalled()
  for (let i = 0; i < 3; i++) {
    expect(
      await hooks.afterTool(
        call,
        { output: [{ type: 'text', text: 'ordinary result' }] },
        api,
        context,
      ),
    ).toBeUndefined()
  }
  expect(projectSettings).toHaveBeenCalledTimes(1)
  expect(notice).toHaveBeenCalledTimes(1)
  expect(notice).toHaveBeenCalledWith(expect.stringContaining('using defaults'))
})

it('honors settings below the default threshold and refreshes with a new installation', async () => {
  const home = await temp()
  const projectSettings = vi.fn<ExtensionHost['projectSettings']>(async () => ({
    contextOffload: { thresholdBytes: 100 },
  }))
  const host = {
    home,
    implement: () => {},
    userHome: home,
    projectSettings,
    onOpen: () => {},
  } as unknown as ExtensionHost
  const call = { type: 'toolCall' as const, id: 'settings', name: 'test', arguments: {} }
  const api = { conversationId: 1 } as HookApi
  const output = [{ type: 'text' as const, text: 'x'.repeat(4000) }]
  const hooks = contextOffload(host).hooks![0].handlers as ToolHooks
  expect(await hooks.afterTool(call, { output }, api, context)).toHaveProperty('details.offload')
  projectSettings.mockResolvedValue({ contextOffload: { thresholdBytes: 10000 } })
  const reloaded = contextOffload(host).hooks![0].handlers as ToolHooks
  expect(await reloaded.afterTool(call, { output }, api, context)).toBeUndefined()
})
