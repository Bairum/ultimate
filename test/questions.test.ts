import { apis, eventHost, temp, until } from './helpers.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { awaitWithContext } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Task } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ConversationsService } from '../extensions/conversations/api.ts'
import { emit } from '../server/events.ts'
import { accountResponse, askSummaryModel } from '../extensions/conversations/summary.ts'
import { summaryModel } from '../extensions/conversations/summary-model.ts'
import boardExtension from '../extensions/board/server.ts'
import { Asked, Board } from '../extensions/board/api.ts'
import questionsExtension, {
  actions,
  BoardQuestions,
  asksUser,
  parseQuestions,
  QUESTIONS_SYSTEM,
  userActions,
} from '../extensions/questions/server.ts'
import { Standing } from '../extensions/subagents/api.ts'
import type { SubagentsService } from '../extensions/subagents/api.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'

const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})
function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, release: resolve }
}
async function fixture() {
  const home = await temp('ultimate-board-questions-')
  const prepared = await prepareHarness({ home, ultimateRoot: home, userHome: home, faux: true })
  let opened: OpenHost
  const services = new Map<string, unknown>()
  const openers: (() => Promise<void>)[] = []
  const closers: (() => Promise<void>)[] = []
  // Board's `board.asked` reaches questions' reactor through a real event log, as on a server.
  const events = eventHost(() => opened.harness, 'questions')
  openers.push(async () => void (await events.start()))
  closers.push(async () => void (await events.stop()))
  const host = {
    ...prepared,
    userHome: home,
    projectSettings: async () => ({}),
    harness: () => opened.harness,
    ...apis(services),
    doc: () => undefined,
    onOpen: (fn: () => Promise<void>) => openers.push(fn),
    onClose: (fn: () => Promise<void>) => closers.push(fn),
    emit: events.emit,
    react: events.react,
    notice: (message: string) => {
      throw new Error(message)
    },
  } as unknown as ExtensionHost
  services.set('conversations', {
    summaryModel: () => summaryModel(host),
    askSummaryModel,
    accountResponse,
  } satisfies Partial<ConversationsService>)
  // Board's core dependencies: no standing agents to list, no worktrees.
  services.set('subagents', { residents: async () => [] } satisfies Partial<SubagentsService>)
  services.set('workspaces', { doc: Workspaces })
  prepared.registry.install(boardExtension(host))
  const extension = questionsExtension(host)
  let beforeCommit: ReturnType<typeof gate> | undefined
  let committing = false
  prepared.registry.install({
    ...extension,
    tasks: extension.tasks!.map((value) => {
      const task = value as Task<JsonValue, { phase: string }, JsonValue, object>
      return {
        definition: {
          ...task.definition,
          phases: {
            ...task.definition.phases,
            extract: (
              ...[record, runtime, ctx]: Parameters<typeof task.definition.phases.extract>
            ) =>
              task.definition.phases.extract(
                record,
                {
                  ...runtime,
                  commit: async (...args) => {
                    if (beforeCommit) {
                      committing = true
                      await awaitWithContext(beforeCommit.promise, ctx)
                    }
                    return runtime.commit(...args)
                  },
                },
                ctx,
              ),
          },
        },
      }
    }),
  })
  let extraction: unknown = { questions: [{ text: 'Keep it running?', kind: 'confirm' }] }
  let hold: ReturnType<typeof gate> | undefined
  const extract = vi.fn<() => void>()
  const observed: string[] = []
  const extractionInputs: string[] = []
  const route: FauxResponseFactory = async (transcript) => {
    prepared.faux!.appendResponses([route])
    const first = transcript.messages[0]
    if (first?.role === 'system' && first.content === QUESTIONS_SYSTEM) {
      // The root stands in for @ultimate while sending, so its final answer to the typed SEND is read too; it asks nothing.
      if (transcript.messages.at(-1)?.content === 'Sent.')
        return fauxAssistantMessage([fauxText('{"questions":[]}')])
      const content = transcript.messages.at(-1)?.content
      if (typeof content === 'string') extractionInputs.push(content)
      extract()
      if (hold) await hold.promise
      return fauxAssistantMessage([fauxText(JSON.stringify(extraction))])
    }
    const last = transcript.messages.at(-1)!
    const text = typeof last.content === 'string' ? last.content : ''
    observed.push(text)
    if (last.role === 'user' && text.startsWith('ASK '))
      return fauxAssistantMessage([fauxText(text.slice(4))])
    if (last.role === 'user' && text.startsWith('SEND '))
      return fauxAssistantMessage([fauxToolCall('message', JSON.parse(text.slice(5)))], {
        stopReason: 'toolUse',
      })
    return fauxAssistantMessage([fauxText('Sent.')])
  }
  prepared.faux!.setResponses([route])
  const open = async () => {
    opened = await prepared.open()
    hosts.push(opened)
    for (const fn of openers) await fn()
  }
  const close = async () => {
    for (const fn of closers) await fn()
    hosts.splice(hosts.indexOf(opened), 1)
    await opened.close()
  }
  await open()
  const log = () => opened.harness.snapshot(Board, ROOT_CONVERSATION_ID, context)
  const state = () => opened.harness.snapshot(BoardQuestions, ROOT_CONVERSATION_ID, context)
  // Settled: every event reacted to and every task done.
  const settled = () =>
    until(
      async () =>
        (await events.settled()) &&
        (await opened.harness.commit(
          async (tx) =>
            (await tx.scanTasks({}, 1000)).items.every((task) => task.state.status === 'terminal'),
          context,
        )),
    )
  const send = async (extra = {}) => {
    // Only @ultimate may message the user, so the root stands in for it while it sends.
    await opened.harness.commit(async (tx) => {
      ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = opened.root.id
    }, context)
    await (
      await opened.root.submit(
        {
          type: 'input',
          content: `SEND ${JSON.stringify({ to: 'user', text: 'Keep it running?', ...extra })}`,
        },
        context,
      )
    ).wait(context)
    await opened.harness.commit(async (tx) => {
      delete (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
    }, context)
    return (await log())!.messages.at(-1)!.id
  }
  const action = () => ({ host, signal: new AbortController().signal }) as ActionContext
  const answer = (messageId: number, answers = [{ question: 'Keep it running?', answer: 'Yes' }]) =>
    actions.answer({ messageId, answers }, action())
  /** A new conversation registered as the standing @ultimate. */
  const ultimate = async () => {
    const conversation = await opened.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const agent = await opened.root.agent(context)
    await opened.harness.commit(async (tx) => {
      await configure(tx, conversation.id, { model: agent.model, tools: agent.tools })
      ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = conversation.id
    }, context)
    return conversation.id
  }
  const type = async (id: ConversationId, content: string) => {
    const conversation = (await opened.harness.conversation(id, context))!
    return (await conversation.submit({ type: 'input', content }, context)).wait(context)
  }
  const reply = (entryId: number, answers = [{ question: 'Keep it running?', answer: 'Yes' }]) =>
    actions.reply({ entryId, answers }, action())
  const inputs = async (id: ConversationId) =>
    (
      await opened.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 1000), context)
    ).items
      .filter((entry) => entry.kind === 'pi.user')
      .toSorted((a, b) => a.id - b.id)
  return {
    ultimate,
    type,
    reply,
    inputs,
    get opened() {
      return opened
    },
    host,
    prepared,
    send,
    log,
    state,
    extract,
    observed,
    extractionInputs,
    settled,
    action,
    answer,
    open,
    close,
    result: (value: unknown) => {
      extraction = value
    },
    hold: (value: ReturnType<typeof gate>) => {
      hold = value
    },
    pauseCommit: (value: ReturnType<typeof gate> | undefined) => {
      beforeCommit = value
    },
    committing: () => committing,
  }
}

