import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { EntryRecord, GenerationHooks, HookApi } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import phase, { Phases } from '../extensions/phase/server.ts'
import { phaseState } from '../extensions/phase/state.ts'
import type { ClassifyService } from '../extensions/classify/server.ts'
import { until } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
const entry = (id: number, model: unknown, input = false) =>
  ({
    id,
    kind: input ? 'pi.user' : 'pi.assistant',
    model: [model],
    input,
  }) as unknown as EntryRecord
it('builds the bounded request, relative paths, stripped commands and failed results', () => {
  const entries = [entry(1, { role: 'user', content: '  Fix\n this  ' }, true)]
  for (let i = 0; i < 16; i++)
    entries.push(
      entry(i + 2, {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: `c${i}`,
            name: 'bash',
            arguments: {
              command: i === 15 ? 'cd "/my project"; pnpm test' : 'cd /project && rg test',
            },
          },
        ],
      }),
    )
  entries.push(
    entry(20, {
      role: 'toolResult',
      toolCallId: 'c15',
      isError: true,
      content: [{ type: 'text', text: 'Failed check' }],
    }),
  )
  let state = phaseState(entries, ['/project'])
  expect(state.request).toBe('Fix this')
  expect(state.recentTools).toHaveLength(15)
  expect(state.recentTools[0]?.args).toBe('rg test')
  expect(state.recentTools[14]).toEqual({ tool: 'bash', args: 'pnpm test', failed: 'Failed check' })
  entries.push(
    entry(21, {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking now' },
        ...['/project/src/a.ts', '/worktree/src/b.ts'].map((path) => ({
          type: 'toolCall',
          id: path,
          name: 'read',
          arguments: { path },
        })),
      ],
    }),
  )
  state = phaseState(entries, ['/project', '/worktree'])
  expect(state.recentTools.slice(-2).map((call) => call.args)).toEqual(['src/a.ts', 'src/b.ts'])
  expect(state.agentSaid).toBe('Checking now')
})

async function fixture(service?: ClassifyService) {
  const registry = createRegistry()
  let harness: Harness
  const extension = phase({
    harness: () => harness,
    projectRoot: '/project',
    conversations: () => [],
    use: (() => service) as Parameters<typeof phase>[0]['use'],
  })
  registry.install(extension)
  harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context)
  cleanups.push(() => harness.close(context))
  const root = await harness.root(context)
  harness.resume()
  const hooks = extension.hooks![0].handlers as GenerationHooks
  const api = { conversationId: root.id } as HookApi
  const round = () => hooks.afterTools(1 as never, [], api, context)
  const snapshot = () => harness.snapshot(Phases, ROOT_CONVERSATION_ID, context)
  const yieldRun = () => hooks.onYield({} as never, api, context)
  return { harness, root, round, snapshot, yieldRun }
}
const answer = (confidence: number, choice = 'editing') => ({
  model: 'fake',
  answers: { phase: { type: 'choice' as const, choice, confidence, probabilities: {} } },
  usage: { inputTokens: 0 },
})
it('allows one in flight, stores the first low answer, holds later low answers and clears on yield', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ask = vi.fn<ClassifyService['ask']>(async () => {
    await gate
    return answer(0.4)
  })
  const f = await fixture({ ask })
  await f.round()
  await until(() => ask.mock.calls.length === 1)
  const pending = (await f.snapshot())!.conversations[f.root.id].pending
  await f.round()
  expect((await f.snapshot())!.conversations[f.root.id].pending).toBe(pending)
  expect(ask).toHaveBeenCalledTimes(1)
  release()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.phase === 'editing')
  ask.mockImplementation(async () => answer(0.3, 'exploring'))
  await f.round()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.pending === undefined)
  expect((await f.snapshot())!.conversations[f.root.id].phase).toBe('editing')
  ask.mockImplementation(async () => answer(0.9, 'verifying'))
  await f.round()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.phase === 'verifying')
  await f.yieldRun()
  expect((await f.snapshot())?.conversations).toEqual({})
})
it('does not schedule without classify', async () => {
  const f = await fixture()
  await f.round()
  expect((await f.snapshot())?.conversations ?? {}).toEqual({})
  expect((await f.harness.inspect(context)).tasks).toHaveLength(0)
})
it('settles provider errors quietly and clears pending', async () => {
  const ask = vi.fn<ClassifyService['ask']>().mockResolvedValue(answer(0.9))
  const f = await fixture({ ask })
  await f.round()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.phase === 'editing')
  let taskId: number | undefined
  const stop = f.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type === 'task') taskId = change.value.id
    }
  })
  ask.mockRejectedValue(new Error('No key'))
  await f.round()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.pending === undefined)
  stop()
  expect((await f.snapshot())?.conversations[f.root.id]?.phase).toBe('editing')
  expect((await f.harness.getTask(taskId as never, context))?.state).toMatchObject({
    status: 'terminal',
    outcome: { status: 'completed', result: null },
  })
  expect((await f.harness.inspect(context)).tasks).toHaveLength(0)
})
it('does not resurrect a yielded row when an answer arrives late', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ask = vi.fn<ClassifyService['ask']>(async () => {
    await gate
    return answer(0.9)
  })
  const f = await fixture({ ask })
  await f.round()
  await until(() => ask.mock.calls.length === 1)
  await f.yieldRun()
  release()
  await until(async () => (await f.harness.inspect(context)).tasks.length === 0)
  expect((await f.snapshot())?.conversations).toEqual({})
})
