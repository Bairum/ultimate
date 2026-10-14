import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineDoc, defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { prepareHarness } from '../server/harness.ts'
import { temp, until } from './helpers.ts'

const Placed = defineDoc<{ count: number }>({
  kind: 'input-test.placed',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ count: 0 }),
})

it('places hook entries transactionally before initial and queued run inputs, not steering', async () => {
  const home = await temp()
  const gate = Promise.withResolvers<void>()
  let held = false
  let reject = false
  let calls = 0
  const open = async () => {
    const prepared = await prepareHarness({ ultimateRoot: home, userHome: home, home, faux: true })
    prepared.registry.install(
      defineExtension({
        name: 'input-test',
        hooks: [
          hook(GenerationTask, {
            beforeInput: async (_input, { tx, conversationId }) => {
              calls++
              const state = await tx.doc(Placed, conversationId)
              state.count++
              if (reject) throw new Error('reject placement')
              return {
                entries: [
                  {
                    kind: 'input-test.note',
                    data: { count: state.count },
                    model: [{ role: 'user', content: `before ${state.count}`, timestamp: 1 }],
                  },
                ],
              }
            },
          }),
        ],
      }),
    )
    prepared.faux!.setResponses([
      async () => {
        held = true
        await gate.promise
        return fauxAssistantMessage([fauxToolCall('unknown', {})], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('answer'),
      fauxAssistantMessage('next answer'),
    ])
    return prepared.open()
  }
  const f = await open()
  try {
    const first = await f.root.submit(
      { type: 'input', content: 'first', requestId: 'one' },
      context,
    )
    await until(() => held)
    const steer = await f.root.submit(
      { type: 'input', content: 'steer', whenBusy: 'steer' },
      context,
    )
    const next = await f.root.submit({ type: 'input', content: 'next' }, context)
    expect(calls).toBe(1)
    gate.resolve()
    await Promise.all([first.wait(context), steer.wait(context), next.wait(context)])
    const view = await f.root.context(context)
    expect(
      view.messages.filter((message) => message.role === 'user').map((message) => message.content),
    ).toEqual(['before 1', 'first', 'steer', 'before 2', 'next'])
    const notes = view.entries.filter((entry) => entry.kind === 'input-test.note')
    expect(notes).toHaveLength(2)
    expect(notes.every((entry) => entry.edits === undefined)).toBe(true)
    expect(calls).toBe(2)
    await f.root.submit({ type: 'input', content: 'first', requestId: 'one' }, context)
    expect(calls).toBe(2)
    reject = true
    await expect(f.root.submit({ type: 'input', content: 'rejected' }, context)).rejects.toThrow(
      'reject placement',
    )
    expect((await f.harness.snapshot(Placed, f.root.id, context))?.count).toBe(2)
    expect(
      (await f.root.context(context)).entries.filter((entry) => entry.kind === 'input-test.note'),
    ).toHaveLength(2)
  } finally {
    gate.resolve()
    await f.close()
  }
})
