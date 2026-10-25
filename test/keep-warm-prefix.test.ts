import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { Message } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationsService } from '../extensions/conversations/api.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { ContextHygiene, Ledger } from '../extensions/context-hygiene/api.ts'
import { rewrite } from '../extensions/context-hygiene/rewrite.ts'
import { ping, docs } from '../extensions/keep-warm/server.ts'
import { fauxServer, temp } from './helpers.ts'

it.each([false, true])(
  'replays the real generation prefix (applied hygiene=%s)',
  async (applied) => {
    const home = await temp('ultimate-keep-warm-')
    const projectRoot = join(home, 'project')
    await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
    await writeFile(
      join(projectRoot, '.ultimate/settings.json'),
      JSON.stringify({
        summaryModel: 'unavailable/test',
        extensions: { enable: ['context-hygiene'] },
      }),
    )
    const server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot,
      userHome: home,
      home: join(home, 'state'),
    })
    try {
      const conversation = await server.harness.root(context)
      const id = conversation.id
      await server.harness.commit(async (tx) => {
        ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = id
      }, context)
      server.host.faux!.setResponses([fauxAssistantMessage('ready')])
      await (
        await conversation.submit(
          { type: 'input', content: 'initialize the cached context' },
          context,
        )
      ).wait(context)
      await server.harness.commit(async (tx) => {
        // A committed result whose applied decision the ping and generation must both honor.
        await tx.appendEntry(id, {
          kind: 'test.seed',
          model: [fauxAssistantMessage([fauxToolCall('read', { path: 'x' }, { id: 'read-1' })])],
        })
        await tx.appendEntry(id, {
          kind: 'test.seed',
          model: [
            {
              role: 'toolResult',
              toolCallId: 'read-1',
              toolName: 'read',
              content: [{ type: 'text', text: 'old result' }],
              isError: false,
              timestamp: 1,
            },
          ],
        })
        if (applied)
          (await tx.doc(Ledger, id)).decisions['read-1'] = {
            state: 'applied',
            reason: 'empty',
            tokens: 10,
            at: 1,
          }
      }, context)
      const sent: (readonly Message[])[] = []
      server.host.faux!.setResponses(
        [0, 1].map(() => (request) => {
          sent.push(request.messages)
          return fauxAssistantMessage('ok')
        }),
      )
      const accountResponse = vi.fn<ConversationsService['accountResponse']>()
      const host = {
        harness: () => server.harness,
        modelRuntime: server.host.modelRuntime,
        want: (api: unknown) => (api === ContextHygiene ? { rewrite } : undefined),
        need: () => ({ accountResponse }),
      } as unknown as ExtensionHost
      const model = (await conversation.agent(context)).model!
      await ping(host, {
        id,
        provider: model.provider,
        model: model.modelId,
        lastRequest: Date.now(),
      })
      expect(sent).toHaveLength(1)
      const question = sent[0].at(-1)!
      expect(question.role).toBe('user')
      if (question.role !== 'user') throw new Error('Expected question')
      const result = await (
        await conversation.submit({ type: 'input', content: question.content }, context)
      ).wait(context)
      expect(result.status).toBe('done')
      expect(sent).toHaveLength(2)
      // Input timestamps are metadata, not part of the provider's prompt.
      const prefix = (messages: readonly Message[]) => messages.slice(0, -1)
      expect(prefix(sent[0])).toEqual(prefix(sent[1]))
      expect(sent[0].find((message) => message.role === 'toolResult')?.content).toEqual([
        { type: 'text', text: applied ? '[Elided: empty result]' : 'old result' },
      ])
      expect(accountResponse).toHaveBeenCalledWith(
        expect.anything(),
        id,
        expect.objectContaining({ text: '' }),
      )
      const state = await server.harness.snapshot(docs[0], ROOT_CONVERSATION_ID, context)
      expect(state?.pings).toBe(1)
      expect(state?.conversations?.[id]).toMatchObject({
        model: model.modelId,
        read: expect.any(Number),
      })
    } finally {
      await server.close()
    }
  },
)
