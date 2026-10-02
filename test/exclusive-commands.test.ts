import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { fauxServer, temp, until } from './helpers.ts'

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
      JSON.stringify({ exclusiveCommands: ['# heavy', '['] }),
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
        content: `echo first-start >> '${log}'; sleep 1; echo first-end >> '${log}' # heavy`,
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
      JSON.stringify({ exclusiveCommands: '# heavy' }),
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
    await rm(directory, { recursive: true, force: true })
  }
})
