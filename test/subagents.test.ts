import { awaitWithContext } from '@earendil-works/chord/context'
import { projectSettings } from '../server/project-setup.ts'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import {
  defineExtension,
  defineTool,
  InboxDoc,
  LiveDoc,
  GenerationTask,
  hook,
} from '@earendil-works/pi-durable'
import type { ConversationId, Extension, Task, ToolRegistration } from '@earendil-works/pi-durable'
import type { Context, JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { createEventBus, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import subagents, { actions, Subagents } from '../extensions/subagents/server.ts'
import type { ActionContext } from '../server/actions.ts'
import codemode from '../extensions/codemode/server.ts'
import { Metadata } from '../server/metadata.ts'
import { UiState } from '../server/ui-state.ts'
import { discoverAgents, parseDefinition } from '../extensions/subagents/agents.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { until, temp, removeTemp } from './helpers.ts'

const directories: string[] = []
const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const path of directories.splice(0)) await removeTemp(path)
})
const definition = (body = 'Original instructions') =>
  `---\nname: scout\ndescription: Search\ntools: [read, bash]\n---\n${body}\n`
async function directory() {
  const path = await temp('ultimate-subagents-')
  directories.push(path)
  return path
}
async function fixture(
  extension?: Extension,
  observe?: (transcript: Parameters<FauxResponseFactory>[0]) => void,
  reportGate?: { promise: Promise<void>; entered: boolean; phase?: string },
) {
  const ultimateRoot = await directory()
  const userHome = await directory()
  await mkdir(join(ultimateRoot, 'agents'))
  await writeFile(
    join(ultimateRoot, 'agents/scout.md'),
    extension ? definition().replace('tools: [read, bash]\n', '') : definition(),
  )
  const errors: string[] = []
  const prepared = await prepareHarness({
    report: (notice) => {
      if (notice.level === 'error') errors.push(notice.message)
    },
    ultimateRoot,
    userHome,
    home: join(ultimateRoot, 'home'),
    faux: true,
  })
  prepared.registry.install(CodingTools)
  if (extension) prepared.registry.install(extension)
  let opened: OpenHost | undefined
  const backend = subagents({
    projectSettings: () => projectSettings(prepared.projectRoot, prepared.userHome),
    ...prepared,
    harness: () => opened!.harness,
    metadata: Metadata,
  })
  prepared.registry.install(
    reportGate
      ? {
          ...backend,
          tasks: backend.tasks!.map((task) => {
            if (task.definition.name !== 'ultimate.subagent-reporter') return task
            const reporter = task as unknown as Task<
              JsonValue,
              { phase: string },
              JsonValue,
              object
            >
            const phase = reportGate.phase ?? 'report'
            return {
              definition: {
                ...reporter.definition,
                phases: {
                  ...reporter.definition.phases,
                  [phase]: async (
                    ...args: Parameters<typeof reporter.definition.phases.report>
                  ) => {
                    reportGate.entered = true
                    await awaitWithContext(reportGate.promise, args[2])
                    await reporter.definition.phases[phase](...args)
                  },
                },
              },
            }
          }),
        }
      : backend,
  )
  prepared.registry.install(
    codemode({
      ...prepared,
      events: createEventBus(),
      access: { allow: () => () => {} },
      notice: () => {},
      resource: (_key, create) => create(),
      onOpen: () => {},
      onClose: () => {},
      harness: () => {
        throw new Error('Not used')
      },
      system: () => {
        throw new Error('Not used')
      },
      conversations: () => [],
      projects: async () => [],
      extensions: () => [],
      reloadExtensions: async () => {},
      projectSetup: async () => ({ config: false, decision: null }),
      projectSettings: async () => ({}),
      projectExtensions: async () => [],
      setProjectDecision: async () => {},
      doc: () => undefined,
      metadata: Metadata,
    }),
  )
  const route: FauxResponseFactory = (transcript) => {
    observe?.(transcript)
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    if (last.role === 'user' && text.startsWith('CODE '))
      return fauxAssistantMessage([fauxToolCall('codemode', { code: text.slice(5) })], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && text === 'HOLD')
      return fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
    if (last.role === 'user' && text.startsWith('CALL '))
      return fauxAssistantMessage([fauxToolCall('subagent', JSON.parse(text.slice(5)))], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && text === 'slow')
      return fauxAssistantMessage([fauxText('Working '.repeat(700))])
    if (last.role === 'user' && text.startsWith('[subagent'))
      return fauxAssistantMessage([fauxText('Report received')])
    return fauxAssistantMessage([
      fauxText(last.role === 'toolResult' ? `Result: ${text}` : `Child: ${text}`),
    ])
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  hosts.push(opened)
  return {
    prepared,
    opened,
    ultimateRoot,
    userHome,
    errors,
    reopen: async () => {
      opened = await prepared.open()
      hosts.push(opened)
      return opened
    },
  }
}
async function call(opened: OpenHost, args: Record<string, unknown>) {
  await (
    await opened.root.submit({ type: 'input', content: `CALL ${JSON.stringify(args)}` }, context)
  ).wait(context)
  const view = await opened.root.viewState(context)
  const tool = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)!
  const result = tool.model?.[0]
  const text =
    result?.role === 'toolResult'
      ? result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      : ''
  view.dispose()
  return { tool, text }
}
async function children(opened: OpenHost) {
  return Object.values(
    (await opened.harness.snapshot(Subagents, opened.root.id, context))?.agents ?? {},
  )
}
async function reports(opened: OpenHost) {
  const view = await opened.root.viewState(context)
  const entries = view.value.entries.filter(
    (entry) =>
      entry.model?.[0]?.role === 'user' &&
      typeof entry.model[0].content === 'string' &&
      entry.model[0].content.startsWith('[subagent'),
  )
  view.dispose()
  return entries
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function gatedFixture(reportGate?: { promise: Promise<void>; entered: boolean }) {
  const childGate = gate()
  const parentGate = gate()
  const holding = new Set<number>()
  const requests: Parameters<FauxResponseFactory>[0][] = []
  const f = await fixture(
    defineExtension({
      name: 'hold',
      tools: [
        defineTool({
          name: 'hold',
          description: 'Deterministic completion gate',
          parameters: Type.Object({}),
          replay: 'safe',
          execute: async (_args, api, toolContext) => {
            holding.add(api.conversationId)
            await awaitWithContext(
              api.conversationId === 1 ? parentGate.promise : childGate.promise,
              toolContext,
            )
            return { content: [{ type: 'text', text: 'released' }] }
          },
        }),
      ],
    }),
    (request) => {
      requests.push(request)
    },
    reportGate,
  )
  return { ...f, childGate, parentGate, holding, requests }
}
async function startCall(opened: OpenHost, args: Record<string, unknown>) {
  return opened.root.submit({ type: 'input', content: `CALL ${JSON.stringify(args)}` }, context)
}
async function latestResult(opened: OpenHost) {
  const view = await opened.root.viewState(context)
  try {
    return view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)?.model?.[0]
  } finally {
    view.dispose()
  }
}

