import { fauxServer, sourceCopy, temp, until, post } from './helpers.ts'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineTask, InboxDoc, LiveDoc } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Summaries, currentAnswer } from '../extensions/conversations/summary.ts'
import questionsExtension, { actions, parseQuestions } from '../extensions/questions/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { Submission } from '@earendil-works/pi-durable'
import type { Tx, ConversationId } from '@earendil-works/pi-durable'
import type { QuestionsService } from '../extensions/questions/server.ts'
import type { EntryId } from '@earendil-works/pi-durable'

let ultimateRoot: string
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp('ultimate-questions-source-'))
})
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()))
})

async function launch() {
  const home = await temp('ultimate-questions-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({
      extensions: {
        disable: (await readdir(join(ultimateRoot, 'extensions'))).filter(
          (name) => !['conversations', 'questions'].includes(name),
        ),
      },
    }),
  )
  const server = await fauxServer({
    ultimateRoot,
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  let assessment = 'needs_input'
  let extraction: unknown = { questions: [{ text: 'Keep it running?', kind: 'confirm' }] }
  let gate: Promise<void> | undefined
  let runGate: Promise<void> | undefined
  const extract = vi.fn<() => void>()
  const requests: unknown[] = []
  const demo: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([demo])
    requests.push(transcript)
    const system = transcript.messages[0]
    const prompt = system?.role === 'system' ? system.content : ''
    if (typeof prompt === 'string' && prompt.startsWith('Extract questions addressed')) {
      extract()
      if (gate) await gate
      return fauxAssistantMessage([fauxText(JSON.stringify(extraction))])
    }
    if (
      typeof prompt === 'string' &&
      /^(Assess the latest|Summarize the initial|Refresh a coding)/.test(prompt)
    )
      return fauxAssistantMessage([
        fauxText(
          JSON.stringify({
            assessment,
            activity: 'Asked a decision.',
            title: 'Questions',
            summary: 'Decide on a preview.',
            feature: 'Questions',
          }),
        ),
      ])
    if (runGate) await runGate
    return fauxAssistantMessage([fauxText('Keep it running? 1. Yes 2. No')])
  }
  server.host.faux!.setResponses([demo])
  const entries = (id = server.root.id) =>
    server.harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: id }, 1000)).items,
      context,
    )
  const settled = async () => {
    await until(async () =>
      server.harness.commit(async (tx) => {
        const tasks = await tx.scanTasks({}, 1000)
        return tasks.items
          .filter((task) => task.kind !== 'questions-test-owner')
          .every((task) => task.state.status === 'terminal')
      }, context),
    )
  }
  const exchange = async (id = server.root.id) => {
    const conversation = await server.harness.conversation(id, context)
    const submission = await conversation!.submit(
      { type: 'input', content: 'Preview it.' },
      context,
    )
    expect((await submission.wait(context)).status).toBe('done')
    return submission
  }
  return {
    server,
    entries,
    settled,
    exchange,
    extract,
    requests,
    holdRun: (value: Promise<void>) => {
      runGate = value
    },
    setAssessment: (value: string) => {
      assessment = value
    },
    setExtraction: (value: unknown) => {
      extraction = value
    },
    hold: (value: Promise<void> | undefined) => {
      gate = value
    },
  }
}

it('extracts only accepted needs_input replies, deduplicates, and keeps asked entries out of model context without invalidating assessment', async () => {
  const f = await launch()
  for (const value of ['done', 'neutral']) {
    f.setAssessment(value)
    await f.exchange()
    await f.settled()
    expect(f.extract).not.toHaveBeenCalled()
    expect((await f.entries()).filter((e) => e.kind === 'questions.asked')).toHaveLength(0)
  }
  f.setAssessment('needs_input')
  await f.exchange()
  await f.settled()
  const asked = (await f.entries()).filter((e) => e.kind === 'questions.asked')
  expect(asked).toHaveLength(1)
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(asked[0].model).toBeUndefined()
  const state = await f.server.harness.snapshot(Summaries, f.server.root.id, context)
  expect(state?.assessment?.value).toBe('needs_input')
  expect(
    await f.server.harness.commit(
      (tx) => currentAnswer(tx, f.server.root.id, state!.assessment!.answerId),
      context,
    ),
  ).toBe(true)
  // A second ordinary request proves the prior display-only entry is absent from actual provider context.
  f.setAssessment('done')
  await f.exchange()
  await f.settled()
  expect(JSON.stringify(f.requests)).not.toContain('questions.asked')
  expect(JSON.stringify(f.requests)).not.toContain('Keep it running?","kind":"confirm"')
  expect((await f.entries()).filter((e) => e.kind === 'questions.asked')).toHaveLength(1)
})

