import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  defineDoc,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { GenerationHooks, HookApi } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import stopCheck, { CONTINUE } from '../extensions/stop-check/server.ts'
import { ClassifyApi } from '../extensions/classify/api.ts'
import type { ClassifyService } from '../extensions/classify/api.ts'
import { Roots } from '../extensions/lineage/api.ts'
import { Profile, Standing } from '../extensions/subagents/api.ts'

const SideChat = defineDoc<{ of?: number }>({
  kind: 'sidechat',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function fixture(options: { classify?: boolean; settings?: object } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'stop-check-'))
  await mkdir(join(home, '.ultimate'))
  await writeFile(join(home, '.ultimate/settings.json'), JSON.stringify(options.settings ?? {}))
  const registry = createRegistry()
  const models = createModels()
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context)
  await harness.root(context)
  const created = await harness.commit(
    (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
    context,
  )
  const id = created.id
  let noul = 0.97
  const ask = vi.fn<ClassifyService['ask']>(async () => ({
    model: 'jev',
    answers: { stop: { type: 'noul', noul } },
    usage: { inputTokens: 1 },
  }))
  const count = vi.fn<ClassifyService['count']>()
  let label: string | undefined
  const notice = vi.fn<(message: string) => void>()
  const host = {
    userHome: home,
    projectRoot: home,
    harness: () => harness,
    projectSettings: async () => ({}),
    notice,
    conversations: () => [{ id, label, busy: true, cwd: home }],
    doc: (kind: string) => (kind === 'sidechat' ? SideChat : undefined),
    want: (api: unknown) =>
      api === ClassifyApi && options.classify !== false ? { ask, count } : undefined,
  } as unknown as ExtensionHost
  const extension = stopCheck(host)
  registry.install(extension)
  const hooks = extension.hooks![0].handlers as GenerationHooks
  const conversation = (await harness.conversation(id, context))!
  // Held scheduling: the run exists with its input, and no generation calls a model.
  harness.hold()
  await conversation.submit({ type: 'input', content: 'fix the failing test' }, context)
  let task = 1000
  const api = () => {
    const memos = new Map<string, JsonValue>()
    return {
      conversationId: id,
      taskId: ++task,
      models,
      snapshot: harness.snapshot.bind(harness),
      memo: async (key: string, value: unknown, ctx?: unknown) => {
        if (ctx === undefined) return memos.get(key)
        if (!memos.has(key)) memos.set(key, value as JsonValue)
        return memos.get(key)
      },
    } as unknown as HookApi
  }
  const define = (definition: string) =>
    harness.commit(async (tx) => {
      ;(await tx.doc(Profile, id)).definition = definition
    }, context)
  const cards = async () =>
    (await conversation.entries({ order: 'ascending' }, 50, undefined, context)).items.filter(
      (e) => e.kind === 'stop-check.continued',
    )
  cleanups.push(async () => {
    await harness.close(context)
    await rm(home, { recursive: true, force: true })
  })
  return {
    harness,
    notice,
    id,
    ask,
    count,
    hooks,
    api,
    define,
    cards,
    setLabel: (value: string) => (label = value),
    setNoul: (value: number) => (noul = value),
  }
}
const promise = fauxAssistantMessage('Found it. Let me fix it now.')

it('continues a subagent once per run, with a card that never enters the model context', async () => {
  const f = await fixture()
  await f.define('worker')
  const api = f.api()
  expect(await f.hooks.onYield(promise, api, context)).toEqual({ continue: CONTINUE })
  expect(f.ask.mock.calls[0][0].state).toEqual({
    request: 'fix the failing test',
    message: 'Found it. Let me fix it now.',
  })
  // A replay of the same generation after a crash keeps its decision without asking again or adding a card.
  expect(await f.hooks.onYield(promise, api, context)).toEqual({ continue: CONTINUE })
  const cards = await f.cards()
  expect(cards).toHaveLength(1)
  expect(cards[0].data).toEqual({ p: 0.97, excerpt: 'Found it. Let me fix it now.' })
  expect(cards[0].model).toBeUndefined()
  // The continuation's own generation never continues again in the same run.
  expect(await f.hooks.onYield(promise, f.api(), context)).toBeUndefined()
  expect(f.ask).toHaveBeenCalledTimes(1)
  // Counted once for the adoption review, not again on the replay.
  expect(f.count).toHaveBeenCalledExactlyOnceWith('stop-check.continued', { ms: 0 })
  expect(f.notice).not.toHaveBeenCalled()
})

it('lets an answer below the threshold end the turn', async () => {
  const f = await fixture()
  f.setLabel('coordinator')
  f.setNoul(0.89)
  expect(await f.hooks.onYield(promise, f.api(), context)).toBeUndefined()
  expect(f.ask).toHaveBeenCalledTimes(1)
  expect(await f.cards()).toHaveLength(0)
})

it('skips @ultimate, roots, side chats, conversations without a definition and a missing judge', async () => {
  const skipped = async (f: Awaited<ReturnType<typeof fixture>>) => {
    expect(await f.hooks.onYield(promise, f.api(), context)).toBeUndefined()
    expect(f.ask).not.toHaveBeenCalled()
    expect(await f.cards()).toHaveLength(0)
  }
  await skipped(await fixture())
  const ultimate = await fixture()
  await ultimate.define('ultimate')
  await ultimate.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate.id
  }, context)
  await skipped(ultimate)
  const root = await fixture()
  await root.define('coordinator')
  await root.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(root.id)
  }, context)
  await skipped(root)
  const side = await fixture()
  await side.define('coordinator')
  await side.harness.commit(async (tx) => {
    ;(await tx.doc(SideChat, side.id)).of = ROOT_CONVERSATION_ID
  }, context)
  await skipped(side)
  const absent = await fixture({ classify: false })
  await absent.define('worker')
  await skipped(absent)
  const off = await fixture({ settings: { stopCheck: false } })
  await off.define('worker')
  await skipped(off)
})