it('extracts once only for reply-expected agent messages to the user', async () => {
  const f = await fixture()
  await f.send({ reply: false })
  await f.send({
    to: `#${(await f.opened.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)).id}`,
    reply: true,
  })
  await f.settled()
  expect(f.extract).not.toHaveBeenCalled()
  const id = await f.send()
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(await f.state()).toMatchObject({
    requested: [id],
    asked: { [id]: [{ text: 'Keep it running?', kind: 'confirm' }] },
  })
  // The event again, as if delivered twice: the message was requested already.
  await f.opened.harness.commit((tx) => emit(tx, Asked, { message: id, from: 1 }), context)
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
})

it('posts exactly one Board reply atomically, wakes the sender, and rejects unknown or duplicate answers', async () => {
  const f = await fixture()
  const id = await f.send()
  await f.settled()
  expect(userActions).toEqual(['answer', 'reply'])
  await expect(f.answer(id, [{ question: 'Unknown', answer: 'Yes' }])).rejects.toThrow(
    'Unknown question',
  )
  await expect(
    f.answer(id, [
      { question: 'Keep it running?', answer: 'Yes' },
      { question: 'Keep it running?', answer: 'No' },
    ]),
  ).rejects.toThrow('Unknown question')
  await expect(f.answer(id, [])).rejects.toThrow('Invalid answers')
  const results = await Promise.allSettled([f.answer(id), f.answer(id)])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(
    String(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ),
  ).toContain('These questions are no longer open')
  await f.settled()
  expect((await f.log())!.messages).toMatchObject([
    { id, state: 'answered' },
    { from: 'user', to: 1, re: id, text: 'Q: Keep it running?\nA: Yes' },
    { from: 1, to: 'user', reply: false },
  ])
  expect(f.observed.some((text) => text.includes('Q: Keep it running?\nA: Yes'))).toBe(true)
  await expect(f.answer(id)).rejects.toThrow('These questions are no longer open')
})