it('discards empty, invalid and failed extractions', async () => {
  const f = await launch()
  for (const result of [
    { questions: [] },
    { questions: [{ text: 'Bad', kind: 'choice' }] },
    null,
  ]) {
    f.setExtraction(result)
    await f.exchange()
    await f.settled()
    expect((await f.entries()).filter((e) => e.kind === 'questions.asked')).toHaveLength(0)
  }
  expect(f.extract).toHaveBeenCalledTimes(3)
})

it('discards an extraction once a newer input arrives', async () => {
  const f = await launch()
  let release!: () => void
  f.hold(
    new Promise<void>((done) => {
      release = done
    }),
  )
  await f.exchange()
  await until(() => f.extract.mock.calls.length === 1)
  f.setAssessment('done')
  await f.server.harness.commit(
    (tx) =>
      tx.appendEntry(f.server.root.id, {
        kind: 'pi.user',
        input: true,
        model: [{ role: 'user', content: 'Newer input', timestamp: 1 }],
      }),
    context,
  )
  release()
  await f.settled()
  expect((await f.entries()).filter((e) => e.kind === 'questions.asked')).toHaveLength(0)
})

it('submits a typed Q/A input with its note and refuses a stale answer action', async () => {
  const f = await launch()
  await f.exchange()
  await f.settled()
  const asked = (await f.entries()).find((e) => e.kind === 'questions.asked')!
  f.setAssessment('done')
  const args = {
    askedId: asked.id,
    answers: [{ question: 'Keep it running?', answer: 'Yes' }],
    note: 'For the review.',
  }
  const response = await post(f.server, '/api/extensions/questions/actions/answer', {
    conversationId: f.server.root.id,
    args,
  })
  expect(response.status).toBe(200)
  await f.settled()
  const answer = (await f.entries()).find((e) => e.kind === 'questions.answers')!
  expect(answer.input).toBe(true)
  expect(answer.data).toEqual(args)
  expect(answer.model?.[0]).toMatchObject({
    role: 'user',
    content: 'Q: Keep it running?\nA: Yes\n\nFor the review.',
  })
  expect(
    (
      await post(f.server, '/api/extensions/questions/actions/answer', {
        conversationId: f.server.root.id,
        args,
      })
    ).status,
  ).not.toBe(200)
})

it('rejects the answer when a newer run starts between validation and admission, without queueing or faulting it', async () => {
  const f = await launch()
  await f.exchange()
  await f.settled()
  const asked = (await f.entries()).find((e) => e.kind === 'questions.asked')!
  const data = { askedId: asked.id, answers: [{ question: 'Keep it running?', answer: 'Yes' }] }
  let release!: () => void
  f.holdRun(
    new Promise<void>((done) => {
      release = done
    }),
  )
  f.setAssessment('done')
  let newer!: Submission
  const host = {
    harness: () => ({
      commit: f.server.harness.commit.bind(f.server.harness),
      // The action has finished its freshness transaction before it gets this handle.
      conversation: async () => {
        newer = await f.server.root.submit({ type: 'input', content: 'A newer prompt' }, context)
        return f.server.root
      },
    }),
  } as unknown as ExtensionHost
  try {
    await expect(
      actions.answer(data, {
        host,
        conversationId: f.server.root.id,
        signal: new AbortController().signal,
        exec: async () => {
          throw new Error('Unexpected exec')
        },
      }),
    ).rejects.toThrow('These questions are no longer open')
    expect((await f.server.harness.snapshot(LiveDoc, f.server.root.id, context))?.run).toBeDefined()
    expect((await f.server.harness.snapshot(InboxDoc, f.server.root.id, context))?.items).toEqual(
      [],
    )
    expect((await f.entries()).filter((e) => e.kind === 'questions.answers')).toHaveLength(0)
  } finally {
    release()
  }
  expect((await newer.wait(context)).status).toBe('done')
  await f.settled()
  expect((await f.server.harness.snapshot(InboxDoc, f.server.root.id, context))?.items).toEqual([])
  expect((await f.server.harness.snapshot(LiveDoc, f.server.root.id, context))?.run).toBeUndefined()
})

