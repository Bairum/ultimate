import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import hygiene from '../extensions/context-hygiene/server.ts'
import { Ledger } from '../extensions/context-hygiene/api.ts'

it('opens the new-context gate for a compaction head retaining warm assistants', async () => {
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 0 })
  models.setProvider(faux.provider)
  const registry = createRegistry()
  let harness: Harness
  const notices: string[] = []
  const extension = hygiene({
    harness: () => harness,
    implement: () => {},
    want: () => undefined,
    notice: (notice) => notices.push(notice),
    projectSettings: async () => ({}),
    projectRoot: '/nonexistent',
    userHome: '/nonexistent',
  })
  registry.install(extension)
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' }, extensions: [extension] },
    })
    await harness.commit(async (tx) => {
      const ledger = await tx.doc(Ledger, root.id)
      ledger.decisions.removed = { reason: 'empty', tokens: 1, state: 'applied', at: 1 }
      const start = await tx.appendEntry(root.id, {
        kind: 'test.start',
        model: [{ role: 'user', content: 'begin', timestamp: 1 }],
      })
      for (const id of ['a', 'b']) {
        await tx.appendEntry(root.id, {
          kind: 'pi.assistant',
          model: [
            {
              ...fauxAssistantMessage(''),
              timestamp: Date.now(),
              content: [{ type: 'toolCall', name: 'read', id, arguments: { path: 'x' } }],
            },
          ],
        })
        await tx.appendEntry(root.id, {
          kind: 'pi.toolResult',
          model: [
            {
              role: 'toolResult',
              toolCallId: id,
              toolName: 'read',
              content: [{ type: 'text', text: id.repeat(10000) }],
              isError: false,
              timestamp: 1,
            },
          ],
        })
      }
      await tx.appendEntry(root.id, {
        kind: 'test.padding',
        model: [{ role: 'user', content: 'padding'.repeat(10000), timestamp: 1 }],
      })
      await tx.appendEntry(root.id, {
        kind: 'pi.compaction',
        head: start.id,
        model: [{ role: 'user', content: 'Summary of earlier work', timestamp: Date.now() }],
      })
    }, context)
    faux.setResponses([fauxAssistantMessage('done')])
    await (await root.submit({ type: 'input', content: 'continue' }, context)).wait(context)
    expect(notices).toEqual([])
    expect((await harness.snapshot(Ledger, root.id, context))?.decisions.a.state).toBe('applied')
    expect((await harness.snapshot(Ledger, root.id, context))?.decisions.removed).toBeUndefined()
    expect((await root.context(context)).head?.kind).toBe('pi.compaction')
  } finally {
    await harness.close(context)
  }
})
