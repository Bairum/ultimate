import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord'
import type { ConversationId } from '@earendil-works/pi-durable'
import { Messages } from '../../extensions/messages/api.ts'
import { launchHandshake, Subscriptions } from '../../extensions/subscriptions/server.ts'
import { Done, Exited } from '../../extensions/subscriptions/refs.ts'
import type { Subscription } from '../../extensions/subscriptions/types.ts'
import { context } from '../../server/harness.ts'
import { eventHost, fauxServer, temp, until } from '../helpers.ts'

let server: Awaited<ReturnType<typeof fauxServer>> | undefined
afterEach(async () => {
  const app = server
  server = undefined
  await app?.close()
})

async function fixture(localSetup = true) {
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
  const options = { ultimateRoot: resolve('.'), projectRoot: root, userHome, home, localSetup }
  server = await fauxServer(options)
  return {
    root,
    userHome,
    home,
    options,
    app: server,
    folder: (id: string) => join(userHome, '.ultimate/subscriptions', basename(home), id),
  }
}
async function create(app: NonNullable<typeof server>) {
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  return (await app.extensions.invoke(
    'subscriptions',
    'create',
    { ask: 'Watch this script' },
    new AbortController().signal,
    caller.id,
  )) as Subscription
}
async function writeRun(folder: string, script: string) {
  await mkdir(join(folder, 'state'), { recursive: true })
  await writeFile(join(folder, 'run'), `#!/bin/sh\n${script}\n`)
  await chmod(join(folder, 'run'), 0o700)
}
function call(app: NonNullable<typeof server>, action: string, id: string) {
  return app.extensions.invoke('subscriptions', action, { id }, new AbortController().signal)
}

it('delivers FIRE once, investigates exits only in the owning agent, recovers, and escalates through Messages', async () => {
  const { root, userHome, home, options, app: initial } = await fixture()
  let app = initial
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
  const messages = (await app.harness.snapshot(Messages, 1 as ConversationId, context))!.messages
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

it('stops a recurring script that prints DONE and exits 0 without waking anyone; start resumes it with its state', async () => {
  const { app, folder } = await fixture()
  const sub = (await app.extensions.invoke(
    'subscriptions',
    'create',
    { ask: 'Poll until merged', once: false },
    new AbortController().signal,
    (await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)).id,
  )) as Subscription
  const get = async () =>
    (await app.harness.snapshot(Subscriptions, context))!.subscriptions[sub.id]
  const inputs = async (id: number) =>
    (
      await (await app.harness.conversation(id as ConversationId, context))!.context(context)
    ).entries
      .filter((e) => e.conversationId === id && e.kind.startsWith('subscriptions.'))
      .map((e) => e.kind)
  const done = () => eventHost(() => app.harness, 'test').eventLog.recent({ events: [Done] })
  // Each run counts itself in its state folder, fires the count and stops itself.
  await writeRun(
    folder(sub.id),
    'n=$(($(cat "$SUBSCRIPTION_STATE/n" 2>/dev/null || echo 0) + 1)); echo $n > "$SUBSCRIPTION_STATE/n"; echo FIRE $n; echo DONE all merged',
  )
  await call(app, 'start', sub.id)
  await until(async () => !!(await get()).exitedAt)
  expect(await get()).toMatchObject({ state: 'stopped', enabled: false, exitCode: 0, fires: 1 })
  expect((await get()).error).toBeUndefined()
  expect((await done()).map((e) => e.data)).toEqual([{ id: sub.id, text: 'all merged' }])
  await call(app, 'start', sub.id)
  await until(async () => (await get()).fires === 2 && (await get()).state === 'stopped')
  expect(await readFile(join(folder(sub.id), 'state/n'), 'utf8')).toBe('2\n')
  await until(async () => (await inputs(sub.subscribers[0])).length === 2)
  expect(await inputs(sub.subscribers[0])).toEqual(['subscriptions.fired', 'subscriptions.fired'])
  // The owning agent got only its writing brief: no failure input.
  expect(await inputs(sub.conversationId)).toEqual(['subscriptions.writing'])

  // DONE followed by a non-zero exit stays a failure.
  await writeRun(folder(sub.id), 'echo DONE; exit 2')
  await call(app, 'start', sub.id)
  await until(async () => (await get()).state === 'investigating')
  expect(await get()).toMatchObject({ exitCode: 2, enabled: true })
  await until(async () => (await inputs(sub.conversationId)).includes('subscriptions.failed'))
  expect(await done()).toHaveLength(2)

  // A one-shot cannot DONE: exiting without a FIRE still fails, so its subscribers are not left waiting.
  const once = await create(app)
  await writeRun(folder(once.id), 'echo DONE')
  await call(app, 'start', once.id)
  await until(
    async () =>
      (await app.harness.snapshot(Subscriptions, context))!.subscriptions[once.id].state ===
      'investigating',
  )
  expect(await done()).toHaveLength(2)
})

/** A recurring project subscription committed in `root`'s `.ultimate/subscriptions/<slug>/`. */
async function committed(root: string, slug: string, script: string) {
  const dir = join(root, '.ultimate/subscriptions', slug)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'subscription.json'),
    JSON.stringify({ title: 'Ship PRs', ask: 'Poll ship/* PRs', once: false }),
  )
  await writeFile(join(dir, 'run'), `#!/bin/sh\n${script}\n`)
  await chmod(join(dir, 'run'), 0o700)
}
async function list(app: NonNullable<typeof server>) {
  return (await app.extensions.invoke(
    'subscriptions',
    'list',
    null,
    new AbortController().signal,
  )) as Subscription[]
}