it('refuses answers after typed input and discards a stale in-flight extraction', async () => {
  const f = await fixture()
  const id = await f.send()
  await f.settled()
  await f.type(f.opened.root.id, 'Typed reply')
  await expect(f.answer(id)).rejects.toThrow('These questions are no longer open')
  await f.settled()
  const hold = gate()
  f.hold(hold)
  const stale = await f.send()
  await until(() => f.extract.mock.calls.length === 2)
  await f.type(f.opened.root.id, 'A new input')
  hold.release()
  await f.settled()
  expect((await f.state())!.asked[String(stale)]).toBeUndefined()
})

it('discards empty and invalid extractions', async () => {
  const f = await fixture()
  for (const result of [
    { questions: [] },
    { questions: [{ text: 'Bad', kind: 'choice' }] },
    null,
  ]) {
    f.result(result)
    await f.send()
    await f.settled()
  }
  expect(f.extract).toHaveBeenCalledTimes(3)
  expect((await f.state())!.asked).toEqual({})
})

it('resumes a memoized response during reopen and never extracts again after completion', async () => {
  const f = await fixture()
  f.pauseCommit(gate())
  const id = await f.send()
  await until(f.committing)
  expect(f.extract).toHaveBeenCalledTimes(1)
  await f.close()
  f.pauseCommit(undefined)
  await f.open()
  await f.settled()
  expect((await f.state())!.asked[String(id)]).toHaveLength(1)
  expect(f.extract).toHaveBeenCalledTimes(1)
  await f.close()
  await f.open()
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect((await f.state())!.requested).toEqual([id])
})

it('prunes extraction state to messages still in the Board log', async () => {
  const f = await fixture()
  const id = await f.send()
  await f.settled()
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Board, ROOT_CONVERSATION_ID)).messages = []
  }, context)
  const next = await f.send()
  await f.settled()
  expect((await f.state())!.requested).toEqual([next])
  expect((await f.state())!.asked[String(id)]).toBeUndefined()
})

it("extracts @ultimate's final answers to typed input only, once per answer", async () => {
  const f = await fixture()
  const id = await f.ultimate()
  // Another conversation's answer, a Board message and a Board reply to @ultimate ask nothing.
  await f.type(f.opened.root.id, 'ASK Keep it running?')
  await f.type(
    f.opened.root.id,
    `SEND ${JSON.stringify({ to: `#${id}`, text: 'ASK Keep it running?' })}`,
  )
  await f.settled()
  await (
    await (await f.opened.harness.conversation(id, context))!.submit(
      {
        type: 'input',
        entry: { kind: 'board.reply', data: { id: 9, re: 8, from: 2, text: 'Done' } },
        content: 'ASK Keep it running?',
      },
      context,
    )
  ).wait(context)
  await f.settled()
  expect(f.extract).not.toHaveBeenCalled()
  expect((await f.state())!.reply).toBeUndefined()
  const settled = await f.type(id, 'ASK Keep it running?')
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect((await f.state())!.reply).toEqual({
    conversation: id,
    entry: settled.answer,
    questions: [{ text: 'Keep it running?', kind: 'confirm' }],
  })
  // An answer that asks nothing clears the card.
  f.result({ questions: [] })
  await f.type(id, 'ASK All done.')
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(JSON.parse(f.extractionInputs[0])).toEqual({
    untrustedUserInput: 'ASK Keep it running?',
    untrustedReply: 'Keep it running?',
  })
  expect((await f.state())!.reply).toBeUndefined()
})

