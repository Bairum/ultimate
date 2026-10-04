import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import plan, { Plan } from '../extensions/plan/server.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp, removeTemp } from './helpers.ts'

it('keeps the ledger across restart, replays add once, and lists open work', async () => {
  const directory = await temp('ultimate-plan-')
  const prepared = await prepareHarness({
    ultimateRoot: directory,
    userHome: directory,
    home: join(directory, 'home'),
    faux: true,
  })
  const tool = plan.tools![0]
  const replayResults: unknown[][] = []
  prepared.registry.install(
    defineExtension({
      ...plan,
      tools: [
        {
          ...tool,
          execute: async (args, api, ctx) => {
            const result = await tool.execute(args, api, ctx)
            if ((args as { action: string }).action === 'add') {
              const memoReplay = await tool.execute(args, api, ctx)
              // Simulate a crash after the edit commit but before the result memo.
              const replayApi = {
                ...api,
                memo: ((name: string, ...rest: unknown[]) =>
                  rest.length === 1
                    ? Promise.resolve(undefined)
                    : api.memo(name, rest[0] as never, ctx)) as typeof api.memo,
              }
              replayResults.push([result, memoReplay, await tool.execute(args, replayApi, ctx)])
            }
            return result
          },
        },
      ],
    }),
  )
  let opened = await prepared.open()
  let prompt = ''
  const call = async (args: JsonObject) => {
    prepared.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('plan', args)], { stopReason: 'toolUse' }),
      (request) => {
        const system = request.messages.findLast((message) => message.role === 'system')
        prompt = JSON.stringify(system)
        return fauxAssistantMessage('Complete')
      },
    ])
    await (
      await opened.root.submit({ type: 'input', content: 'Update plan' }, context)
    ).wait(context)
    await opened.harness.waitForIdle(context)
    const view = await opened.root.viewState(context)
    try {
      const result = view.value.entries.findLast((entry) => entry.kind === 'pi.tool-result')!
        .model![0]
      if (result.role !== 'toolResult') throw new Error('Missing tool result')
      return result
    } finally {
      view.dispose()
    }
  }
  try {
    await call({ action: 'create', title: 'Ship ledger', body: '## Request\nDurable plans' })
    await call({
      action: 'add',
      epic: 'E1',
      title: 'Implement',
      role: 'worker',
      description: 'Build it',
    })
    await call({
      action: 'add',
      epic: 'E1',
      title: 'Review',
      role: 'reviewer',
      description: 'Check it',
      deps: ['E1.1'],
    })
    await call({ action: 'update', key: 'E1.1', status: 'in_review', child: 42 })
    await call({ action: 'note', key: 'E1.1', text: 'Checks passed' })
    const saved = await opened.harness.snapshot(Plan, opened.root.id, context)
    expect(saved).toMatchObject({
      next: 2,
      epics: {
        E1: {
          title: 'Ship ledger',
          tasks: {
            'E1.1': {
              status: 'in_review',
              child: 42,
              notes: [{ text: 'Checks passed', at: expect.any(String) }],
            },
            'E1.2': { deps: ['E1.1'], role: 'reviewer' },
          },
        },
      },
    })
    expect(Object.keys(saved!.epics.E1.tasks)).toEqual(['E1.1', 'E1.2'])
    expect(replayResults).toHaveLength(2)
    expect(replayResults.map(([_result, memo, receipt]) => [memo, receipt])).toEqual(
      replayResults.map(([result]) => [result, result]),
    )
    expect(prompt).toContain('E1 planning Ship ledger')
    expect(prompt).toContain('E1.1 in_review Implement child:42')
    expect(prompt).toContain('E1.2 backlog Review deps:E1.1')
    expect(prompt).not.toContain('## Request')
    await opened.close()
    opened = await prepared.open()
    expect(await opened.harness.snapshot(Plan, opened.root.id, context)).toEqual(saved)
    expect((await call({ action: 'update', key: 'E1', status: 'todo' })).isError).toBe(true)
    expect((await call({ action: 'show', key: 'E99' })).isError).toBe(true)
    expect(await opened.harness.snapshot(Plan, opened.root.id, context)).toEqual(saved)
    await call({ action: 'update', key: 'E1', status: 'done', verdict: 'Approved' })
    await call({ action: 'show' })
    expect(prompt).not.toContain('E1 planning Ship ledger')
    expect(prompt).not.toContain('<plan>')
  } finally {
    await opened.close()
    await removeTemp(directory)
  }
})
