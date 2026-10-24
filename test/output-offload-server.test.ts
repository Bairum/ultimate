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
import { Type } from '@earendil-works/pi-ai'
import { expect, it } from 'vitest'
import type { ExtensionHost } from '../server/extensions.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { temp } from './helpers.ts'
import outputOffload from '../extensions/output-offload/server.ts'

it('shortens a model-issued bash result before committing and preserves the entire Pi spill durably', async () => {
  const home = await temp()
  const spill = join(home, 'bash-spill.txt')
  const full = Array.from({ length: 6000 }, (_, i) => `row ${i + 1} ${'x'.repeat(40)}`).join('\n')
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
    outputOffload({
      home,
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
          execute: async () => ({
            output: [{ type: 'text', text: full.slice(-50000) }],
            details: { fullOutputPath: spill },
          }),
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
    expect(output.text).toContain('row 1 ')
    expect(output.text).toContain('row 6000 ')
    expect(output.text).toContain('5,880 lines')
    expect(output.text).not.toContain('row 3000 ')
    const path = join(home, 'outputs', String(root.id), 'large-call.txt')
    expect(output.text).toContain(path)
    expect(await readFile(path, 'utf8')).toBe(full)
  } finally {
    await harness.close(context)
  }
})
