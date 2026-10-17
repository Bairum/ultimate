import { expect, it } from 'vitest'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { Roots, Tally } from '../extensions/lineage/server.ts'
import { definitionAgent, parseDefinition } from '../extensions/subagents/agents.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, sourceCopy, temp, until } from './helpers.ts'

it('seeds a listed root from a definition, branches with its reading, and refuses unsafe targets', async () => {
  const home = await temp()
  const server = await fauxServer({ ultimateRoot: await sourceCopy(home), home, userHome: home })
  try {
    const reader = await server.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const parent = await server.root.agent(context)
    for (const name of ['new_root', 'seed_tally', 'compact_tally'])
      expect(parent.tools.map((tool) => tool.name)).not.toContain(name)
    const definition = parseDefinition(
      '---\nname: reader\ndescription: Read\ntools: [new_root, seed_tally, compact_tally]\n---\nRead the project.',
      'reader.md',
    )
    await server.harness.commit(
      (tx) =>
        configure(
          tx,
          reader.id,
          definitionAgent({ ...definition, model: undefined }, parent, server.host.modelRuntime),
        ),
      context,
    )
    for (const name of ['new_root', 'seed_tally', 'compact_tally'])
      expect((await reader.agent(context)).tools.map((tool) => tool.name)).toContain(name)
    const route: FauxResponseFactory = async (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.at(-1)!
      const text =
        typeof last.content === 'string'
          ? last.content
          : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      if (last.role === 'user' && text.startsWith('SEED '))
        return fauxAssistantMessage([fauxToolCall('seed_tally', JSON.parse(text.slice(5)))], {
          stopReason: 'toolUse',
        })
      return fauxAssistantMessage('Read complete')
    }
    server.host.faux!.setResponses([route])
    await reader.submit(
      {
        type: 'input',
        content: 'SEED ' + JSON.stringify({ root: 1, text: 'Project reading: run pnpm test.' }),
      },
      context,
    )
    await reader.waitForIdle(context)
    const entries = (id: number) =>
      server.harness.commit(
        async (tx) => (await tx.scanEntries({ conversationId: id as ConversationId }, 100)).items,
        context,
      )
    const genesis = (await entries(1))[0]
    expect(genesis).toMatchObject({
      kind: 'pi.reset',
      head: genesis.id,
      data: { lineage: { tally: true } },
    })
    expect(genesis.model?.[0]?.content).toMatch(
      new RegExp(
        `^<tally from="#${reader.id}/[0-9]+">\\nProject reading: run pnpm test.\\n</tally>$`,
      ),
    )
    expect((await server.harness.snapshot(Tally, ROOT_CONVERSATION_ID, context))?.since).toBe(
      genesis.id,
    )
    await until(
      async () => (await server.harness.snapshot(Tally, ROOT_CONVERSATION_ID, context))!.tokens > 0,
    )

    const tool = server.host.registry
      .snapshot()
      .extension('lineage')!
      .tools!.find((candidate) => candidate.name === 'seed_tally')!
    const at = Number(/\/(\d+)">/.exec(genesis.model![0].content as string)![1])
    const api = {
      conversationId: reader.id,
      memo: async () => at,
      commit: (change: Parameters<typeof server.harness.commit>[0]) =>
        server.harness.commit(change, context),
    } as unknown as Parameters<typeof tool.execute>[1]
    expect((await entries(reader.id)).find((entry) => entry.id === at)?.kind).toBe('pi.assistant')
    // Re-enter with the source memo retained, as after a crash between placement and the tool result.
    await tool.execute({ root: 1, text: 'Project reading: run pnpm test.' }, api, context)
    expect(await entries(1)).toHaveLength(1)
    await expect(
      tool.execute({ root: 1, text: 'Different reading' }, api, context),
    ).rejects.toThrow('already a tally')

    const branch = await post(server, '/api/extensions/lineage/actions/branch', {
      args: { from: 1, prompt: 'First task', isolated: false },
    })
    expect(branch.status).toBe(200)
    const conversation = (await server.harness.conversation(
      branch.data.result.id as ConversationId,
      context,
    ))!
    await until(async () =>
      (await conversation.context(context)).entries.some((entry) => entry.kind === 'pi.reset'),
    )
    expect(JSON.stringify((await conversation.context(context)).messages)).toContain(
      'Project reading: run pnpm test.',
    )

    // Branching moved the root tip; replay still recognises the original genesis.
    await tool.execute({ root: 1, text: 'Project reading: run pnpm test.' }, api, context)
    expect((await entries(1)).filter((entry) => entry.kind === 'pi.reset')).toHaveLength(1)

    await expect(tool.execute({ root: reader.id, text: 'x' }, api, context)).rejects.toThrow(
      'cannot seed itself',
    )
    const target = await server.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    await expect(tool.execute({ root: target.id, text: 'x' }, api, context)).rejects.toThrow(
      'not a listed root',
    )
    await server.harness.commit(async (tx) => {
      ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(target.id)
    }, context)
    await server.harness.commit(async (tx) => {
      await tx.appendEntry(target.id, { kind: 'test.history' })
    }, context)
    await expect(tool.execute({ root: target.id, text: 'x' }, api, context)).rejects.toThrow(
      'has entries',
    )
    await server.harness.waitForIdle(context)
  } finally {
    await server.close()
  }
})