it('refuses an answer superseded before typed input placement', async () => {
  const f = await launch()
  await f.exchange()
  await f.settled()
  const asked = (await f.entries()).find((e) => e.kind === 'questions.asked')!
  const data = { askedId: asked.id, answers: [{ question: 'Keep it running?', answer: 'Yes' }] }
  await f.server.harness.commit(
    (tx) =>
      tx.appendEntry(f.server.root.id, {
        kind: 'pi.user',
        input: true,
        model: [{ role: 'user', content: 'A newer prompt', timestamp: 1 }],
      }),
    context,
  )
  const before = await f.server.harness.commit((tx) => tx.scanTasks({}, 1000), context)
  await expect(
    f.server.root.submit(
      {
        type: 'input',
        whenBusy: 'reject',
        content: 'Q: Keep it running?\nA: Yes',
        entry: { kind: 'questions.answers', data },
      },
      context,
    ),
  ).rejects.toThrow('These questions are no longer open')
  expect((await f.entries()).filter((e) => e.kind === 'questions.answers')).toHaveLength(0)
  expect((await f.server.harness.snapshot(InboxDoc, f.server.root.id, context))?.items).toEqual([])
  expect((await f.server.harness.snapshot(LiveDoc, f.server.root.id, context))?.run).toBeUndefined()
  const after = await f.server.harness.commit((tx) => tx.scanTasks({}, 1000), context)
  expect(after).toEqual(before)
  f.setAssessment('done')
  await f.exchange()
  await f.settled()
})

it('does not request extraction for an owned subagent', async () => {
  const f = await launch()
  f.setAssessment('done')
  await f.exchange()
  await f.settled()
  const anchor = defineTask<null, { phase: 'hold' }, null>({
    name: 'questions-test-owner',
    version: 1,
    initial: () => ({ phase: 'hold' }),
    phases: { hold: async () => {} },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  const at = (await f.entries())[0].id
  const child = await f.server.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: f.server.root.id,
      background: true,
    })
    return tx.forkConversation(f.server.root.id, at, {
      ownership: { kind: 'task', taskId: owner },
    })
  }, context)
  f.setAssessment('needs_input')
  await f.exchange(child.id)
  await f.settled()
  expect((await f.server.harness.snapshot(Summaries, child.id, context))?.assessment?.value).toBe(
    'needs_input',
  )
  expect(f.extract).not.toHaveBeenCalled()
  expect((await f.entries(child.id)).filter((e) => e.kind === 'questions.asked')).toHaveLength(0)
})

it('deduplicates durable extraction requests per answer', async () => {
  let service!: QuestionsService
  questionsExtension({
    provide: (_name: string, value: QuestionsService) => {
      service = value
    },
  } as unknown as ExtensionHost)
  const state = { answers: [] as number[] }
  const createTask = vi.fn<() => Promise<number>>(async () => 1)
  const tx = { doc: async () => state, createTask } as unknown as Tx
  await service.request(tx, 1 as ConversationId, 2 as EntryId)
  await service.request(tx, 1 as ConversationId, 2 as EntryId)
  expect(createTask).toHaveBeenCalledTimes(1)
  expect(state.answers).toEqual([2])
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
