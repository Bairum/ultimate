import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import instance from '../extensions/instance/server.ts'
import subagents, { Subagents } from '../extensions/subagents/server.ts'
import { git } from '../extensions/subagents/isolates/worktree.ts'
import { temp } from './helpers.ts'

it('previews a worktree child on its own home and port and validates child inputs', async () => {
  const root = await temp('ultimate-preview-')
  const source = resolve('.')
  const prepared = await prepareHarness({
    ultimateRoot: source,
    projectRoot: source,
    home: join(root, 'home'),
    userHome: root,
    faux: true,
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const resources = new Map<string, unknown>()
  const cleanups: (() => Promise<void>)[] = []
  const host = {
    ...prepared,
    harness: () => opened.harness,
    metadata: Metadata,
    resource<T>(key: string, create: () => T): T {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onClose(cleanup: () => Promise<void>) {
      cleanups.push(cleanup)
    },
  }
  prepared.registry.install(subagents(host))
  prepared.registry.install(instance(host))
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (
      last.role === 'user' &&
      typeof last.content === 'string' &&
      last.content.startsWith('CALL ')
    ) {
      const { tool, args } = JSON.parse(last.content.slice(5))
      return fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([fauxText('Finished')])
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  let path: string | undefined
  let branch: string | undefined
  async function call(tool: string, args: object) {
    await (
      await opened.root.submit(
        { type: 'input', content: `CALL ${JSON.stringify({ tool, args })}` },
        context,
      )
    ).wait(context)
    const view = await opened.root.viewState(context)
    const result = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
      ?.model?.[0]
    view.dispose()
    if (result?.role !== 'toolResult') throw new Error('Missing tool result')
    return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
  try {
    expect(await call('instance', { action: 'start', subagent: 999999, faux: true })).toContain(
      'Unknown subagent',
    )
    await call('subagent', {
      action: 'start',
      agent: 'worker',
      task: 'Finish without tools',
      isolate: 'worktree',
    })
    const child = Object.values(
      (await opened.harness.snapshot(Subagents, opened.root.id, context))!.agents,
    )[0]
    path = child.isolate!.path
    branch = child.isolate!.branch
    const preview = JSON.parse(
      await call('instance', { action: 'start', subagent: child.conversationId, faux: true }),
    )
    expect(preview.home).not.toBe(prepared.home)
    const response = await fetch(`${preview.url}/api/models`)
    expect(response.status).toBe(200)
    expect(await response.json()).toBeTruthy()
    expect(await call('instance', { action: 'start', home: prepared.home, faux: true })).toContain(
      'cannot share',
    )
    expect(JSON.parse(await call('instance', { action: 'stop', id: preview.id }))).toEqual({
      stopped: preview.id,
    })
    expect(JSON.parse(await call('instance', { action: 'list' }))).toEqual([])
    await rm(preview.home, { recursive: true, force: true })
  } finally {
    for (const cleanup of cleanups) await cleanup()
    await opened.close()
    if (path) await git(source, 'worktree', 'remove', '--force', path)
    if (branch) await git(source, 'branch', '-D', branch)
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
