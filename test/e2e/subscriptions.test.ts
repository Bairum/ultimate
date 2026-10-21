import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { JsonValue } from '@earendil-works/chord'
import type { ConversationId } from '@earendil-works/pi-durable'
import { Board } from '../../extensions/board/api.ts'
import { Subscriptions } from '../../extensions/subscriptions/server.ts'
import type { Subscription } from '../../extensions/subscriptions/types.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, temp, until } from '../helpers.ts'

let server: Awaited<ReturnType<typeof fauxServer>> | undefined
afterEach(async () => {
  await server?.close()
})

it('delivers FIRE once, investigates exits only in the owning agent, recovers, and escalates through Board', async () => {
  const root = await temp('ultimate-subscriptions-')
  const userHome = join(root, 'user')
  const home = join(root, 'project-state')
  const definitions = join(userHome, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  for (const name of ['subscription', 'ultimate'])
    await writeFile(
      join(definitions, `${name}.md`),
      `---\nname: ${name}\ndescription: Subscription test\nmodel: faux/faux-1\ntools: []\n${name === 'ultimate' ? 'resident: true\n' : ''}---\nKeep answers short.\n`,
    )
  const options = { ultimateRoot: resolve('.'), projectRoot: root, userHome, home }
  server = await fauxServer(options)
  let app = server
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const invoke = (action: string, args: JsonValue = null) =>
    app.extensions.invoke('subscriptions', action, args, new AbortController().signal, caller.id)
  const get = async (id: string) =>
    (await app.harness.snapshot(Subscriptions, context))!.subscriptions[id]
  const entries = async (id: number, kind: string) => {
    const conversation = (await app.harness.conversation(id as ConversationId, context))!
    return (await conversation.context(context)).entries.filter(
      (e) => e.conversationId === id && e.kind === kind,
    )
  }
  const script = async (id: string, text: string) => {
    const dir = join(userHome, '.ultimate/subscriptions', basename(home), id)
    await mkdir(join(dir, 'state'), { recursive: true })
    await writeFile(join(dir, 'run'), `#!/bin/sh\n${text}\n`)
    await chmod(join(dir, 'run'), 0o700)
  }
  const first = (await invoke('create', {
    ask: 'Wake me when this finishes',
    title: 'CI',
  })) as Subscription
  expect(first).toMatchObject({ id: 'S1', state: 'writing', once: true, subscribers: [caller.id] })
  await script(first.id, 'sleep 2; echo FIRE done')
  await invoke('start', { id: first.id })
  await until(
    async () =>
      (await get(first.id)).state === 'done' &&
      (await entries(caller.id, 'subscriptions.fired')).length === 1,
  )
  expect((await entries(caller.id, 'subscriptions.fired'))[0].data).toMatchObject({
    id: first.id,
    title: 'CI',
    text: 'done',
  })
  expect(await get(first.id)).toMatchObject({ enabled: false, fires: 1 })

  const second = (await invoke('create', {
    ask: 'Watch a failing process',
    title: 'Failure',
  })) as Subscription
  await script(second.id, 'echo broken >&2; exit 3')
  await invoke('start', { id: second.id })
  await until(
    async () => (await entries(second.conversationId, 'subscriptions.failed')).length === 1,
  )
  expect(await get(second.id)).toMatchObject({ state: 'investigating', exitCode: 3 })
  expect(await entries(caller.id, 'subscriptions.failed')).toHaveLength(0)
  expect(JSON.stringify(await entries(second.conversationId, 'subscriptions.failed'))).toContain(
    'code 3',
  )
  expect(await invoke('log', { id: second.id })).toEqual({ text: 'broken' })
  // Recovery itself never wakes subscribers; only the eventual FIRE does.
  await script(second.id, 'echo FIRE recovered')
  await invoke('start', { id: second.id })
  await until(
    async () =>
      (await get(second.id)).state === 'done' &&
      (await entries(caller.id, 'subscriptions.fired')).length === 2,
  )
  expect(await entries(caller.id, 'subscriptions.escalated')).toHaveLength(0)

  const third = (await invoke('create', { ask: 'This cannot work' })) as Subscription
  await invoke('escalate', { id: third.id, reason: 'No access to the remote system' })
  await until(async () => (await entries(caller.id, 'subscriptions.escalated')).length === 1)
  expect(await get(third.id)).toMatchObject({ state: 'failed', enabled: false })
  const messages = (await app.harness.snapshot(Board, 1 as ConversationId, context))!.messages
  expect(
    messages.filter(
      (m) => m.from === third.conversationId && m.text.includes('No access to the remote system'),
    ),
  ).toHaveLength(1)
  await invoke('delete', { id: third.id })
  expect(
    (await app.harness.snapshot(Subscriptions, context))!.subscriptions[third.id],
  ).toBeUndefined()
  expect(
    await app.harness.conversation(third.conversationId as ConversationId, context),
  ).toBeDefined()

  const recurring = (await invoke('create', { ask: 'Keep watching', once: false })) as Subscription
  await script(recurring.id, 'echo FIRE tick; exit 0')
  await invoke('start', { id: recurring.id })
  await until(
    async () => (await entries(recurring.conversationId, 'subscriptions.failed')).length === 1,
  )
  expect(await get(recurring.id)).toMatchObject({ state: 'investigating', exitCode: 0, fires: 1 })

  const restart = (await invoke('create', { ask: 'Survive a server reopen' })) as Subscription
  await script(restart.id, 'echo stopping; sleep 60')
  const beforeRestart = (await invoke('start', { id: restart.id })) as Subscription
  const afterRestart = (await invoke('start', { id: restart.id })) as Subscription
  expect(afterRestart.pid).not.toBe(beforeRestart.pid)
  await invoke('stop', { id: restart.id })
  await until(async () => !!(await get(restart.id)).exitedAt)
  expect(await get(restart.id)).toMatchObject({ state: 'stopped', enabled: false })
  expect(await entries(restart.conversationId, 'subscriptions.failed')).toHaveLength(0)
  await script(
    restart.id,
    'if [ -e "$SUBSCRIPTION_STATE/ready" ]; then echo FIRE resumed; else touch "$SUBSCRIPTION_STATE/ready"; echo ready-for-reopen; sleep 60; fi',
  )
  await invoke('start', { id: restart.id })
  await until(async () =>
    ((await invoke('log', { id: restart.id })) as { text: string }).text.includes(
      'ready-for-reopen',
    ),
  )
  await app.close()
  server = undefined
  app = await fauxServer(options)
  server = app
  await until(
    async () =>
      (await get(restart.id)).state === 'done' &&
      (await entries(caller.id, 'subscriptions.fired')).length === 4,
  )
  expect(
    (await entries(caller.id, 'subscriptions.fired')).map((e) => (e.data as { text: string }).text),
  ).toEqual(['done', 'recovered', 'tick', 'resumed'])

  const disabled = (await invoke('create', {
    ask: 'Stop with the optional extension',
  })) as Subscription
  await script(disabled.id, 'sleep 60')
  const running = (await invoke('start', { id: disabled.id })) as Subscription
  await mkdir(join(root, '.ultimate'), { recursive: true })
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['subscriptions'] } }),
  )
  await until(() => app.extensions.info().some((e) => e.name === 'subscriptions' && !e.enabled))
  await until(() => {
    try {
      process.kill(running.pid!, 0)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
  })
})
