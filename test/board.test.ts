import { temp, removeTemp, until, fauxServer, linkDependencies } from './helpers.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { awaitWithContext } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { Type } from '@earendil-works/pi-ai'
import {
  configure,
  defineExtension,
  defineTask,
  defineTool,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Task, TaskId } from '@earendil-works/pi-durable'
import type { Context, JsonValue } from '@earendil-works/chord'
import { afterEach, expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import { Metadata } from '../server/metadata.ts'
import board, { Board, actions, userActions } from '../extensions/board/server.ts'
import type { BoardService } from '../extensions/board/server.ts'
import {
  Branch,
  BranchReceipts,
  Roots,
  Tally,
  rootOf,
  startBranch,
} from '../extensions/lineage/server.ts'
import type { BranchInput } from '../extensions/lineage/server.ts'
import { Standing, Subagents } from '../extensions/subagents/server.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'

const homes: string[] = []
const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const home of homes.splice(0)) await removeTemp(home)
})
const anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'board-test.anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, caller) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        caller,
      ),
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})
function gate() {
  let release!: () => void
  return {
    promise: new Promise<void>((done) => {
      release = done
    }),
    release: () => release(),
  }
}
async function fixture(
  replyGate?: ReturnType<typeof gate>,
  sendGate?: {
    gate: ReturnType<typeof gate>
    afterMemo: boolean
    entered: boolean
    taskId?: TaskId
  },
) {
  const home = await temp('ultimate-board-')
  homes.push(home)
  await mkdir(join(home, 'agents'), { recursive: true })
  await writeFile(
    join(home, 'agents/coordinator.md'),
    await readFile(resolve('agents/coordinator.md'), 'utf8'),
  )
  const prepared = await prepareHarness({ home, ultimateRoot: home, userHome: home, faux: true })
  let opened: OpenHost
  let service!: BoardService
  const hold = gate()
  let holding = false
  const openers: (() => Promise<void>)[] = []
  const closers: (() => Promise<void>)[] = []
  const host = {
    ...prepared,
    metadata: Metadata,
    events: { emit: () => {} },
    harness: () => opened.harness,
    provide: (_name: string, value: BoardService) => {
      service = value
    },
    use: (name: string) =>
      name === 'subagents'
        ? {
            residents: async () => [{ name: 'scout', description: 'Search' }],
            standing: async () => recipient.id,
          }
        : name === 'workspaces'
          ? { doc: Workspaces, git: async () => '' }
          : name === 'lineage'
            ? {
                rootOf: (id: number, ctx: Context) => rootOf(host, id, ctx),
                branch: (input: BranchInput, ctx: Context) => startBranch(host, input, ctx),
              }
            : undefined,
    onOpen: (callback: () => Promise<void>) => openers.push(callback),
    onClose: (cleanup: () => Promise<void>) => closers.push(cleanup),
    notice: (message: string) => {
      throw new Error(message)
    },
    conversations: () => [],
    doc: (kind: string) =>
      kind === 'lineage.roots' ? Roots : kind === 'lineage.tally' ? Tally : undefined,
  } as unknown as ExtensionHost
  let backend = board(host)
  if (sendGate)
    backend = {
      ...backend,
      tools: backend.tools!.map((tool) => ({
        ...tool,
        execute: (...[input, api, ctx]: Parameters<typeof tool.execute>) =>
          tool.execute(
            input,
            {
              ...api,
              memo: async (name: string, value: JsonValue | Context, memoContext?: Context) => {
                if (memoContext === undefined) return api.memo(name, value as Context)
                sendGate.taskId = api.taskId
                if (!sendGate.afterMemo) {
                  sendGate.entered = true
                  await awaitWithContext(sendGate.gate.promise, memoContext)
                }
                const result = await api.memo(name, value as JsonValue, memoContext)
                if (sendGate.afterMemo) {
                  sendGate.entered = true
                  await awaitWithContext(sendGate.gate.promise, memoContext)
                }
                return result
              },
            },
            ctx,
          ),
      })),
    }
  prepared.registry.install(
    replyGate
      ? {
          ...backend,
          tasks: backend.tasks!.map((t) => {
            const task = t as unknown as Task<JsonValue, { phase: string }, JsonValue, object>
            return {
              definition: {
                ...task.definition,
                phases: {
                  ...task.definition.phases,
                  reply: async (...args: Parameters<typeof task.definition.phases.reply>) => {
                    await awaitWithContext(replyGate.promise, args[2])
                    await task.definition.phases.reply(...args)
                  },
                },
              },
            }
          }),
        }
      : backend,
  )
  prepared.registry.install(
    defineExtension({
      name: 'test-hold',
      tasks: [anchor],
      tools: [
        defineTool({
          name: 'hold',
          description: 'Hold the current run',
          parameters: Type.Object({}),
          // Waiting has no side effects; replay simply waits on the same test gate.
          replay: 'safe',
          async execute(_input, _api, ctx) {
            holding = true
            await awaitWithContext(hold.promise, ctx)
            return { output: [{ type: 'text', text: 'released' }] }
          },
        }),
      ],
    }),
  )
  const observed: string[] = []
  const transcripts: string[] = []
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    transcripts.push(JSON.stringify(transcript.messages))
    const last = transcript.messages.findLast((m) => m.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
    observed.push(text)
    if (last.role === 'user' && text.startsWith('BRANCH '))
      return fauxAssistantMessage([fauxToolCall('branch', JSON.parse(text.slice(7)))], {
        stopReason: 'toolUse',
      })
    const command = text.startsWith('Message from') ? text.split('\n')[1] : text
    if (last.role === 'user' && command.startsWith('SEND '))
      return fauxAssistantMessage([fauxToolCall('message', JSON.parse(command.slice(5)))], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && (text === 'HOLD' || text.includes('\nHOLD')))
      return fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
    if (last.role === 'user' && text.startsWith('Message from') && text.includes('NOANSWER'))
      return fauxAssistantMessage([])
    return fauxAssistantMessage([fauxText(last.role === 'toolResult' ? 'Done' : `Answer: ${text}`)])
  }
  prepared.faux!.setResponses([route])
  const open = async () => {
    opened = await prepared.open()
    const current = opened
    const close = current.close.bind(current)
    current.close = async () => {
      hosts.splice(hosts.indexOf(current), 1)
      for (const cleanup of closers) await cleanup()
      await close()
    }
    hosts.push(opened)
    for (const opener of openers) await opener()
    return opened
  }
  await open()
  const recipient = await opened!.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const agent = await opened!.root.agent(context)
  await opened!.harness.commit(
    (tx) => configure(tx, recipient.id, { model: agent.model, tools: agent.tools }),
    context,
  )
  const log = () => opened.harness.snapshot(Board, ROOT_CONVERSATION_ID, context)
  const action = () => ({ host, signal: new AbortController().signal }) as ActionContext
  const send = async (to: string, text = 'Hello', extra = {}) => {
    await (
      await opened.root.submit(
        { type: 'input', content: `SEND ${JSON.stringify({ to, text, ...extra })}` },
        context,
      )
    ).wait(context)
  }
  return {
    host,
    get opened() {
      return opened
    },
    recipient,
    send,
    log,
    action,
    service: () => service,
    open,
    hold,
    holding: () => holding,
    observed,
    transcripts,
  }
}
async function replies(f: Awaited<ReturnType<typeof fixture>>) {
  const view = await f.opened.root.viewState(context)
  const entries = view.value.entries.filter((e) => e.kind === 'board.reply')
  view.dispose()
  return entries
}
it('wakes an idle recipient and returns one typed reply; one-way messages return nothing', async () => {
  const f = await fixture()
  await f.send(`#${f.recipient.id}`)
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages.map((m) => [m.from, m.to, m.state])).toEqual([
    [1, f.recipient.id, 'answered'],
    [f.recipient.id, 1, 'delivered'],
  ])
  await f.send(String(f.recipient.id), 'One way', { reply: false })
  await until(async () => (await f.log())!.messages.at(-1)?.state === 'delivered')
  await f.recipient.waitForIdle(context)
  expect(await replies(f)).toHaveLength(1)
  expect(f.observed.some((t) => t.includes('One way'))).toBe(true)
})
it('records a one-way input answer without returning it to the sender', async () => {
  const f = await fixture()
  await f.send(String(f.recipient.id), 'One-way update', { reply: false })
  await until(async () => (await f.log())!.messages[0]?.state === 'delivered')
  await f.recipient.waitForIdle(context)
  expect(f.observed).toContain(
    'Message from #1:\nOne-way update\nOne-way message: #1 expects no answer, and your answer here is not sent to it. If it needs to hear from you, message it.',
  )
  await until(async () => (await f.log())!.messages[0]?.answer !== undefined)
  const log = (await f.log())!
  expect(log.messages).toHaveLength(1)
  expect(log.messages[0]).toMatchObject({ state: 'delivered', reply: false })
  const view = await f.recipient.viewState(context)
  expect(view.value.entries.find((e) => e.id === log.messages[0].answer)?.kind).toBe('pi.assistant')
  view.dispose()
  expect(await replies(f)).toHaveLength(0)
})
async function worker(f: Awaited<ReturnType<typeof fixture>>) {
  const agent = await f.opened.root.agent(context)
  const childId = await f.opened.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: ROOT_CONVERSATION_ID,
      background: true,
    })
    const { id } = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
    await configure(tx, id, { model: agent.model, tools: agent.tools })
    ;(await tx.doc(Subagents, ROOT_CONVERSATION_ID)).agents[String(id)] = {
      conversationId: id,
      agent: 'worker',
      background: true,
      reported: [],
    }
    return id
  }, context)
  return (await f.opened.harness.conversation(childId, context))!
}
it('places an idle parent update as a note without starting a run', async () => {
  const f = await fixture()
  const child = await worker(f)
  await (
    await child.submit(
      { type: 'input', content: 'SEND {"to":"#1","text":"Progress","reply":false}' },
      context,
    )
  ).wait(context)
  await until(async () => (await f.log())!.messages[0]?.state === 'delivered')
  const view = await f.opened.root.viewState(context)
  const note = view.value.entries.find((e) => e.kind === 'board.message')!
  expect(note.data).toMatchObject({ from: child.id, reply: false, delivery: 'note' })
  expect(note.input).not.toBe(true)
  expect(
    view.value.entries.filter((e) => e.id > note.id && e.kind === 'pi.assistant'),
  ).toHaveLength(0)
  view.dispose()
  const page = await f.host.scanSubmissions(
    { conversationId: ROOT_CONVERSATION_ID },
    100,
    undefined,
    context,
  )
  expect(page.items.find((s) => s.requestId === 'board:1')).toMatchObject({ type: 'write' })
  expect((await f.log())!.messages[0].answer).toBeUndefined()
})
it('places a busy parent note at its next boundary for the model to read', async () => {
  const f = await fixture()
  const child = await worker(f)
  await f.opened.root.submit({ type: 'input', content: 'HOLD' }, context)
  await until(f.holding)
  await (
    await child.submit(
      { type: 'input', content: 'SEND {"to":"#1","text":"Busy progress","reply":false}' },
      context,
    )
  ).wait(context)
  await until(async () => (await f.log())!.messages.length === 1)
  const page = await f.host.scanSubmissions(
    { conversationId: ROOT_CONVERSATION_ID },
    100,
    undefined,
    context,
  )
  expect(page.items.find((s) => s.requestId === 'board:1')).toMatchObject({
    type: 'write',
    status: 'queued',
  })
  f.hold.release()
  await f.opened.root.waitForIdle(context)
  await until(async () => (await f.log())!.messages[0]?.state === 'delivered')
  expect(
    f.transcripts.some((t) =>
      t.includes(`Note from #${child.id} (one-way update, no answer goes back):\\nBusy progress`),
    ),
  ).toBe(true)
})
it('still wakes a parent for a worker question and returns its typed reply', async () => {
  const f = await fixture()
  const child = await worker(f)
  await (
    await child.submit(
      { type: 'input', content: 'SEND {"to":"#1","text":"Question?","reply":true}' },
      context,
    )
  ).wait(context)
  await until(async () => (await f.log())!.messages[0]?.state === 'answered')
  await child.waitForIdle(context)
  const parentView = await f.opened.root.viewState(context)
  expect(parentView.value.entries.find((e) => e.kind === 'board.message')?.data).toMatchObject({
    reply: true,
    delivery: 'followUp',
  })
  parentView.dispose()
  const view = await child.viewState(context)
  expect(view.value.entries.find((e) => e.kind === 'board.reply')?.data).toMatchObject({
    from: 1,
    re: 1,
  })
  view.dispose()
})
it('refuses messaging a sender while answering, then allows it after the answer', async () => {
  const f = await fixture()
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ROOT_CONVERSATION_ID
  }, context)
  await f.send('@scout', 'SEND ' + JSON.stringify({ to: '#1', text: 'Duplicate' }))
  await until(async () => (await replies(f)).length === 1)
  expect(f.observed).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "Your answer to #1 (@ultimate)'s message 1 is sent back automatically. Answer instead of messaging.",
      ),
    ]),
  )
  expect((await f.log())!.messages).toHaveLength(2)
  expect(f.observed).toContain(
    'Message from #1 (@ultimate):\nSEND ' +
      JSON.stringify({ to: '#1', text: 'Duplicate' }) +
      '\nAnswer here; your answer is sent to #1 (@ultimate) automatically. Do not use message to reply.',
  )
  await (
    await f.recipient.submit(
      { type: 'input', content: 'SEND ' + JSON.stringify({ to: '#1', text: 'After answer' }) },
      context,
    )
  ).wait(context)
  await until(async () => (await f.log())!.messages.length === 4)
  expect((await f.log())!.messages[2]).toMatchObject({
    from: f.recipient.id,
    to: 1,
    text: 'After answer',
    state: 'answered',
  })
})
it('allows one-way updates to the sender while answering', async () => {
  const f = await fixture()
  await f.send('@scout', 'SEND ' + JSON.stringify({ to: '#1', text: 'Progress', reply: false }))
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages).toMatchObject([
    { from: 1, to: f.recipient.id, state: 'answered' },
    { from: f.recipient.id, to: 1, text: 'Progress', reply: false, state: 'delivered' },
    { from: f.recipient.id, to: 1, re: 1 },
  ])
})
it('allows messaging other recipients while answering', async () => {
  const f = await fixture()
  await f.send('@scout', 'SEND ' + JSON.stringify({ to: 'user', text: 'Update' }))
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages[1]).toMatchObject({
    from: f.recipient.id,
    to: 'user',
    text: 'Update',
  })
})
it('names the lander in both message and reply model text', async () => {
  const f = await fixture()
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).landerConversations.test = f.recipient.id
  }, context)
  await f.send(`#${f.recipient.id}`)
  await until(() =>
    f.observed.some((text) => text.startsWith(`Reply from #${f.recipient.id} (@lander)`)),
  )
  await (
    await f.recipient.submit(
      {
        type: 'input',
        content: 'SEND ' + JSON.stringify({ to: '#1', text: 'Lander update', reply: false }),
      },
      context,
    )
  ).wait(context)
  await until(() =>
    f.observed.some((text) => text.startsWith(`Message from #${f.recipient.id} (@lander)`)),
  )
  expect(f.observed).toEqual(
    expect.arrayContaining([
      expect.stringContaining(`Reply from #${f.recipient.id} (@lander) to your message`),
      expect.stringContaining(`Message from #${f.recipient.id} (@lander):`),
    ]),
  )
})
it('resolves a standing address and returns unanswered inputs as failure replies', async () => {
  const f = await fixture()
  await f.send('@scout', 'NOANSWER')
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages).toMatchObject([
    { to: f.recipient.id, state: 'failed', error: expect.stringContaining('without an answer') },
    { from: f.recipient.id, to: 1, re: 1, state: 'failed' },
  ])
  expect((await replies(f))[0].data).toMatchObject({ failed: true })
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).scout = f.recipient.id
  }, context)
  expect(await actions.addresses({}, f.action())).toMatchObject({
    agents: [{ name: 'scout', description: 'Search', id: f.recipient.id }],
  })
  await expect(actions.post({ to: '@lander', text: 'Hi' }, f.action())).rejects.toThrow(
    'No recipient for @lander',
  )
})
it('logs user inbox items without running and posts answers back to the user', async () => {
  const f = await fixture()
  await f.send('user', 'Inbox')
  expect((await f.log())!.readUpTo).toBe(0)
  expect((await f.log())!.messages).toMatchObject([{ to: 'user', text: 'Inbox' }])
  expect(f.observed.filter((t) => t.includes('Message from'))).toHaveLength(0)
  await actions.post({ to: `#${f.recipient.id}`, text: 'From user', re: 1 }, f.action())
  await until(async () => (await f.log())!.messages.length === 3)
  expect((await f.log())!.messages[2]).toMatchObject({ to: 'user', from: f.recipient.id, re: 2 })
  expect(await replies(f)).toHaveLength(0)
})
it('answers questions to the user when the user replies, posts anew, or types in the conversation', async () => {
  const f = await fixture()
  const ask = async (text: string, reply = true) => {
    await (
      await f.recipient.submit(
        { type: 'input', content: 'SEND ' + JSON.stringify({ to: 'user', text, reply }) },
        context,
      )
    ).wait(context)
    return (await f.log())!.messages.at(-1)!
  }
  const state = async (id: number) => (await f.log())!.messages.find((m) => m.id === id)?.state

  // Asking typed into the recipient leaves that question open: only later input answers it.
  const replied = await ask('Which option?')
  expect(replied).toMatchObject({ to: 'user', reply: true, state: 'delivered' })
  await actions.post({ to: `#${f.recipient.id}`, text: 'Option 1', re: replied.id }, f.action())
  expect(await state(replied.id)).toBe('answered')

  const report = await ask('Landed', false)
  const posted = await ask('Ship it?')
  await actions.post({ to: `#${f.recipient.id}`, text: 'Also add a flag' }, f.action())
  expect(await state(posted.id)).toBe('answered')
  expect(await state(report.id)).toBe('delivered')

  const typed = await ask('Keep going?')
  await (await f.recipient.submit({ type: 'input', content: 'Yes' }, context)).wait(context)
  await until(async () => (await state(typed.id)) === 'answered')

  // The root's question stays open: the user wrote to another conversation.
  await f.send('user', 'Root question')
  const root = (await f.log())!.messages.at(-1)!
  await actions.post({ to: `#${f.recipient.id}`, text: 'Elsewhere' }, f.action())
  await (await f.recipient.submit({ type: 'input', content: 'More' }, context)).wait(context)
  expect(await state(root.id)).toBe('delivered')
})
it('atomically admits only one answer-card reply through the Board service', async () => {
  const f = await fixture()
  await f.send('user', 'Keep it running?')
  const id = (await f.log())!.messages.at(-1)!.id
  const results = await Promise.allSettled([
    f.service().answer(id, 'Q: Keep it running?\nA: Yes', context),
    f.service().answer(id, 'Q: Keep it running?\nA: No', context),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(
    String(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ),
  ).toContain('These questions are no longer open')
  expect(
    (await f.log())!.messages.filter((message) => message.re === id && message.from === 'user'),
  ).toHaveLength(1)
  expect((await f.log())!.messages.find((message) => message.id === id)?.state).toBe('answered')
})

it('lets a subagent message only the conversation that started it', async () => {
  const f = await fixture()
  const agent = await f.opened.root.agent(context)
  const child = (subagent: boolean) =>
    f.opened.harness.commit(async (tx) => {
      const owner = await tx.createTask(anchor, null, {
        ownership: { kind: 'conversation' },
        conversationId: ROOT_CONVERSATION_ID,
        background: true,
      })
      const { id } = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
      await configure(tx, id, { model: agent.model, tools: agent.tools })
      if (subagent)
        (await tx.doc(Subagents, ROOT_CONVERSATION_ID)).agents[String(id)] = {
          conversationId: id,
          agent: 'worker',
          background: true,
          reported: [],
        }
      return id
    }, context)
  const send = async (from: ConversationId, to: string) => {
    const conversation = await f.opened.harness.conversation(from, context)
    await (
      await conversation!.submit(
        {
          type: 'input',
          content: 'SEND ' + JSON.stringify({ to, text: `To ${to}`, reply: false }),
        },
        context,
      )
    ).wait(context)
  }

  const workerId = await child(true)
  await send(workerId, 'user')
  await send(workerId, `#${f.recipient.id}`)
  await send(workerId, '#1')
  expect(f.observed.filter((text) => text.includes('message only #1'))).toHaveLength(2)
  expect((await f.log())!.messages.map((m) => [m.from, m.to])).toEqual([[workerId, 1]])
  const view = await (await f.opened.harness.conversation(workerId, context))!.viewState(context)
  expect(JSON.stringify(view.value.entries)).toContain('Use message only to update #1')
  view.dispose()

  // An owned conversation that is no subagent, such as an automation run, still reaches the user.
  const run = await child(false)
  await send(run, 'user')
  expect((await f.log())!.messages.at(-1)).toMatchObject({ from: run, to: 'user' })
})
it('refuses self, unknown ids, tally roots and unknown names with valid names', async () => {
  const f = await fixture()
  await expect(actions.post({ to: '999', text: 'x' }, f.action())).rejects.toThrow(
    'Unknown conversation',
  )
  await expect(actions.post({ to: '@missing', text: 'x' }, f.action())).rejects.toThrow('@scout')
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(f.recipient.id)
    ;(await tx.doc(Tally, f.recipient.id)).since = 2
  }, context)
  await expect(actions.post({ to: String(f.recipient.id), text: 'x' }, f.action())).rejects.toThrow(
    'use note',
  )
  await f.send('#1')
  const view = await f.opened.root.viewState(context)
  expect(JSON.stringify(view.value.entries)).toContain('cannot message yourself')
  view.dispose()
})
it('bounds the log, advances read monotonically, and declares user-only actions', async () => {
  const f = await fixture()
  await f.opened.harness.commit(async (tx) => {
    for (let i = 0; i < 310; i++)
      await f.service().record(tx, { from: 1, to: 'user', text: String(i), kind: 'landing' })
  }, context)
  expect((await f.log())!.messages).toHaveLength(300)
  expect((await f.log())!.messages[0].id).toBe(11)
  await actions.read({ upTo: 200 }, f.action())
  await actions.read({ upTo: 100 }, f.action())
  expect((await f.log())!.readUpTo).toBe(200)
  expect(userActions).toEqual(['post', 'read'])
})
it('queues a busy recipient as follow-up, or steers its current run', async () => {
  for (const steer of [false, true]) {
    const f = await fixture()
    await f.recipient.submit({ type: 'input', content: 'HOLD' }, context)
    await until(f.holding)
    await f.send(String(f.recipient.id), 'Busy message', { steer })
    const page = await f.host.scanSubmissions(
      { conversationId: f.recipient.id },
      100,
      undefined,
      context,
    )
    expect(page.items.find((s) => s.requestId === 'board:1')).toMatchObject({ status: 'queued' })
    expect(f.observed.some((t) => t.startsWith('Message from') && t.includes('Busy message'))).toBe(
      false,
    )
    f.hold.release()
    await until(async () => (await replies(f)).length === 1)
    expect(f.observed.some((t) => t.startsWith('Message from') && t.includes('Busy message'))).toBe(
      true,
    )
    const view = await f.recipient.viewState(context)
    expect(view.value.entries.find((e) => e.kind === 'board.message')?.data).toMatchObject({
      delivery: steer ? 'steer' : 'followUp',
    })
    view.dispose()
    const delivered = f.observed.findIndex(
      (t) => t.startsWith('Message from') && t.includes('Busy message'),
    )
    const released = f.observed.indexOf('released')
    expect(steer ? released === -1 : released < delivered).toBe(true)
  }
})
async function codemodeFixture() {
  const home = await temp('ultimate-board-actions-')
  homes.push(home)
  await mkdir(join(home, 'extensions/board'), { recursive: true })
  await mkdir(join(home, 'extensions/codemode'), { recursive: true })
  await mkdir(join(home, 'web'))
  await linkDependencies(home)
  await writeFile(
    join(home, 'extensions/board/server.ts'),
    `export { default, actions, docs, userActions } from ${JSON.stringify(resolve('extensions/board/server.ts'))}`,
  )
  await writeFile(
    join(home, 'extensions/codemode/server.ts'),
    `export { default, docs } from ${JSON.stringify(resolve('extensions/codemode/server.ts'))}`,
  )
  await writeFile(
    join(home, 'vite.config.ts'),
    "import { defineConfig } from 'vite-plus'; export default defineConfig({ root: 'web', optimizeDeps: { noDiscovery: true } })",
  )
  await writeFile(join(home, 'web/index.html'), '<html>Board actions</html>')
  return fauxServer({
    home: join(home, 'state'),
    ultimateRoot: home,
    projectRoot: home,
    userHome: home,
    faux: true,
    port: 0,
  })
}
it('rejects post and read through codemode at the installed action boundary', async () => {
  const server = await codemodeFixture()
  try {
    for (const action of ['post', 'read']) {
      server.host.faux!.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('codemode', {
              code: `return await ultimate.action('board', '${action}', ${action === 'post' ? "{to:'user',text:'fake'}" : '{upTo:1}'});`,
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Complete'),
      ])
      await (
        await server.root.submit({ type: 'input', content: 'Try action' }, context)
      ).wait(context)
      const view = await server.root.viewState(context)
      try {
        const result = view.value.entries.findLast((e) => e.kind === 'pi.tool-result')!
        expect(JSON.stringify(result)).toContain(`board/${action} is a user-only action`)
      } finally {
        view.dispose()
      }
    }
  } finally {
    await server.vite.watcher.close()
    await server.close()
  }
})
it('keeps sequential and parallel message calls distinct within one codemode script', async () => {
  const server = await codemodeFixture()
  try {
    server.host.faux!.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('codemode', {
            code: `
          await tools.message({to: 'user', text: 'Sequential 1'});
          await tools.message({to: 'user', text: 'Sequential 2'});
          await Promise.all([
            tools.message({to: 'user', text: 'Parallel 1'}),
            tools.message({to: 'user', text: 'Parallel 2'})
          ]);
        `,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Complete'),
    ])
    await (
      await server.root.submit({ type: 'input', content: 'Send four messages' }, context)
    ).wait(context)
    const log = await server.harness.snapshot(Board, ROOT_CONVERSATION_ID, context)
    expect(log?.messages.map((m) => m.text).toSorted()).toEqual([
      'Parallel 1',
      'Parallel 2',
      'Sequential 1',
      'Sequential 2',
    ])
    expect(new Set(log?.messages.map((m) => m.id)).size).toBe(4)
  } finally {
    await server.vite.watcher.close()
    await server.close()
  }
})
it('replays interrupted sends once, both before and after memoizing the message id', async () => {
  for (const afterMemo of [false, true]) {
    const sendGate = { gate: gate(), afterMemo, entered: false }
    const f = await fixture(undefined, sendGate)
    await f.opened.root.submit(
      { type: 'input', content: 'SEND {"to":"user","text":"One item"}' },
      context,
    )
    await until(() => sendGate.entered)
    expect((await f.log())!.messages).toHaveLength(1)
    await f.opened.close()
    await f.open()
    sendGate.gate.release()
    await f.opened.root.waitForIdle(context)
    expect((await f.log())!.messages).toMatchObject([{ id: 1, to: 'user', text: 'One item' }])
    expect((await f.log())!.next).toBe(2)
    const view = await f.opened.root.viewState(context)
    try {
      const result = view.value.entries.findLast((e) => e.kind === 'pi.tool-result')!
      expect(JSON.stringify(result)).toContain('Message 1 sent.')
    } finally {
      view.dispose()
    }
  }
})
it.each([false, true])(
  'replays a branch interrupted around memoization (afterMemo: %s)',
  async (afterMemo) => {
    const pause = {
      gate: gate(),
      afterMemo,
      entered: false,
      taskId: undefined as TaskId | undefined,
    }
    const f = await fixture(undefined, pause)
    const tool = (await f.opened.root.agent(context)).deferred.find(
      (candidate) => candidate.name === 'branch',
    )!
    await f.opened.harness.commit(async (tx) => {
      ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots = [1]
      await configure(tx, f.opened.root.id, { modelTools: { add: [tool] } })
    }, context)
    await f.opened.root.submit(
      {
        type: 'input',
        content: 'BRANCH ' + JSON.stringify({ prompt: 'Explore durably', isolated: false }),
      },
      context,
    )
    await until(() => pause.entered || f.observed.length > 1)
    expect(f.observed).toEqual([expect.stringContaining('BRANCH ')])
    expect(pause.entered).toBe(true)
    const branches = async () => {
      const conversations = await f.opened.harness.commit(
        (tx) => tx.scanConversations({}, 100),
        context,
      )
      const ids = []
      for (const conversation of conversations.items) {
        if (
          (await f.opened.harness.snapshot(Branch, conversation.id, context))?.branch?.intent ===
          'Explore durably'
        )
          ids.push(conversation.id)
      }
      return ids
    }
    const created = await branches()
    expect(created).toHaveLength(1)
    expect(pause.taskId).toBeDefined()
    const receipt = await f.opened.harness.snapshot(BranchReceipts, pause.taskId!, context)
    expect(Object.values(receipt!.branches)).toEqual(created)
    expect((await f.log())?.messages ?? []).toHaveLength(0)
    await f.opened.close()
    await f.open()
    pause.gate.release()
    await until(async () => (await replies(f)).length === 1)
    expect(await branches()).toEqual(created)
    await f.opened.root.waitForIdle(context)
    expect(await f.opened.harness.snapshot(BranchReceipts, pause.taskId!, context)).toBeUndefined()
    expect((await f.log())!.messages.filter((message) => message.to === created[0])).toMatchObject([
      { from: 1, text: 'Explore durably' },
    ])
    expect(
      (await f.log())!.messages.filter(
        (message) => message.from === created[0] && message.re !== undefined,
      ),
    ).toHaveLength(1)
  },
)
it('recovers once after input placement, before the recipient settles', async () => {
  const f = await fixture()
  await f.send(String(f.recipient.id), 'HOLD')
  await until(f.holding)
  await f.opened.close()
  await f.open()
  f.hold.release()
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages.filter((m) => m.re === 1)).toHaveLength(1)
})
it('recovers once after the answer is recorded but before reply submission', async () => {
  const g = gate()
  const f = await fixture(g)
  await f.send(String(f.recipient.id))
  await until(async () => (await f.log())!.messages.length === 2)
  expect(await replies(f)).toHaveLength(0)
  await f.opened.close()
  await f.open()
  g.release()
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages.filter((m) => m.re === 1)).toHaveLength(1)
})