function stopCaptureGate(f: Awaited<ReturnType<typeof gatedFixture>>) {
  const state = { ...gate(), entered: false, enabled: true }
  f.prepared.registry.install(
    defineExtension({
      name: 'stop-gate',
      wraps: [
        {
          tool: 'subagent',
          wrap: (tool: ToolRegistration): ToolRegistration => ({
            ...tool,
            execute: (args, api, toolContext) =>
              tool.execute(
                args,
                {
                  ...api,
                  memo: (name: string, value: JsonValue | Context, memoContext?: Context) => {
                    const saved =
                      memoContext === undefined
                        ? api.memo(name, value as Context)
                        : api.memo(name, value as JsonValue, memoContext)
                    return saved.then(async (winner) => {
                      if (name === 'stopTarget' && state.enabled) {
                        state.entered = true
                        await awaitWithContext(state.promise, toolContext)
                      }
                      return winner
                    })
                  },
                },
                toolContext,
              ),
          }),
        },
      ],
    }),
  )
  return state
}

describe('subagents', () => {
  it.each(['start', 'message', 'wait'] as const)(
    '%s yields on steer before child completes and reports once',
    async (action) => {
      const f = await gatedFixture()
      let id: number | undefined
      if (action !== 'start') {
        await call(f.opened, {
          action: 'start',
          agent: 'scout',
          task: action === 'wait' ? 'HOLD' : 'facts',
          background: action === 'wait',
        })
        id = (await children(f.opened))[0].conversationId
      }
      const pending = await startCall(
        f.opened,
        action === 'start'
          ? { action, agent: 'scout', task: 'HOLD' }
          : { action, id, ...(action === 'message' ? { text: 'HOLD' } : {}) },
      )
      await until(async () =>
        (await children(f.opened)).some((child) => f.holding.has(child.conversationId)),
      )
      id = (await children(f.opened))[0].conversationId
      const steer = await f.opened.root.submit(
        { type: 'input', content: 'change direction', whenBusy: 'steer' },
        context,
      )
      await steer.wait(context)
      await pending.wait(context)
      expect(await latestResult(f.opened)).toMatchObject({
        details: { conversationId: id, yielded: true },
        isError: false,
      })
      expect(
        (await f.opened.harness.snapshot(LiveDoc, id as ConversationId, context))?.run,
      ).toBeDefined()
      expect(await reports(f.opened)).toHaveLength(0)
      const request = f.requests.findLast((candidate) =>
        candidate.messages.some(
          (message) => message.role === 'user' && message.content === 'change direction',
        ),
      )!
      expect(JSON.stringify(request.messages)).toContain(`Still running subagents: ${id} (scout)`)
      expect(
        request.messages.filter(
          (message) => message.role === 'user' && message.content === 'change direction',
        ),
      ).toHaveLength(1)
      f.childGate.release()
      await until(async () => (await reports(f.opened)).length === 1)
      await f.opened.harness.waitForIdle(context)
      expect(await reports(f.opened)).toHaveLength(1)
      expect((await children(f.opened))[0].reported).toHaveLength(action === 'message' ? 2 : 1)
      expect(
        f.requests
          .at(-1)
          ?.messages.findLast(
            (message) =>
              message.role === 'system' && Object.hasOwn(message.sections ?? {}, 'subagent_state'),
          ),
      ).toMatchObject({ sections: { subagent_state: null } })
      await call(f.opened, { action: 'wait', id })
      expect(await reports(f.opened)).toHaveLength(1)
    },
  )
  it('does not wake for followUp, but does wake for an already queued steer', async () => {
    const f = await gatedFixture()
    await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    const [child] = await children(f.opened)
    const pending = await startCall(f.opened, { action: 'wait', id: child.conversationId })
    await until(
      async () =>
        (await f.opened.harness.snapshot(LiveDoc, f.opened.root.id, context))?.run !== undefined,
    )
    await f.opened.root.submit(
      { type: 'input', content: 'later only', whenBusy: 'followUp' },
      context,
    )
    // The child gate is still closed and the wait has no completed result.
    expect((await pending.status(context)).status).toBe('placed')
    expect((await latestResult(f.opened))?.role).toBe('toolResult')
    expect(await latestResult(f.opened)).not.toMatchObject({ details: { yielded: true } })
    await f.opened.root.submit({ type: 'input', content: 'wake now', whenBusy: 'steer' }, context)
    await pending.wait(context)
    expect(await latestResult(f.opened)).toMatchObject({ details: { yielded: true } })
    f.childGate.release()
    await f.opened.harness.waitForIdle(context)

    const g = await gatedFixture()
    await g.opened.root.submit({ type: 'input', content: 'HOLD' }, context)
    await until(async () => g.holding.has(1))
    const start = await g.opened.root.submit(
      {
        type: 'input',
        content: 'CALL {"action":"start","agent":"scout","task":"HOLD"}',
        whenBusy: 'steer',
      },
      context,
    )
    await g.opened.root.submit(
      { type: 'input', content: 'already queued', whenBusy: 'steer' },
      context,
    )
    g.parentGate.release()
    await start.wait(context)
    expect(await latestResult(g.opened)).toMatchObject({ details: { yielded: true } })
    const [agent] = await children(g.opened)
    await until(async () => g.holding.has(agent.conversationId))
    expect(
      (await g.opened.harness.snapshot(LiveDoc, agent.conversationId, context))?.run,
    ).toBeDefined()
    g.childGate.release()
    await until(async () => (await reports(g.opened)).length === 1)
    await g.opened.harness.waitForIdle(context)
    expect(await reports(g.opened)).toHaveLength(1)
  })

  it('finishes normally for followUp without duplicating the answer', async () => {
    const f = await gatedFixture()
    const pending = await startCall(f.opened, { action: 'start', agent: 'scout', task: 'HOLD' })
    await until(async () => f.holding.size === 1)
    const followUp = await f.opened.root.submit(
      { type: 'input', content: 'later only', whenBusy: 'followUp' },
      context,
    )
    expect(
      (await f.opened.harness.snapshot(InboxDoc, f.opened.root.id, context))?.items.map(
        (item) => item.mode,
      ),
    ).toEqual(['followUp'])
    f.childGate.release()
    await pending.wait(context)
    await followUp.wait(context)
    expect(await latestResult(f.opened)).toMatchObject({
      content: [{ type: 'text', text: 'Result: released' }],
    })
    expect(await latestResult(f.opened)).not.toMatchObject({ details: { yielded: true } })
    expect(await reports(f.opened)).toHaveLength(0)
  })
  it('wakes a pending wait on another child report without losing either answer', async () => {
    const held = { ...gate(), entered: false }
    const f = await gatedFixture(held)
    await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    const [waiting] = await children(f.opened)
    await until(async () => f.holding.has(waiting.conversationId))
    await call(f.opened, {
      action: 'start',
      agent: 'scout',
      task: 'other answer',
      background: true,
    })
    await until(async () => held.entered)
    const pending = await startCall(f.opened, { action: 'wait', id: waiting.conversationId })
    held.release()
    await pending.wait(context)
    expect(await latestResult(f.opened)).toMatchObject({
      details: { yielded: true, conversationId: waiting.conversationId },
    })
    expect(
      (await f.opened.harness.snapshot(LiveDoc, waiting.conversationId, context))?.run,
    ).toBeDefined()
    expect(await reports(f.opened)).toHaveLength(1)
    expect(JSON.stringify(await reports(f.opened))).toContain('Child: other answer')
    f.childGate.release()
    await until(async () => (await reports(f.opened)).length === 2)
    await f.opened.root.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(2)
  })
  it('reminds the model of a durable pending input before the child run starts', async () => {
    const held = { ...gate(), entered: false, phase: 'deliver' }
    const requests: Parameters<FauxResponseFactory>[0][] = []
    const f = await fixture(
      undefined,
      (request) => {
        requests.push(request)
      },
      held,
    )
    await call(f.opened, {
      action: 'start',
      agent: 'scout',
      task: 'not delivered yet',
      background: true,
    })
    await until(async () => held.entered)
    const [child] = await children(f.opened)
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    const system = requests
      .at(-1)
      ?.messages.findLast(
        (message) =>
          message.role === 'system' && Object.hasOwn(message.sections ?? {}, 'subagent_state'),
      )
    expect(JSON.stringify(system)).toContain(
      `Pending subagent inputs: ${child.conversationId} (scout)`,
    )
    held.release()
    await until(async () => (await reports(f.opened)).length === 1)
    await f.opened.root.waitForIdle(context)
  })

  it('stops a pending Reporter before delivery and leaves the child reusable', async () => {
    const held = { ...gate(), entered: false, phase: 'deliver' }
    const f = await fixture(undefined, undefined, held)
    await call(f.opened, {
      action: 'start',
      agent: 'scout',
      task: 'contradicting work',
      background: true,
    })
    await until(async () => held.entered)
    const [child] = await children(f.opened)
    const state = (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!
    const action = Object.values(state.actions)[0]
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    expect(
      await f.opened.harness.commit(
        (tx) => tx.submissionByRequest(child.conversationId, `subagent:${action.reporter}`),
        context,
      ),
    ).toBeUndefined()
    expect((await call(f.opened, { action: 'stop', id: child.conversationId })).text).toBe(
      `Stopped ${child.conversationId}.`,
    )
    expect(await f.opened.harness.getTask(action.reporter!, context)).toMatchObject({
      state: { status: 'terminal', outcome: { status: 'aborted' } },
    })
    held.release()
    await f.opened.harness.waitForTask(action.reporter!, context)
    const view = await (await f.opened.harness.conversation(
      child.conversationId,
      context,
    ))!.viewState(context)
    try {
      expect(view.value.entries.filter((entry) => entry.model?.[0]?.role === 'user')).toHaveLength(
        0,
      )
    } finally {
      view.dispose()
    }
    expect(await reports(f.opened)).toHaveLength(0)
    await call(f.opened, { action: 'message', id: child.conversationId, text: 'fresh reuse' })
    await until(async () => (await reports(f.opened)).length === 1)
    await f.opened.root.waitForIdle(context)
    expect(JSON.stringify(await reports(f.opened))).toContain('Child: fresh reuse')
    expect(JSON.stringify(await reports(f.opened))).not.toContain('contradicting work')
    expect(f.errors).toEqual([])
  })
  it('withdraws captured queued Reporter inputs as well as stopping the current run', async () => {
    const f = await gatedFixture()
    await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    const [child] = await children(f.opened)
    await until(async () => f.holding.has(child.conversationId))
    await call(f.opened, { action: 'message', id: child.conversationId, text: 'never execute' })
    const state = (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!
    const action = Object.values(state.actions).at(-1)!
    await until(
      async () =>
        (
          await f.opened.harness.commit(
            (tx) => tx.submissionByRequest(child.conversationId, `subagent:${action.reporter}`),
            context,
          )
        )?.status === 'queued',
    )
    await call(f.opened, { action: 'stop', id: child.conversationId })
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    expect(
      (await f.opened.harness.snapshot(InboxDoc, child.conversationId, context))?.items,
    ).toEqual([])
    expect(
      await f.opened.harness.commit(
        (tx) => tx.submissionByRequest(child.conversationId, `subagent:${action.reporter}`),
        context,
      ),
    ).toMatchObject({ status: 'unanswered', reason: 'aborted' })
    f.childGate.release()
    await f.opened.root.waitForIdle(context)
    const view = await (await f.opened.harness.conversation(
      child.conversationId,
      context,
    ))!.viewState(context)
    try {
      expect(view.value.entries.filter((entry) => entry.model?.[0]?.role === 'user')).toHaveLength(
        1,
      )
    } finally {
      view.dispose()
    }
    expect(await reports(f.opened)).toHaveLength(0)
    await call(f.opened, { action: 'message', id: child.conversationId, text: 'fresh reuse' })
    await until(async () => (await reports(f.opened)).length === 1)
    await f.opened.root.waitForIdle(context)
    expect(JSON.stringify(await reports(f.opened))).not.toContain('never execute')
    expect(f.errors).toEqual([])
  })
  it('replays captured stop identities without stopping a newer child run', async () => {
    const f = await gatedFixture()
    await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    const [child] = await children(f.opened)
    await until(async () => f.holding.has(child.conversationId))
    const stopGate = stopCaptureGate(f)
    await startCall(f.opened, { action: 'stop', id: child.conversationId })
    await until(async () => stopGate.entered)
    const handle = (await f.opened.harness.conversation(child.conversationId, context))!
    await handle.abort(context)
    const newer = await handle.submit(
      { type: 'input', content: 'HOLD', requestId: 'later-reuse' },
      context,
    )
    await until(
      async () =>
        (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run !==
        undefined,
    )
    const run = (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))!.run!
      .taskId
    await f.opened.close()
    hosts.splice(hosts.indexOf(f.opened), 1)
    stopGate.enabled = false
    const resumed = await f.reopen()
    await resumed.root.waitForIdle(context)
    expect(await latestResult(resumed)).toMatchObject({
      content: [{ type: 'text', text: `Stopped ${child.conversationId}.` }],
    })
    expect(
      (await resumed.harness.snapshot(LiveDoc, child.conversationId, context))?.run?.taskId,
    ).toBe(run)
    const submission = (await resumed.harness.submission(newer.id, context))!
    expect(await submission.status(context)).toMatchObject({ status: 'placed' })
    f.childGate.release()
    expect(await submission.wait(context)).toMatchObject({ status: 'done' })
    expect(await reports(resumed)).toHaveLength(0)
    expect(f.errors).toEqual([])
  })

  it('stops an admission racing after capture when the captured run was absent', async () => {
    const held = { ...gate(), entered: false, phase: 'deliver' }
    const f = await gatedFixture(held)
    await call(f.opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
    const [child] = await children(f.opened)
    await until(async () => held.entered)
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    const stopGate = stopCaptureGate(f)
    await startCall(f.opened, { action: 'stop', id: child.conversationId })
    await until(async () => stopGate.entered)
    // Admission follows capture but belongs to its captured reporter.
    held.release()
    await until(async () => f.holding.has(child.conversationId))
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeDefined()
    stopGate.release()
    await f.opened.root.waitForIdle(context)
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    f.childGate.release()
    expect(await reports(f.opened)).toHaveLength(0)
    expect(f.errors).toEqual([])
  })
  it('keeps a foreground child running when the parent is stopped', async () => {
    const f = await gatedFixture()
    await startCall(f.opened, { action: 'start', agent: 'scout', task: 'HOLD' })
    await until(async () => f.holding.size === 1)
    const [child] = await children(f.opened)
    await f.opened.root.abort(context)
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeDefined()
    f.childGate.release()
    await until(async () => (await reports(f.opened)).length === 1)
    await f.opened.root.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(1)
  })
  it('releases parallel waits on a steer and preserves every child answer across restart', async () => {
    const f = await gatedFixture()
    await f.opened.root.submit(
      {
        type: 'input',
        content: `CODE text(await Promise.all([1,2].map(() => tools.subagent({action:'start',agent:'scout',task:'HOLD'}))));`,
      },
      context,
    )
    await until(async () => (await children(f.opened)).length === 2 && f.holding.size === 2)
    await (
      await f.opened.root.submit(
        { type: 'input', content: 'parallel steer', whenBusy: 'steer' },
        context,
      )
    ).wait(context)
    expect(await latestResult(f.opened)).toMatchObject({ role: 'toolResult', toolName: 'codemode' })
    const agents = await children(f.opened)
    for (const agent of agents)
      expect(
        (await f.opened.harness.snapshot(LiveDoc, agent.conversationId, context))?.run,
      ).toBeDefined()
    await f.opened.close()
    hosts.splice(hosts.indexOf(f.opened), 1)
    const resumed = await f.reopen()
    expect((await children(resumed)).map((child) => child.conversationId)).toEqual(
      agents.map((child) => child.conversationId),
    )
    f.childGate.release()
    await until(async () => (await reports(resumed)).length === 2)
    await resumed.harness.waitForIdle(context)
    expect(await reports(resumed)).toHaveLength(2)
    for (const child of await children(resumed)) expect(child.reported).toHaveLength(1)
  })

  it('preserves an earlier nested answer when a sibling wait yields to its queued report', async () => {
    const f = await gatedFixture()
    const submitted = await f.opened.root.submit(
      {
        type: 'input',
        content: `CODE await tools.subagent({action:'start',agent:'scout',task:'completed first'}); await tools.subagent({action:'start',agent:'scout',task:'HOLD'});`,
      },
      context,
    )
    await submitted.wait(context)
    await until(async () => f.holding.size === 1)
    const agents = await children(f.opened)
    expect(agents).toHaveLength(2)
    expect(
      (await f.opened.harness.snapshot(LiveDoc, agents[1].conversationId, context))?.run,
    ).toBeDefined()
    expect(await reports(f.opened)).toHaveLength(1)
    expect(JSON.stringify(await reports(f.opened))).toContain('Child: completed first')
    f.childGate.release()
    await until(async () => (await reports(f.opened)).length === 2)
    await f.opened.root.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(2)
    expect((await children(f.opened)).map((child) => child.reported.length)).toEqual([1, 1])
  })
  it('lets the parent message and explicitly stop a foreground child after yielding', async () => {
    const f = await gatedFixture()
    await startCall(f.opened, { action: 'start', agent: 'scout', task: 'HOLD' })
    await until(async () => f.holding.size === 1)
    await (
      await f.opened.root.submit(
        { type: 'input', content: 'change task', whenBusy: 'steer' },
        context,
      )
    ).wait(context)
    const [child] = await children(f.opened)
    const message = await startCall(f.opened, {
      action: 'message',
      id: child.conversationId,
      text: 'replacement',
      steer: true,
    })
    await (
      await f.opened.root.submit(
        { type: 'input', content: 'stop instead', whenBusy: 'steer' },
        context,
      )
    ).wait(context)
    await message.wait(context)
    expect(await latestResult(f.opened)).toMatchObject({
      details: { conversationId: child.conversationId, yielded: true },
    })
    await call(f.opened, { action: 'stop', id: child.conversationId })
    expect(
      (await f.opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    f.childGate.release()
    await f.opened.harness.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(0)
    expect(
      (await call(f.opened, { action: 'message', id: child.conversationId, text: 'reuse' })).text,
    ).toBe('Child: reuse')
    expect(await reports(f.opened)).toHaveLength(0)
  })

  it('waits for answer-ready reporter submission before acknowledging its direct result', async () => {
    const held = { ...gate(), entered: false }
    const f = await fixture(undefined, undefined, held)
    const pending = await startCall(f.opened, {
      action: 'start',
      agent: 'scout',
      task: 'race answer',
    })
    await until(async () => held.entered)
    const [child] = await children(f.opened)
    const state = (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!
    const action = Object.values(state.actions)[0]
    expect(action.answer).toBeDefined()
    expect(
      await f.opened.harness.commit(
        (tx) => tx.submissionByRequest(f.opened.root.id, `subagent-answer:${action.answer}`),
        context,
      ),
    ).toBeUndefined()
    await f.opened.root.submit(
      { type: 'input', content: 'completion race steer', whenBusy: 'steer' },
      context,
    )
    expect(await latestResult(f.opened)).toBeUndefined()
    held.release()
    await pending.wait(context)
    expect(await latestResult(f.opened)).toMatchObject({
      content: [{ type: 'text', text: 'Child: race answer' }],
      details: { conversationId: child.conversationId, answerId: action.answer },
    })
    expect(await reports(f.opened)).toHaveLength(0)
    const receipt = await f.opened.harness.commit(
      (tx) => tx.submissionByRequest(f.opened.root.id, `subagent-answer:${action.answer}`),
      context,
    )
    expect(receipt).toMatchObject({ status: 'unanswered', reason: 'subagent-tool-delivered' })
  })

  it('records a durable receipt before a delayed reporter submits and suppresses its late duplicate', async () => {
    const held = { ...gate(), entered: false }
    const f = await fixture(
      defineExtension({
        name: 'receipt-contract',
        wraps: [
          {
            tool: 'codemode',
            wrap: (tool: ToolRegistration): ToolRegistration => ({
              ...tool,
              execute: async (_args, api, toolContext) => {
                const index = (await api.snapshot(Subagents, api.conversationId, toolContext))!
                const answer = Object.values(index.actions)[0].answer!
                return {
                  content: [{ type: 'text', text: 'Answer delivered by outer result' }],
                  details: { subagentAnswers: [answer] },
                }
              },
            }),
          },
        ],
      }),
      undefined,
      held,
    )
    await call(f.opened, {
      action: 'start',
      agent: 'scout',
      task: 'delayed report',
      background: true,
    })
    await until(async () => held.entered)
    await (
      await f.opened.root.submit({ type: 'input', content: 'CODE receipt' }, context)
    ).wait(context)
    const index = (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!
    const action = Object.values(index.actions)[0]
    const receipt = await f.opened.harness.commit(
      (tx) => tx.submissionByRequest(f.opened.root.id, `subagent-answer:${action.answer}`),
      context,
    )
    expect(receipt).toMatchObject({ status: 'unanswered', reason: 'subagent-tool-delivered' })
    held.release()
    await f.opened.harness.waitForTask(action.reporter!, context)
    await f.opened.root.waitForIdle(context)
    expect(await reports(f.opened)).toHaveLength(0)
    expect(
      await f.opened.harness.commit(
        (tx) => tx.submissionByRequest(f.opened.root.id, `subagent-answer:${action.answer}`),
        context,
      ),
    ).toEqual(receipt)
  })
  it('withdraws only successful outer codemode receipts and survives hook replay', async () => {
    // Emulate the agreed codemode handoff without modifying that worker's implementation.
    const f = await fixture(
      defineExtension({
        name: 'receipt-contract',
        wraps: [
          {
            tool: 'codemode',
            wrap: (tool: ToolRegistration): ToolRegistration => ({
              ...tool,
              execute: async (args, api, toolContext) => {
                const result = await tool.execute(args, api, toolContext)
                const index = await api.snapshot(Subagents, api.conversationId, toolContext)
                const answers = Object.entries(index?.actions ?? {}).flatMap(([callId, action]) =>
                  callId.startsWith(`${api.callId}/`) && action.answer !== undefined
                    ? [action.answer]
                    : [],
                )
                return { ...result, details: { subagentAnswers: answers } }
              },
            }),
          },
        ],
      }),
    )
    const held = { ...gate(), entered: false }
    f.prepared.registry.install(
      defineExtension({
        name: 'z-after-receipt',
        hooks: [
          hook(GenerationTask, {
            afterTools: async (_assistant, _results, _api, toolContext) => {
              if (_api.conversationId !== f.opened.root.id) return
              held.entered = true
              await awaitWithContext(held.promise, toolContext)
            },
          }),
        ],
      }),
    )
    await f.opened.root.submit(
      {
        type: 'input',
        content: `CODE text(await tools.subagent({action:'start',agent:'scout',task:'receipt answer'}));`,
      },
      context,
    )
    await until(async () => held.entered)
    const index = (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!
    const answer = Object.values(index.actions)[0].answer!
    expect(f.errors).toEqual([])
    expect(await latestResult(f.opened)).toMatchObject({
      toolName: 'codemode',
      details: { subagentAnswers: [answer] },
      isError: false,
    })
    expect(
      await f.opened.harness.commit(
        (tx) => tx.submissionByRequest(f.opened.root.id, `subagent-answer:${answer}`),
        context,
      ),
    ).toMatchObject({ status: 'unanswered', reason: 'subagent-tool-delivered' })
    await f.opened.close()
    hosts.splice(hosts.indexOf(f.opened), 1)
    const resumed = await f.reopen()
    held.release()
    await resumed.root.waitForIdle(context)
    expect(await reports(resumed)).toHaveLength(0)
    expect(await latestResult(resumed)).toMatchObject({ details: { subagentAnswers: [answer] } })
    const before = await resumed.harness.commit(
      (tx) => tx.submissionByRequest(resumed.root.id, `subagent-answer:${answer}`),
      context,
    )
    await call(resumed, { action: 'wait', id: Object.values(index.agents)[0].conversationId })
    expect(
      await resumed.harness.commit(
        (tx) => tx.submissionByRequest(resumed.root.id, `subagent-answer:${answer}`),
        context,
      ),
    ).toEqual(before)
    expect(await reports(resumed)).toHaveLength(0)
  })
  it('keeps a completed nested answer durable when the enclosing script fails', async () => {
    const f = await fixture()
    await (
      await f.opened.root.submit(
        {
          type: 'input',
          content: `CODE await tools.subagent({action:'start',agent:'scout',task:'keep this answer'}); throw new Error('sibling wait yielded');`,
        },
        context,
      )
    ).wait(context)
    await f.opened.harness.waitForIdle(context)
    const delivered = await reports(f.opened)
    expect(delivered).toHaveLength(1)
    expect(JSON.stringify(delivered)).toContain('Child: keep this answer')
    expect((await children(f.opened))[0].reported).toHaveLength(1)
  })
  it('forks before the calling assistant, keeps child configuration and starts with empty agents', async () => {
    const requests: Parameters<FauxResponseFactory>[0][] = []
    const { opened } = await fixture(undefined, (transcript) => requests.push(transcript))
    await opened.harness.commit(async (tx) => {
      Object.assign(await tx.doc(UiState, opened.root.id), {
        'subagents.selected': opened.root.id,
      })
    }, context)
    await (
      await opened.root.submit(
        { type: 'input', content: 'Remember the parent secret: violet' },
        context,
      )
    ).wait(context)
    await call(opened, { action: 'start', agent: 'scout', task: 'older child' })
    const result = await call(opened, {
      action: 'start',
      agent: 'scout',
      task: 'fork task',
      fork: true,
    })
    expect(result.text).toContain('Child: fork task')
    const request = requests.find((candidate) =>
      candidate.messages.some(
        (message) => message.role === 'user' && message.content === 'fork task',
      ),
    )!
    expect(request).toBeDefined()
    expect(JSON.stringify(request.messages)).toContain('Remember the parent secret: violet')
    expect(request.messages.findLast((message) => message.role !== 'system')).toMatchObject({
      role: 'user',
      content: 'fork task',
    })
    expect(
      request.messages.some(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === 'toolCall' &&
              part.name === 'subagent' &&
              (part.arguments as { fork?: boolean }).fork === true,
          ),
      ),
    ).toBe(false)
    const childId = (await children(opened)).at(-1)!.conversationId
    const child = (await opened.harness.conversation(childId, context))!
    const agent = await child.agent(context)
    expect(agent.instructions).toBe('Original instructions')
    expect(agent.extensions.map((extension) => extension.name)).not.toContain('subagents')
    expect(agent.tools.map((tool) => tool.name).toSorted()).toEqual(['bash', 'read'])
    expect(await opened.harness.snapshot(Subagents, childId, context)).toBeUndefined()
    expect(await opened.harness.snapshot(UiState, childId, context)).toEqual({
      'subagents.selected': opened.root.id,
    })
    expect(await opened.harness.snapshot(Metadata, childId, context)).toMatchObject({
      label: 'scout',
      title: 'fork task',
    })
  })
  it('keeps nested parallel starts distinct and delivers a subsequent nested message', async () => {
    const { opened } = await fixture()
    await (
      await opened.root.submit(
        {
          type: 'input',
          content: `CODE const results = await Promise.all(['first','second'].map(task => tools.subagent({action:'start',agent:'scout',task}))); text(results);`,
        },
        context,
      )
    ).wait(context)
    const agents = await children(opened)
    expect(agents).toHaveLength(2)
    expect(new Set(agents.map((agent) => agent.conversationId)).size).toBe(2)
    let view = await opened.root.viewState(context)
    expect(JSON.stringify(view.value.entries)).toContain('Child: first')
    expect(JSON.stringify(view.value.entries)).toContain('Child: second')
    view.dispose()
    await (
      await opened.root.submit(
        {
          type: 'input',
          content: `CODE const child = await tools.subagent({action:'start',agent:'scout',task:'third'}); text(await tools.subagent({action:'message',id:JSON.parse(await tools.subagent({action:'list'})).at(-1).conversationId,text:'follow-up'}));`,
        },
        context,
      )
    ).wait(context)
    view = await opened.root.viewState(context)
    expect(JSON.stringify(view.value.entries)).toContain('Child: follow-up')
    view.dispose()
  })
  it('discovers all three locations, overrides by name, reports malformed files and rereads edits', async () => {
    const repo = await directory(),
      home = await directory(),
      cwd = await directory()
    for (const path of [
      join(repo, 'agents'),
      join(home, '.ultimate/agents'),
      join(cwd, '.ultimate/agents'),
    ])
      await mkdir(path, { recursive: true })
    await writeFile(join(repo, 'agents/scout.md'), definition('repo'))
    await writeFile(join(home, '.ultimate/agents/scout.md'), definition('home'))
    await writeFile(join(cwd, '.ultimate/agents/scout.md'), definition('cwd'))
    await writeFile(
      join(repo, 'agents/worker.md'),
      definition('worker').replace('name: scout', 'name: worker'),
    )
    await writeFile(
      join(home, '.ultimate/agents/researcher.md'),
      definition('research').replace('name: scout', 'name: researcher'),
    )
    await writeFile(join(cwd, '.ultimate/agents/broken.md'), 'broken')
    const modelRuntime = await ModelRuntime.create()
    for (const [name, model, thinking] of [
      ['exact', 'anthropic/claude-opus-4-8', ''],
      ['suffix', 'anthropic/claude-opus-4-8:high', ''],
      ['explicit', 'anthropic/claude-opus-4-8:high', 'thinking: low\n'],
      ['unknown', 'anthropic/ultimate-nonexistent-model', ''],
      ['missing', 'ultimate-nonexistent-model', ''],
    ])
      await writeFile(
        join(repo, `agents/${name}.md`),
        definition(name)
          .replace('name: scout', `name: ${name}`)
          .replace('tools: [read, bash]', `model: ${model}\n${thinking}`),
      )
    new ProjectTrustStore(join(home, '.ultimate')).set(cwd, true)
    const found = await discoverAgents(repo, cwd, home, modelRuntime)
    expect(found.definitions.find((agent) => agent.name === 'exact')?.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
    })
    expect(found.definitions.find((agent) => agent.name === 'suffix')?.thinking).toBe('high')
    expect(found.definitions.find((agent) => agent.name === 'explicit')?.thinking).toBe('low')
    expect(found.errors.find((file) => file.name === 'unknown')?.error).toContain(
      'model: Model "ultimate-nonexistent-model" not found for provider "anthropic". Using custom model id.',
    )
    expect(found.errors.find((file) => file.name === 'missing')?.error).toContain(
      'model: Model "ultimate-nonexistent-model" not found.',
    )
    expect(found.definitions.map((agent) => agent.name).toSorted()).toEqual([
      'exact',
      'explicit',
      'researcher',
      'scout',
      'suffix',
      'worker',
    ])
    expect(found.definitions.find((agent) => agent.name === 'scout')?.instructions).toBe('cwd')
    expect(found.errors.find((file) => file.name === 'broken')).toMatchObject({
      name: 'broken',
      error: expect.stringContaining('frontmatter'),
    })
    await writeFile(join(cwd, '.ultimate/agents/scout.md'), definition('edited'))
    expect(
      (await discoverAgents(repo, cwd, home, modelRuntime)).definitions.find(
        (agent) => agent.name === 'scout',
      )?.instructions,
    ).toBe('edited')
  })
  it('parses definitions with Pi frontmatter and validates their fields', () => {
    expect(
      parseDefinition(
        '---\nname: scout\ndescription: >\n  A read-only scout\n  that searches.\nmodel: openai-codex/gpt-5.4\nthinking: max\ntools:\n  - read\n  - bash\n---\nSearch\n',
        'scout.md',
      ),
    ).toEqual({
      name: 'scout',
      description: 'A read-only scout that searches.',
      path: 'scout.md',
      instructions: 'Search',
      model: 'openai-codex/gpt-5.4',
      thinking: 'max',
      tools: ['read', 'bash'],
    })
    for (const [from, to, error] of [
      [
        'tools: [read, bash]',
        'tools: [read, bash]\nthinking: nonsense',
        'thinking must be one of off, minimal, low, medium, high, xhigh, max',
      ],
      ['description: Search', 'description: " "', 'description is required'],
      ['name: scout', 'name: a scout', 'name must be a nonempty identifier'],
      ['tools: [read, bash]', 'tools: read', 'tools must be a list of tool names'],
      ['tools: [read, bash]', 'model: " "', 'model must be a nonempty string'],
      ['tools: [read, bash]', 'tool: [read]', 'Unknown field: tool'],
      ['tools: [read, bash]', 'isolate: remote', 'isolate must be none or worktree'],
      ['Original instructions', '', 'Instructions are required'],
    ])
      expect(() => parseDefinition(definition().replace(from, to), 'test')).toThrow(error)
  })
  it('saves a definition as a project override that start uses, writes nothing when invalid, and deletes it', async () => {
    const { prepared, opened, ultimateRoot, userHome } = await fixture()
    const ctx = {
      host: { ...prepared, harness: () => opened.harness },
    } as unknown as ActionContext
    const project = join(prepared.projectRoot, '.ultimate/agents')
    const override = {
      name: 'scout',
      scope: 'project',
      frontmatter: { description: 'Project scout: reads only', tools: ['read'], thinking: 'high' },
      instructions: '# Project\n\nRead the code.\n',
    }
    await expect(actions.saveDefinition(override, ctx)).rejects.toThrow(
      "Choose this project's local setup",
    )
    expect(await actions.definitions(null, ctx)).toMatchObject({ projectLocal: false })
    new ProjectTrustStore(join(userHome, '.ultimate')).set(prepared.projectRoot, true)
    const listed = await actions.definitions(null, ctx)
    expect(listed).toMatchObject({
      projectLocal: true,
      scopes: { user: join(userHome, '.ultimate/agents'), project },
      definitions: [{ name: 'scout', source: 'builtin' }],
    })
    expect(listed.main.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['read', 'bash', 'codemode']),
    )
    expect(listed.main.tools.map((tool) => tool.name)).not.toContain('subagent')
    const builtin = await readFile(join(ultimateRoot, 'agents/scout.md'), 'utf8')
    await actions.saveDefinition(override, ctx)
    const raw = await readFile(join(project, 'scout.md'), 'utf8')
    expect(raw).toBe(
      '---\nname: scout\ndescription: "Project scout: reads only"\nthinking: high\ntools: [read]\n---\n\n# Project\n\nRead the code.\n',
    )
    expect(await readFile(join(ultimateRoot, 'agents/scout.md'), 'utf8')).toBe(builtin)
    const found = await discoverAgents(
      ultimateRoot,
      prepared.projectRoot,
      userHome,
      prepared.modelRuntime,
    )
    expect(found.definitions.find((agent) => agent.name === 'scout')).toMatchObject({
      source: 'project',
      description: 'Project scout: reads only',
      tools: ['read'],
      thinking: 'high',
      instructions: '# Project\n\nRead the code.',
    })
    expect(await actions.definition({ name: 'scout' }, ctx)).toMatchObject({
      source: 'project',
      path: join(project, 'scout.md'),
      raw,
      files: ['builtin', 'project'],
      definition: { instructions: '# Project\n\nRead the code.' },
    })
    await call(opened, { action: 'start', agent: 'scout', task: 'facts' })
    const child = (await children(opened)).at(-1)!
    const agent = await (await opened.harness.conversation(child.conversationId, context))!.agent(
      context,
    )
    expect(agent.tools.map((tool) => tool.name)).toEqual(['read'])
    expect(agent.instructions).toBe('# Project\n\nRead the code.')
    for (const [change, error] of [
      [{ frontmatter: { ...override.frontmatter, description: ' ' } }, 'description is required'],
      [{ frontmatter: { ...override.frontmatter, thinking: 'loud' } }, 'thinking must be one of'],
      [{ frontmatter: { ...override.frontmatter, model: 'anthropic/nonexistent' } }, 'model:'],
      [{ instructions: ' ' }, 'Instructions are required'],
      [{ name: '../scout' }, 'name must be a nonempty identifier'],
      [{ create: true }, 'A definition named scout exists already'],
      [{ scope: 'builtin' }, 'scope must be user or project'],
    ] as const)
      await expect(actions.saveDefinition({ ...override, ...change }, ctx)).rejects.toThrow(error)
    expect(await readFile(join(project, 'scout.md'), 'utf8')).toBe(raw)
    expect(await readdir(project)).toEqual(['scout.md'])
    await actions.saveDefinition(
      {
        name: 'builder',
        scope: 'user',
        create: true,
        frontmatter: { description: 'Builds', isolate: 'worktree' },
        instructions: 'Build it',
      },
      ctx,
    )
    expect(await actions.definition({ name: 'builder' }, ctx)).toMatchObject({
      source: 'user',
      files: ['user'],
      definition: { isolate: 'worktree', instructions: 'Build it' },
    })
    await writeFile(join(project, 'builder.md'), 'broken')
    expect(await actions.definition({ name: 'builder' }, ctx)).toMatchObject({
      source: 'user',
      files: ['user', 'project'],
      invalid: { source: 'project', error: expect.stringContaining('frontmatter') },
    })
    await actions.deleteDefinition({ name: 'scout', scope: 'project' }, ctx)
    expect(await actions.definition({ name: 'scout' }, ctx)).toMatchObject({
      source: 'builtin',
      files: ['builtin'],
    })
    await expect(
      actions.deleteDefinition({ name: 'scout', scope: 'project' }, ctx),
    ).rejects.toThrow('No project definition named scout')
    await expect(
      actions.deleteDefinition({ name: 'scout', scope: 'builtin' }, ctx),
    ).rejects.toThrow('scope must be user or project')
  })
  it('foreground returns the answer, exposes child details, inherits the parent and rereads scout on next start', async () => {
    const { opened, ultimateRoot, userHome } = await fixture()
    const result = await call(opened, { action: 'start', agent: 'scout', task: 'facts' })
    expect(result.text).toBe('Child: facts')
    const [first] = await children(opened)
    expect(result.tool.model?.[0]).toMatchObject({
      details: { conversationId: first.conversationId },
    })
    const record = await opened.harness.commit(
      (tx) => tx.conversation(first.conversationId),
      context,
    )
    expect(record?.owner?.conversationId).toBe(opened.root.id)
    const child = (await opened.harness.conversation(first.conversationId, context))!
    const agent = await child.agent(context)
    expect(agent.tools.map((tool) => tool.name)).toEqual(['read', 'bash'])
    expect(agent.model).toEqual((await opened.root.agent(context)).model)
    expect(agent.instructions).toBe('Original instructions')
    await writeFile(join(ultimateRoot, 'agents/scout.md'), definition('Updated instructions'))
    await call(opened, { action: 'start', agent: 'scout', task: 'more facts' })
    const second = (await children(opened))[1]
    expect(
      (await (await opened.harness.conversation(second.conversationId, context))!.agent(context))
        .instructions,
    ).toBe('Updated instructions')
    expect(await opened.harness.snapshot(Metadata, first.conversationId, context)).toEqual({
      label: 'scout',
      title: 'facts',
    })
    expect(
      (
        await call(opened, {
          action: 'message',
          id: first.conversationId,
          text: 'next',
          steer: true,
        })
      ).text,
    ).toBe('Child: next')
    expect((await call(opened, { action: 'wait', id: first.conversationId })).text).toBe(
      'Child: next',
    )
    const listed = JSON.parse((await call(opened, { action: 'list' })).text)
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ conversationId: first.conversationId, busy: false })
    await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
    await writeFile(
      join(userHome, '.ultimate/agents/home-agent.md'),
      definition('User instructions').replace('name: scout', 'name: home-agent'),
    )
    expect((await call(opened, { action: 'start', agent: 'home-agent', task: 'home' })).text).toBe(
      'Child: home',
    )
    const homeAgent = (await children(opened)).at(-1)!
    expect(
      (await (await opened.harness.conversation(homeAgent.conversationId, context))!.agent(context))
        .instructions,
    ).toBe('User instructions')
  })
  it('background returns immediately, survives parent abort and restart, and reports exactly once', async () => {
    const { reopen, opened } = await fixture()
    const result = await call(opened, {
      action: 'start',
      agent: 'scout',
      task: 'slow',
      background: true,
    })
    expect(await children(opened)).toHaveLength(1)
    const [child] = await children(opened)
    expect(result.text).toContain(String(child.conversationId))
    expect(result.tool.model?.[0]).toMatchObject({
      details: { conversationId: child.conversationId, background: true },
    })
    expect((await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.run).toBeUndefined()
    expect(
      (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeDefined()
    await opened.root.abort(context)
    expect(
      (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeDefined()
    await opened.close()
    hosts.splice(hosts.indexOf(opened), 1)
    const resumed = await reopen()
    await until(async () => (await reports(resumed)).length === 1)
    await resumed.harness.waitForIdle(context)
    expect(await children(resumed)).toHaveLength(1)
    expect(await reports(resumed)).toHaveLength(1)
    const view = await resumed.root.viewState(context)
    expect(
      view.value.entries.some(
        (entry) =>
          entry.model?.[0]?.role === 'assistant' &&
          entry.model[0].content.some(
            (part) => part.type === 'text' && part.text === 'Report received',
          ),
      ),
    ).toBe(true)
    view.dispose()
    await call(resumed, { action: 'message', id: child.conversationId, text: 'another' })
    await until(async () => (await reports(resumed)).length === 2)
    await resumed.root.waitForIdle(context)
    expect((await children(resumed))[0].reported).toHaveLength(2)
  }, 20000)
  it('delivers a background answer as a steer while the parent is in a tool round', async () => {
    let releaseParent!: () => void
    let releaseChild!: () => void
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    let parentHolding = false
    let childHolding = false
    const { opened } = await fixture(
      defineExtension({
        name: 'hold',
        tools: [
          defineTool({
            name: 'hold',
            description: 'Hold the current tool round',
            parameters: Type.Object({}),
            execute: async (_args, api) => {
              if (api.conversationId === 1) {
                parentHolding = true
                await parentGate
              } else {
                childHolding = true
                await childGate
              }
              return { content: [{ type: 'text', text: 'released' }] }
            },
          }),
        ],
      }),
    )
    try {
      await call(opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
      await until(async () => childHolding)
      await opened.root.submit({ type: 'input', content: 'HOLD' }, context)
      await until(async () => parentHolding)
      releaseChild()
      await until(
        async () =>
          (await opened.harness.snapshot(InboxDoc, opened.root.id, context))?.items.some(
            (item) =>
              item.mode !== 'write' &&
              typeof item.content === 'string' &&
              item.content.startsWith('[subagent'),
          ) === true,
      )
      const inbox = await opened.harness.snapshot(InboxDoc, opened.root.id, context)
      expect(inbox?.items).toHaveLength(1)
      expect(inbox?.items[0].mode).toBe('steer')
      releaseParent()
      await opened.root.waitForIdle(context)
      expect(await reports(opened)).toHaveLength(1)
    } finally {
      releaseChild()
      releaseParent()
    }
  })
  it('withdraws a queued background report when wait returns the same answer', async () => {
    let releaseParent!: () => void
    let releaseChild!: () => void
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    let parentHolding = false
    let childHolding = false
    const { opened } = await fixture(
      defineExtension({
        name: 'hold',
        tools: [
          defineTool({
            name: 'hold',
            description: 'Hold the current tool round',
            parameters: Type.Object({}),
            execute: async (_args, api) => {
              if (api.conversationId === 1) {
                parentHolding = true
                await parentGate
              } else {
                childHolding = true
                await childGate
              }
              return { content: [{ type: 'text', text: 'released' }] }
            },
          }),
        ],
      }),
    )
    try {
      await call(opened, { action: 'start', agent: 'scout', task: 'HOLD', background: true })
      const [child] = await children(opened)
      await until(async () => childHolding)
      await opened.root.submit({ type: 'input', content: 'HOLD' }, context)
      await until(async () => parentHolding)
      // One steer is placed per boundary, so the report stays queued while the parent waits.
      await opened.root.submit(
        {
          type: 'input',
          content: `CALL ${JSON.stringify({ action: 'wait', id: child.conversationId })}`,
          whenBusy: 'steer',
        },
        context,
      )
      releaseChild()
      await until(
        async () =>
          (await opened.harness.snapshot(InboxDoc, opened.root.id, context))?.items.length === 2,
      )
      releaseParent()
      await opened.root.waitForIdle(context)
      const view = await opened.root.viewState(context)
      const results = view.value.entries.flatMap((entry) => {
        const message = entry.model?.[0]
        return message?.role === 'toolResult' && message.toolName === 'subagent'
          ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
          : []
      })
      view.dispose()
      expect(results.at(-1)).toBe('Result: released')
      expect(await reports(opened)).toHaveLength(0)
      expect((await opened.harness.snapshot(InboxDoc, opened.root.id, context))?.items).toEqual([])
    } finally {
      releaseChild()
      releaseParent()
    }
  })
  it('records a background child answer returned by wait as reported', async () => {
    const { opened } = await fixture()
    await call(opened, { action: 'start', agent: 'scout', task: 'slow', background: true })
    const [agent] = await children(opened)
    await call(opened, { action: 'stop', id: agent.conversationId })
    const child = (await opened.harness.conversation(agent.conversationId, context))!
    const answer = await (
      await child.submit({ type: 'input', content: 'wait-only answer' }, context)
    ).wait(context)
    expect(answer.status).toBe('done')
    expect((await call(opened, { action: 'wait', id: agent.conversationId })).text).toBe(
      'Child: wait-only answer',
    )
    if (answer.status !== 'done' || answer.type !== 'input') throw new Error('Expected answer')
    expect((await children(opened))[0].reported).toContain(answer.answer)
    expect(await reports(opened)).toHaveLength(0)
  })
  it('replays an interrupted foreground wait using its existing independent child', async () => {
    const { reopen, opened } = await fixture()
    await opened.root.submit(
      { type: 'input', content: 'CALL {"action":"start","agent":"scout","task":"slow"}' },
      context,
    )
    await until(async () => {
      const [child] = await children(opened)
      return (
        child !== undefined &&
        (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run !== undefined
      )
    })
    const [before] = await children(opened)
    await opened.close()
    hosts.splice(hosts.indexOf(opened), 1)
    const resumed = await reopen()
    await resumed.root.waitForIdle(context)
    expect(await children(resumed)).toHaveLength(1)
    expect((await children(resumed))[0].conversationId).toBe(before.conversationId)
    const view = await resumed.root.viewState(context)
    const results = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result')
    expect(results).toHaveLength(1)
    expect(results[0].model?.[0]).toMatchObject({
      content: [{ type: 'text', text: 'Working '.repeat(700) }],
      details: { conversationId: before.conversationId },
      isError: false,
    })
    view.dispose()
  }, 15000)
  it('stops a background child, suppresses its aborted report, and leaves it reusable', async () => {
    const { opened } = await fixture()
    await call(opened, {
      action: 'start',
      agent: 'scout',
      task: 'slow',
      background: true,
    })
    expect(await children(opened)).toHaveLength(1)
    const [child] = await children(opened)
    expect((await call(opened, { action: 'stop', id: child.conversationId })).text).toBe(
      `Stopped ${child.conversationId}.`,
    )
    expect(
      (await opened.harness.snapshot(LiveDoc, child.conversationId, context))?.run,
    ).toBeUndefined()
    expect(await reports(opened)).toHaveLength(0)
    await call(opened, { action: 'message', id: child.conversationId, text: 'reuse', steer: true })
    await until(async () => (await reports(opened)).length === 1)
  })
})