it('discovers a committed project subscription by slug only in a chosen project, and starts, stops and DONEs it there', async () => {
  // Not chosen as local: the committed folder is ignored and cannot be addressed.
  const untrusted = await fixture(false)
  await committed(untrusted.root, 'prs', 'echo FIRE never')
  expect(await list(untrusted.app)).toEqual([])
  await expect(call(untrusted.app, 'start', 'prs')).rejects.toThrow('Unknown subscription: prs')
  await untrusted.app.close()
  server = undefined

  const { root, app, folder } = await fixture()
  // It runs in the project checkout and keeps state in the machine-local folder.
  await committed(
    root,
    'prs',
    'pwd > "$SUBSCRIPTION_STATE/cwd"; echo 1 > "$SUBSCRIPTION_STATE/n"; echo FIRE 1; sleep 60',
  )
  const [found] = await list(app)
  expect(found).toMatchObject({
    id: 'prs',
    scope: 'project',
    title: 'Ship PRs',
    once: false,
    state: 'stopped',
    enabled: false,
    subscribers: [],
  })
  // Discovery never starts it; its agent conversation exists, idle.
  expect(found.pid).toBeUndefined()
  expect(
    await app.harness.conversation(found.conversationId as ConversationId, context),
  ).toBeDefined()
  expect((await list(app)).map((s) => s.conversationId)).toEqual([found.conversationId])

  const get = async () => (await app.harness.snapshot(Subscriptions, context))!.subscriptions.prs
  const started = (await call(app, 'start', 'prs')) as Subscription
  expect(started).toMatchObject({ state: 'running', enabled: true })
  await until(async () => (await get()).fires === 1)
  expect(await readFile(join(folder('prs'), 'state/cwd'), 'utf8')).toBe(`${root}\n`)
  expect(await readFile(join(folder('prs'), 'output.log'), 'utf8')).toContain('FIRE 1')
  await expect(
    readFile(join(root, '.ultimate/subscriptions/prs/output.log')),
  ).rejects.toMatchObject({ code: 'ENOENT' })
  await call(app, 'stop', 'prs')
  await until(async () => !!(await get()).exitedAt)
  expect(await get()).toMatchObject({ state: 'stopped', enabled: false })
  await expect(readFile(join(folder('prs'), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })

  // An edited run is picked up on the next start, with its state kept; DONE then exit 0 stops it cleanly.
  await committed(
    root,
    'prs',
    'n=$(($(cat "$SUBSCRIPTION_STATE/n") + 1)); echo $n > "$SUBSCRIPTION_STATE/n"; echo FIRE $n; echo DONE nothing left',
  )
  await call(app, 'start', 'prs')
  await until(async () => (await get()).fires === 2 && (await get()).state === 'stopped')
  expect(await get()).toMatchObject({ enabled: false, exitCode: 0 })
  expect((await get()).error).toBeUndefined()
  const done = await eventHost(() => app.harness, 'test').eventLog.recent({ events: [Done] })
  expect(done.map((e) => e.data)).toEqual([{ id: 'prs', text: 'nothing left' }])

  // A removed folder forgets the record.
  await rm(join(root, '.ultimate/subscriptions/prs'), { recursive: true })
  expect(await list(app)).toEqual([])
})

it('creates a project subscription in the checkout with a committed manifest', async () => {
  const { root, app } = await fixture()
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  // A create that fails before it has an agent leaves the slug free for the retry.
  await expect(
    app.extensions.invoke(
      'subscriptions',
      'create',
      { ask: 'Poll ship PRs', title: 'Ship PRs', scope: 'project' },
      new AbortController().signal,
      999_999,
    ),
  ).rejects.toThrow('Unknown caller #999999')
  const sub = (await app.extensions.invoke(
    'subscriptions',
    'create',
    {
      ask: 'Poll ship PRs',
      title: 'Ship PRs',
      once: false,
      scope: 'project',
      secrets: ['GH_TOKEN'],
    },
    new AbortController().signal,
    caller.id,
  )) as Subscription
  expect(sub).toMatchObject({
    id: 'ship-prs',
    scope: 'project',
    state: 'writing',
    subscribers: [caller.id],
  })
  expect(
    JSON.parse(
      await readFile(join(root, '.ultimate/subscriptions/ship-prs/subscription.json'), 'utf8'),
    ),
  ).toEqual({ title: 'Ship PRs', ask: 'Poll ship PRs', once: false, secrets: ['GH_TOKEN'] })
  // Discovery keeps the created record and its agent.
  const listed = (await app.extensions.invoke(
    'subscriptions',
    'list',
    null,
    new AbortController().signal,
  )) as Subscription[]
  expect(listed).toMatchObject([
    { id: 'ship-prs', conversationId: sub.conversationId, state: 'writing' },
  ])
  await expect(
    app.extensions.invoke(
      'subscriptions',
      'create',
      { ask: 'Again', title: 'Ship PRs', scope: 'project' },
      new AbortController().signal,
      caller.id,
    ),
  ).rejects.toThrow('Subscription ship-prs already exists')
  // The identical create (as a replay would send it) cannot reset a record that has been used either.
  await expect(
    app.extensions.invoke(
      'subscriptions',
      'create',
      {
        ask: 'Poll ship PRs',
        title: 'Ship PRs',
        once: false,
        scope: 'project',
        secrets: ['GH_TOKEN'],
      },
      new AbortController().signal,
      caller.id,
    ),
  ).rejects.toThrow('Subscription ship-prs already exists')
  expect((await list(app))[0]).toMatchObject({ subscribers: [caller.id], state: 'writing' })

  // A discovered, unused record with the same manifest is adopted with its agent; inherited object keys are no slugs.
  await committed(root, 'ship-prs-2', 'true')
  const discovered = (await list(app)).find((s) => s.id === 'ship-prs-2')!
  const adopted = (await app.extensions.invoke(
    'subscriptions',
    'create',
    {
      ask: 'Poll ship/* PRs',
      title: 'Ship PRs',
      once: false,
      scope: 'project',
      slug: 'ship-prs-2',
    },
    new AbortController().signal,
    caller.id,
  )) as Subscription
  expect(adopted).toMatchObject({
    conversationId: discovered.conversationId,
    subscribers: [caller.id],
  })
  await expect(
    app.extensions.invoke(
      'subscriptions',
      'create',
      { ask: 'x', scope: 'project', slug: 'constructor' },
      new AbortController().signal,
      caller.id,
    ),
  ).rejects.toThrow('not be an object key')
})

it('waits for a SIGTERM-ignoring script to die before stop returns and removes its pid file', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  await writeRun(folder(sub.id), "trap '' TERM; echo ready; exec sleep 60")
  const running = (await call(app, 'start', sub.id)) as Subscription
  await until(async () =>
    ((await call(app, 'log', sub.id)) as { text: string }).text.includes('ready'),
  )
  expect(Number(await readFile(join(folder(sub.id), 'pid'), 'utf8'))).toBe(running.pid)
  await call(app, 'stop', sub.id)
  expect(() => process.kill(-running.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['stop', 'delete'])(
  'awaits %s of a fired one-shot during its termination grace period',
  async (action) => {
    const { app, folder } = await fixture()
    const sub = await create(app)
    await writeRun(folder(sub.id), 'trap "" TERM; echo FIRE done; exec sleep 60')
    await call(app, 'start', sub.id)
    await until(
      async () =>
        (await app.harness.snapshot(Subscriptions, context))!.subscriptions[sub.id].state ===
        'done',
    )
    const pid = Number(await readFile(join(folder(sub.id), 'pid'), 'utf8'))
    expect(
      (await app.harness.snapshot(Subscriptions, context))!.subscriptions[sub.id],
    ).toMatchObject({ state: 'done', enabled: false, pid })
    expect(process.kill(-pid, 0)).toBe(true)
    await call(app, action, sub.id)
    expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
    const saved = (await app.harness.snapshot(Subscriptions, context))!.subscriptions[sub.id]
    const stopped = expect.objectContaining({
      state: 'done',
      enabled: false,
      exitedAt: expect.any(Number),
    })
    expect(saved).toEqual(action === 'delete' ? undefined : stopped)
    expect(saved?.pid).toBeUndefined()
  },
)

it.each([false, true])(
  'launch handshake go=%s: EOF aborts; exec keeps the pid and gives the script empty stdin',
  async (go) => {
    const root = await temp('ultimate-subscription-handshake-')
    await writeRun(
      root,
      'echo "$$"; if read -r value; then echo unexpected-input; else echo eof; fi',
    )
    const child = spawn('/bin/sh', ['-c', launchHandshake, join(root, 'run')], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (done, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => done({ code, signal }))
      },
    )
    child.stdin.end(go ? '\n' : undefined)
    expect(await exited).toEqual({ code: go ? 0 : 1, signal: null })
    expect(output).toBe(go ? `${child.pid}\neof\n` : '')
    expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  },
)

it('records the exit metadata and event for a successful done one-shot without a failure', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  await writeRun(folder(sub.id), "trap 'exit 0' TERM; echo FIRE done; while :; do :; done")
  await call(app, 'start', sub.id)
  await until(
    async () =>
      !!(await app.harness.snapshot(Subscriptions, context))!.subscriptions[sub.id].exitedAt,
  )
  const saved = (await app.harness.snapshot(Subscriptions, context))!.subscriptions[sub.id]
  expect(saved).toMatchObject({ state: 'done', enabled: false, fires: 1, exitCode: 0 })
  expect(saved.pid).toBeUndefined()
  const events = await eventHost(() => app.harness, 'test').eventLog.recent({ events: [Exited] })
  expect(events.filter((event) => event.data.id === sub.id).map((event) => event.data)).toEqual([
    { id: sub.id, code: 0 },
  ])
  const agent = (await app.harness.conversation(sub.conversationId as ConversationId, context))!
  expect(
    (await agent.context(context)).entries.filter((entry) => entry.kind === 'subscriptions.failed'),
  ).toHaveLength(0)
})

it('sweeps a crashed process pid file even when no subscription record exists', async () => {
  const { app, folder, options } = await fixture()
  await app.close()
  server = undefined
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  const exited = new Promise<void>((done) => child.once('close', () => done()))
  try {
    await mkdir(folder('S999'), { recursive: true })
    await writeFile(join(folder('S999'), 'pid'), `${child.pid}\n`)
    server = await fauxServer(options)
    await exited
    expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    await expect(readFile(join(folder('S999'), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, 'SIGKILL')
    await exited
  }
})

it('commits a one-shot as done before termination and never starts it again on reopen', async () => {
  const { app, folder, options } = await fixture()
  const sub = await create(app)
  await writeRun(
    folder(sub.id),
    'trap "" TERM; echo started >> "$SUBSCRIPTION_STATE/starts"; echo FIRE done; exec sleep 60',
  )
  await call(app, 'start', sub.id)
  await until(
    async () =>
      (await app.harness.snapshot(Subscriptions, context))!.subscriptions[sub.id].state === 'done',
  )
  expect((await app.harness.snapshot(Subscriptions, context))!.subscriptions[sub.id]).toMatchObject(
    { enabled: false, fires: 1 },
  )
  await app.close()
  server = undefined
  server = await fauxServer(options)
  expect(
    (await server.harness.snapshot(Subscriptions, context))!.subscriptions[sub.id],
  ).toMatchObject({ state: 'done', enabled: false, fires: 1 })
  expect(await readFile(join(folder(sub.id), 'state/starts'), 'utf8')).toBe('started\n')
  await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('closes during a pending start without spawning a process after cleanup', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  await writeRun(folder(sub.id), 'echo $$ > "$SUBSCRIPTION_STATE/started"; exec sleep 60')
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let held = false
  const original = app.harness.snapshot.bind(app.harness) as (
    ...args: unknown[]
  ) => Promise<unknown>
  // Snapshot is overloaded; preserve its API while holding this specific launch before its async file work.
  const snapshot = vi.spyOn(app.harness, 'snapshot').mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = await original(...args)
    if (
      !held &&
      (args[0] as typeof Subscriptions).definition.kind === Subscriptions.definition.kind &&
      (result as { subscriptions: Record<string, Subscription> })?.subscriptions[sub.id]?.state ===
        'running'
    ) {
      held = true
      entered.resolve()
      await resume.promise
    }
    return result
  }) as typeof app.harness.snapshot)
  try {
    const starting = call(app, 'start', sub.id).then(
      () => '',
      (error: unknown) => String(error),
    )
    await entered.promise
    // Release invokes the same supervisor close callback synchronously, before full host shutdown awaits it.
    const releasing = app.extensions.released()
    const closing = app.close()
    resume.resolve()
    expect(await starting).toContain('supervisor is closing')
    await releasing
    await closing
    server = undefined
    await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(folder(sub.id), 'state/started'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  } finally {
    resume.resolve()
    snapshot.mockRestore()
  }
})
