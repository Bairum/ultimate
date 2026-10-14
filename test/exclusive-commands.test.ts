import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { expect, it, vi } from 'vitest'
import { createBashTool } from '@earendil-works/pi-durable/tools'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import codingTools, * as codingToolsModule from '../extensions/coding-tools/server.ts'
import exclusiveCommands, {
  order as exclusiveOrder,
} from '../extensions/exclusive-commands/server.ts'
import { Slot } from '../extensions/exclusive-commands/slot.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context } from '../server/harness.ts'
import { fauxServer, temp, removeTemp, until } from './helpers.ts'

it('composes timeout outside exclusivity and preserves the original default budget', async () => {
  vi.stubEnv('ULTIMATE_BASH_TIMEOUT', '3')
  const slot = new Slot()
  const host = {
    resource: () => slot,
    projectSettings: async () => ({ exclusiveCommands: ['heavy'] }),
  } as unknown as ExtensionHost
  const exclusive = exclusiveCommands(host).wraps![0]
  const defaults = codingTools.wraps![0]
  if (!('tool' in exclusive) || !('tool' in defaults)) throw new Error('Expected tool wrappers')
  const execute = vi.fn<ReturnType<typeof createBashTool>['execute']>(async () => {
    throw new Error('Command timed out after 2 seconds')
  })
  const base = { ...createBashTool(), execute }
  const tool = defaults.wrap(exclusive.wrap(base)) as ReturnType<typeof createBashTool>
  const api = { output: vi.fn<ToolExecutionApi['output']>() } as unknown as ToolExecutionApi
  const now = vi.spyOn(performance, 'now')
  try {
    expect(codingToolsModule).not.toHaveProperty('order')
    expect(0).toBeGreaterThan(exclusiveOrder)
    for (const explicit of [false, true]) {
      now.mockReturnValueOnce(0).mockReturnValueOnce(1500)
      await expect(
        tool.execute({ command: 'heavy', ...(explicit ? { timeout: 3 } : {}) }, api, context),
      ).rejects.toThrow(
        explicit
          ? 'Command timed out after 2 seconds'
          : 'Tripwire: bash ran past the 3 s default limit',
      )
      expect(execute.mock.lastCall?.[0]).toEqual({ command: 'heavy', timeout: 2 })
      expect(slot.command).toBeUndefined()
    }
    now.mockReturnValue(0)
    await expect(exclusive.wrap(base).execute({ command: 'heavy' }, api, context)).rejects.toThrow(
      'Command timed out after 2 seconds',
    )
    expect(execute.mock.lastCall?.[0]).toEqual({ command: 'heavy', timeout: undefined })
    expect(slot.command).toBeUndefined()
  } finally {
    now.mockRestore()
    vi.unstubAllEnvs()
  }
})

it('serializes matching commands across conversations without delaying other bash calls', async () => {
  const directory = await temp('ultimate-exclusive-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: join(directory, 'home'),
    userHome: directory,
  })
  try {
    await mkdir(join(server.host.projectRoot, '.ultimate'), { recursive: true })
    await writeFile(
      join(server.host.projectRoot, '.ultimate/settings.json'),
      JSON.stringify({
        extensions: { enable: ['exclusive-commands'] },
        exclusiveCommands: ['# heavy', '['],
      }),
    )
    const log = join(directory, 'executions')
    const route: FauxResponseFactory = (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      if (last.role === 'user') {
        const command =
          typeof last.content === 'string'
            ? last.content
            : last.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
        return fauxAssistantMessage([fauxToolCall('bash', { command })], { stopReason: 'toolUse' })
      }
      return fauxAssistantMessage('Complete')
    }
    server.host.faux!.setResponses([route])
    const agent = await server.root.agent(context)
    const second = await server.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: agent.model, cwd: server.host.projectRoot },
      },
      context,
    )
    const third = await server.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: agent.model, cwd: server.host.projectRoot },
      },
      context,
    )
    const first = await server.root.submit(
      {
        type: 'input',
        content: `echo first-start >> '${log}'; while [ ! -f '${log}.release' ]; do sleep 0.01; done; echo first-end >> '${log}' # heavy`,
      },
      context,
    )
    await until(async () => (await readFile(log, 'utf8').catch(() => '')).includes('first-start'))
    const queued = await second.submit(
      {
        type: 'input',
        content: `echo second-start >> '${log}'; sleep 0.1; echo second-end >> '${log}' # heavy`,
      },
      context,
    )
    await until(async () => {
      const view = await second.viewState(context)
      try {
        return JSON.stringify(view.value).includes('Waiting for exclusive command:')
      } finally {
        view.dispose()
      }
    })
    const free = await third.submit({ type: 'input', content: `echo free >> '${log}'` }, context)
    await free.wait(context)
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['first-start', 'free'])
    await writeFile(log + '.release', '')
    await Promise.all([first.wait(context), queued.wait(context)])
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
      'first-start',
      'free',
      'first-end',
      'second-start',
      'second-end',
    ])
    const view = await second.viewState(context)
    try {
      expect(JSON.stringify(view.value)).toContain('Invalid exclusiveCommands pattern ignored')
    } finally {
      view.dispose()
    }
    await writeFile(
      join(server.host.projectRoot, '.ultimate/settings.json'),
      JSON.stringify({
        extensions: { enable: ['exclusive-commands'] },
        exclusiveCommands: '# heavy',
      }),
    )
    await (
      await server.root.submit({ type: 'input', content: 'echo valid' }, context)
    ).wait(context)
    const invalid = await server.root.viewState(context)
    try {
      expect(JSON.stringify(invalid.value)).toContain('expected an array of patterns')
      expect(JSON.stringify(invalid.value)).toContain('valid')
    } finally {
      invalid.dispose()
    }
  } finally {
    await server.close()
    await removeTemp(directory)
  }
})