it("keeps @ultimate's final-answer card across a Board delivery and its answer, then answers with the question quoted", async () => {
  const f = await fixture()
  const id = await f.ultimate()
  await f.type(id, 'ASK Keep it running?')
  await f.settled()
  const card = (await f.state())!.reply!
  expect(card.conversation).toBe(id)
  await f.type(f.opened.root.id, `SEND ${JSON.stringify({ to: `#${id}`, text: 'Branch done' })}`)
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect((await f.state())!.reply).toEqual(card)
  await f.reply(card.entry)
  await f.settled()
  expect((await f.inputs(id)).at(-1)?.model?.[0]?.content).toBe('Q: Keep it running?\nA: Yes')
  expect((await f.state())!.reply).toBeUndefined()
})

it("ends @ultimate's final-answer card when its idle conversation is reset", async () => {
  const f = await fixture()
  const id = await f.ultimate()
  await f.type(id, 'ASK Keep it running?')
  await f.settled()
  // The title bar counts this card as the one thing waiting on the user.
  expect((await f.state())!.reply?.conversation).toBe(id)
  await (await f.opened.harness.conversation(id, context))!.reset(undefined, context)
  await until(async () => (await f.state())!.reply === undefined)
  await f.settled()
  expect((await f.state())!.reply).toBeUndefined()
  // No open message to the user counts either.
  expect((await f.log())?.messages ?? []).toEqual([])
})

it('ends a card whose reset landed while nobody listened, on open', async () => {
  const f = await fixture()
  const id = await f.ultimate()
  await f.type(id, 'ASK Keep it running?')
  await f.settled()
  const reply = (await f.state())!.reply
  await (await f.opened.harness.conversation(id, context))!.reset(undefined, context)
  await until(async () => (await f.state())!.reply === undefined)
  await f.close()
  // Restore the card as if the process stopped before the reset was seen.
  const opened = await f.prepared.open()
  await opened.harness.commit(async (tx) => {
    ;(await tx.doc(BoardQuestions, ROOT_CONVERSATION_ID)).reply = reply
  }, context)
  expect(
    (await opened.harness.snapshot(BoardQuestions, ROOT_CONVERSATION_ID, context))!.reply,
  ).toEqual(reply)
  await opened.close()
  await f.open()
  await until(async () => (await f.state())!.reply === undefined)
  expect((await f.state())!.reply).toBeUndefined()
})

it("resumes an @ultimate answer's extraction on reopen without asking again", async () => {
  const f = await fixture()
  const id = await f.ultimate()
  f.pauseCommit(gate())
  const settled = await f.type(id, 'ASK Keep it running?')
  await until(f.committing)
  await f.close()
  f.pauseCommit(undefined)
  await f.open()
  await f.settled()
  expect((await f.state())!.reply?.entry).toBe(settled.answer)
  await f.close()
  await f.open()
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
})

it('keeps delayed extraction after an agent delivery and its no-question answer', async () => {
  const f = await fixture()
  const id = await f.ultimate()
  const hold = gate()
  f.hold(hold)
  const asked = await f.type(id, 'ASK Keep it running?')
  await until(() => f.extract.mock.calls.length === 1)
  await f.type(f.opened.root.id, `SEND ${JSON.stringify({ to: `#${id}`, text: 'Branch done' })}`)
  await until(() => f.observed.some((text) => text.includes('Branch done')))
  hold.release()
  await f.settled()
  expect((await f.state())!.reply?.entry).toBe(asked.answer)
  expect(f.extract).toHaveBeenCalledTimes(1)
})

it('stores nothing for an answer that newer input superseded', async () => {
  const f = await fixture()
  const id = await f.ultimate()
  const hold = gate()
  f.hold(hold)
  await f.type(id, 'ASK Keep it running?')
  await until(() => f.extract.mock.calls.length === 1)
  await f.type(id, 'Something else')
  hold.release()
  await f.settled()
  expect((await f.state())!.reply).toBeUndefined()
})

it("answers @ultimate's current answer with one typed input and refuses stale or repeated answers", async () => {
  const f = await fixture()
  const id = await f.ultimate()
  const first = await f.type(id, 'ASK Keep it running?')
  await f.settled()
  await expect(f.reply(first.answer! + 1)).rejects.toThrow('These questions are no longer open')
  await expect(f.reply(first.answer!, [{ question: 'Unknown', answer: 'Yes' }])).rejects.toThrow(
    'Unknown question',
  )
  await expect(f.reply(first.answer!, [])).rejects.toThrow('Invalid answers')
  const results = await Promise.allSettled([f.reply(first.answer!), f.reply(first.answer!)])
  expect(results.map((result) => result.status).toSorted()).toEqual(['fulfilled', 'rejected'])
  expect(
    String(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ),
  ).toContain('These questions are no longer open')
  await f.settled()
  expect((await f.inputs(id)).map((entry) => entry.model?.[0]?.content)).toEqual([
    'ASK Keep it running?',
    'Q: Keep it running?\nA: Yes',
  ])
  await expect(f.reply(first.answer!)).rejects.toThrow('These questions are no longer open')
  // A later typed input makes an earlier answer's card stale.
  const second = await f.type(id, 'ASK Keep it running?')
  await f.settled()
  await f.type(id, 'Typed instead')
  await f.settled()
  await expect(f.reply(second.answer!)).rejects.toThrow('These questions are no longer open')
  // A reset after the answer refuses it too.
  const third = await f.type(id, 'ASK Keep it running?')
  await f.settled()
  expect((await f.state())!.reply?.entry).toBe(third.answer)
  await (await f.opened.harness.conversation(id, context))!.reset(undefined, context)
  await f.settled()
  await expect(f.reply(third.answer!)).rejects.toThrow('These questions are no longer open')
})

it("closes @ultimate's open message to the user when the user types in its conversation", async () => {
  const f = await fixture()
  const id = await f.ultimate()
  await f.type(id, `SEND ${JSON.stringify({ to: 'user', text: 'Keep it running?' })}`)
  await f.settled()
  const message = (await f.log())!.messages.at(-1)!
  expect(message).toMatchObject({ from: id, state: 'delivered' })
  expect((await f.state())!.asked[String(message.id)]).toHaveLength(1)
  await f.type(
    f.opened.root.id,
    `SEND ${JSON.stringify({ to: `#${id}`, text: 'Unrelated update' })}`,
  )
  await f.settled()
  expect((await f.log())!.messages.find((m) => m.id === message.id)?.state).toBe('delivered')
  expect((await f.state())!.asked[String(message.id)]).toHaveLength(1)
  await f.type(id, 'Yes, keep it')
  await until(
    async () => (await f.log())!.messages.find((m) => m.id === message.id)?.state === 'answered',
  )
  await expect(f.answer(message.id)).rejects.toThrow('These questions are no longer open')
})

it.each([
  ['Should I land it? 1. Yes 2. Change something first', true],
  ['Done.\n\n1. Land it\n2. Change something first', true],
  ['Choose:\n\na) Land it\nb) Wait', true],
  ['Choose:\n\nA. Land it\nB. Wait', true],
  ['Choose:\n\n1) Land it\n2) Wait', true],
  ['Is it running? Yes.\n\nEverything is done.', false],
  ['1. Built it\n2. Tested it\n\nLanded and pushed.', false],
  ['Waiting for #130966 to report back. I will bring you its proposal then.', false],
  ['', false],
  [
    "Yes, I get the intent. Right now it doesn't work that way: state is stored per folder path on each machine, and each machine syncs to its own cloud copy. So starting Ultimate on ROG, or in another folder, begins with an empty state and its own separate URL.\n\nI started #130966 to design what you describe:\n- one global state per project;\n- a new machine downloads it and keeps syncing;\n- you choose where code runs, with only one machine writing at a time.\n\nIt changes nothing until you pick from its proposal.",
    false,
  ],
])('gates the closing paragraph of %j: %s', (text, expected) => {
  expect(asksUser(text)).toBe(expected)
})

it('does not gate explicit reply-expected Board asks without question punctuation', async () => {
  const f = await fixture()
  await f.send({ text: 'Please confirm whether to keep it running.' })
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
})

it('validates extracted choices and ignores fields outside the schema', () => {
  expect(
    parseQuestions(
      '{"questions":[{"text":"Which?","kind":"choice","options":[{"label":"Small","recommended":true}],"extra":"ignore"}]}',
    ),
  ).toEqual([{ text: 'Which?', kind: 'choice', options: [{ label: 'Small', recommended: true }] }])
  expect(() =>
    parseQuestions('{"questions":[{"text":"Which?","kind":"choice","options":[]}]}'),
  ).toThrow('Invalid options')
})
