import { temp, until } from './helpers.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { awaitWithContext } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Task } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import boardExtension, { Board, actions as boardActions } from '../extensions/board/server.ts'
import questionsExtension, {
  actions,
  BoardQuestions,
  parseQuestions,
  QUESTIONS_SYSTEM,
  userActions,
} from '../extensions/questions/server.ts'

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
  const host = {
    ...prepared,
    userHome: home,
    projectSettings: async () => ({}),
    harness: () => opened.harness,
    provide: (name: string, value: unknown) => services.set(name, value),
    use: (name: string) => services.get(name),
    doc: () => undefined,
    onOpen: (fn: () => Promise<void>) => openers.push(fn),
    onClose: (fn: () => Promise<void>) => closers.push(fn),
    notice: (message: string) => {
      throw new Error(message)
    },
  } as unknown as ExtensionHost
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
  const route: FauxResponseFactory = async (transcript) => {
    prepared.faux!.appendResponses([route])
    const first = transcript.messages[0]
    if (first?.role === 'system' && first.content === QUESTIONS_SYSTEM) {
      extract()
      if (hold) await hold.promise
      return fauxAssistantMessage([fauxText(JSON.stringify(extraction))])
    }
    const last = transcript.messages.at(-1)!
    const text = typeof last.content === 'string' ? last.content : ''
    observed.push(text)
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
  const settled = () =>
    until(() =>
      opened.harness.commit(
        async (tx) =>
          (await tx.scanTasks({}, 1000)).items.every((task) => task.state.status === 'terminal'),
        context,
      ),
    )
  const send = async (extra = {}) => {
    await (
      await opened.root.submit(
        {
          type: 'input',
          content: `SEND ${JSON.stringify({ to: 'user', text: 'Keep it running?', ...extra })}`,
        },
        context,
      )
    ).wait(context)
    return (await log())!.messages.at(-1)!.id
  }
  const action = () => ({ host, signal: new AbortController().signal }) as ActionContext
  const answer = (messageId: number, answers = [{ question: 'Keep it running?', answer: 'Yes' }]) =>
    actions.answer({ messageId, answers }, action())
  return {
    get opened() {
      return opened
    },
    host,
    send,
    log,
    state,
    extract,
    observed,
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
  await boardActions.post({ to: '#1', text: 'User post' }, f.action())
  await f.settled()
  expect(f.extract).not.toHaveBeenCalled()
  const id = await f.send()
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(await f.state()).toEqual({
    requested: [id],
    asked: { [id]: [{ text: 'Keep it running?', kind: 'confirm' }] },
  })
  const message = (await f.log())!.messages.find((m) => m.id === id)!
  await f.opened.harness.commit(
    (tx) =>
      f.host
        .use<import('../extensions/questions/server.ts').QuestionsService>('questions')!
        .request(tx, message),
    context,
  )
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
  const entries = await f.opened.harness.commit(
    (tx) => tx.scanEntries({ conversationId: f.opened.root.id }, 1000),
    context,
  )
  expect(entries.items.some((entry) => entry.kind === 'questions.asked')).toBe(false)
})

it('posts exactly one Board reply atomically, wakes the sender, and rejects unknown or duplicate answers', async () => {
  const f = await fixture()
  const id = await f.send()
  await f.settled()
  expect(userActions).toEqual(['answer'])
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

it('refuses answers after a typed Reply or new post and discards a stale in-flight extraction', async () => {
  const f = await fixture()
  const id = await f.send()
  await f.settled()
  await boardActions.post({ to: '#1', text: 'Typed reply', re: id }, f.action())
  await expect(f.answer(id)).rejects.toThrow('These questions are no longer open')
  await f.settled()
  const hold = gate()
  f.hold(hold)
  const stale = await f.send()
  await until(() => f.extract.mock.calls.length === 2)
  await boardActions.post({ to: '#1', text: 'A new post' }, f.action())
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