it('bounds exclusive waits by explicit and default limits without starting the waiter', async () => {
  const directory = await temp('ultimate-exclusive-deadline-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: join(directory, 'home'),
    userHome: directory,
  })
  try {
    await mkdir(join(server.host.projectRoot, '.ultimate'), { recursive: true })
    await writeFile(
      join(server.host.projectRoot, '.ultimate/settings.json'),
      JSON.stringify({
        extensions: { enable: ['exclusive-commands'] },
        exclusiveCommands: ['# heavy'],
      }),
    )
    const log = join(directory, 'holder')
    const marker = join(directory, 'waiter')
    const route: FauxResponseFactory = (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      if (last.role === 'user') {
        const input =
          typeof last.content === 'string'
            ? last.content
            : last.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
        return fauxAssistantMessage([fauxToolCall('bash', JSON.parse(input))], {
          stopReason: 'toolUse',
        })
      }
      return fauxAssistantMessage('Complete')
    }
    server.host.faux!.setResponses([route])
    const agent = await server.root.agent(context)
    const second = await server.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: agent.model, cwd: server.host.projectRoot },
      },
      context,
    )
    const holder = `echo start > '${log}'; while [ ! -f '${log}.release' ]; do sleep 0.01; done; echo end >> '${log}' # heavy`
    const first = await server.root.submit(
      { type: 'input', content: JSON.stringify({ command: holder, timeout: 10 }) },
      context,
    )
    await until(async () => (await readFile(log, 'utf8').catch(() => '')).includes('start'))
    for (const explicit of [true, false]) {
      vi.stubEnv('ULTIMATE_BASH_TIMEOUT', '0.05')
      const started = performance.now()
      const queued = await second.submit(
        {
          type: 'input',
          content: JSON.stringify({
            command: `echo ran > '${marker}' # heavy`,
            ...(explicit ? { timeout: 0.05 } : {}),
          }),
        },
        context,
      )
      await queued.wait(context)
      expect(performance.now() - started).toBeLessThan(1000)
      const view = await second.viewState(context)
      try {
        const result = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
          ?.model?.[0]
        expect(result?.role === 'toolResult' && result.isError).toBe(true)
        expect(JSON.stringify(result)).toContain(
          'Timed out after 0.05 s waiting for exclusive command:',
        )
        expect(JSON.stringify(result)).toContain(holder)
      } finally {
        view.dispose()
      }
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await writeFile(log + '.release', '')
    await first.wait(context)
    expect(await readFile(log, 'utf8')).toBe('start\nend\n')
    const view = await server.root.viewState(context)
    try {
      const result = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
        ?.model?.[0]
      expect(result?.role === 'toolResult' && result.isError).toBe(false)
    } finally {
      view.dispose()
    }
    vi.stubEnv('ULTIMATE_BASH_TIMEOUT', '1')
    await (
      await second.submit(
        { type: 'input', content: JSON.stringify({ command: 'sleep 10 # heavy' }) },
        context,
      )
    ).wait(context)
    const timed = await second.viewState(context)
    try {
      const result = timed.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
        ?.model?.[0]
      expect(result?.role === 'toolResult' && result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain('Tripwire: bash ran past the 1 s default limit')
    } finally {
      timed.dispose()
    }
  } finally {
    vi.unstubAllEnvs()
    await server.close()
    await removeTemp(directory)
  }
})
