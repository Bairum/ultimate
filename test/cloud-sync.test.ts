import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import cloud, { PING_EVERY, QUICK_RECONNECT_AFTER, startSync } from '../extensions/cloud/server.ts'
import type { SyncHooks, SyncSocket } from '../extensions/cloud/server.ts'
import { PROJECT_MISMATCH } from '../cloud/protocol.ts'
import type { CloudMessage, MachineMessage } from '../cloud/protocol.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const KEY = 'github.com/hazat/test'
const ROOT_COMMIT = 'a'.repeat(40)
const role = (
  value: 'writer' | 'standby',
  epoch = 1,
  online = true,
): Extract<CloudMessage, { type: 'role' }> => ({
  type: 'role',
  role: value,
  project: { key: KEY },
  epoch,
  free: false,
  writer: {
    machine: 'writer-machine',
    root: '/writer',
    epoch,
    online,
    secrets: [],
    secretsComplete: true,
  },
})

class FakeCloud extends EventTarget implements SyncSocket {
  url: string
  constructor(url: string) {
    super()
    this.url = url
  }
  messages: MachineMessage[] = []
  pings = 0
  /** Answer each `ping` with `pong`, as the replica's auto-response does. */
  pong = true
  closed = false
  send(data: string) {
    if (data === 'ping') {
      this.pings++
      if (this.pong)
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: 'pong' })))
      return
    }
    this.messages.push(JSON.parse(data) as MachineMessage)
  }
  close() {
    this.closed = true
  }
  receive(message: CloudMessage) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }
  /** Connect and hear `role`. */
  open(value: 'writer' | 'standby' = 'writer', epoch = 1) {
    this.dispatchEvent(new Event('open'))
    this.receive(role(value, epoch))
  }
}

async function fixture(hooks?: SyncHooks) {
  const home = await temp('ultimate-cloud-')
  const prepared = await prepareHarness({ ultimateRoot: home, userHome: home, home, faux: true })
  prepared.faux!.setResponses([fauxAssistantMessage('cloud answer')])
  const opened = await prepared.open()
  const notices: string[] = []
  const tailscale: { url?: string } = {}
  const host = {
    ...prepared,
    want: (api: { name: string }) =>
      api.name === 'tailscale'
        ? { status: () => ({ state: 'ready', allow: [], ...tailscale }) }
        : undefined,
    projectRoot: home,
    harness: () => opened.harness,
    system: () => ({ online: true, process: { url: 'http://127.0.0.1:4800' } }),
    build: () => ({ id: 'test-build' }),
    notice: (message: string) => notices.push(message),
  } as unknown as ExtensionHost
  const sockets: FakeCloud[] = []
  vi.useFakeTimers()
  const stop = startSync(
    host,
    {
      url: 'wss://fake/sync',
      token: 'token',
      machine: 'test-machine',
      identity: { key: KEY, rootCommit: ROOT_COMMIT },
    },
    (url) => {
      const socket = new FakeCloud(url)
      sockets.push(socket)
      return socket
    },
    hooks,
  )
  return {
    opened,
    host,
    home,
    notices,
    tailscale,
    sockets,
    stop,
    drain: () => stop.idle(),
    async close() {
      stop()
      vi.useRealTimers()
      await opened.close()
    },
  }
}

it('says hello with the project, checkout and lease, naming whether storage has history', async () => {
  const f = await fixture()
  try {
    const [socket] = f.sockets
    expect(new URL(socket.url).pathname).toBe('/sync/v2')
    expect(new URL(socket.url).searchParams.get('project')).toBe(KEY)
    socket.dispatchEvent(new Event('open'))
    await f.drain()
    expect(socket.messages).toEqual([
      {
        type: 'hello',
        key: KEY,
        rootCommit: ROOT_COMMIT,
        root: f.home,
        machine: 'test-machine',
        build: 'test-build',
        port: 4800,
        history: false,
        secrets: [],
        secretsComplete: true,
      },
    ])
    await f.opened.harness.commit(
      (tx) => tx.appendEntry(f.opened.root.id, { kind: 'cloud-test.entry', data: {} }),
      context,
    )
    socket.dispatchEvent(new Event('close'))
    await vi.advanceTimersByTimeAsync(1000)
    f.sockets[1].dispatchEvent(new Event('open'))
    await f.drain()
    expect(f.sockets[1].messages[0]).toMatchObject({ type: 'hello', history: true })
  } finally {
    await f.close()
  }
})

it("names the tailnet address in hello and on change, and records a standby's writer for the ultimate command", async () => {
  const f = await fixture()
  try {
    f.tailscale.url = 'https://test.tail3a3a66.ts.net:4747'
    const [socket] = f.sockets
    socket.open()
    await f.drain()
    expect(socket.messages[0]).toMatchObject({
      type: 'hello',
      tailnet: 'https://test.tail3a3a66.ts.net:4747',
    })
    // The writer records no other writer.
    await expect(readFile(join(f.home, 'cloud-writer.json'), 'utf8')).rejects.toThrow('ENOENT')
    // Tailscale stops, then publishes again: the cloud hears each change once, not every check.
    f.tailscale.url = undefined
    await vi.advanceTimersByTimeAsync(5000 * 3)
    f.tailscale.url = 'https://test.tail3a3a66.ts.net:4747'
    await vi.advanceTimersByTimeAsync(5000 * 3)
    expect(socket.messages.filter((message) => message.type === 'tailnet')).toEqual([
      { type: 'tailnet', url: null },
      { type: 'tailnet', url: 'https://test.tail3a3a66.ts.net:4747' },
    ])
    // A standby whose writer is another machine with an address records it; it goes once the writer has none.
    const writer = role('standby').writer
    socket.receive({
      ...role('standby'),
      writer: { ...writer, tailnet: 'https://writer.tail3a3a66.ts.net:4747' },
    })
    await f.drain()
    expect(JSON.parse(await readFile(join(f.home, 'cloud-writer.json'), 'utf8'))).toEqual({
      machine: 'writer-machine',
      tailnet: 'https://writer.tail3a3a66.ts.net:4747',
    })
    socket.receive(role('standby'))
    await f.drain()
    await expect(readFile(join(f.home, 'cloud-writer.json'), 'utf8')).rejects.toThrow('ENOENT')
  } finally {
    await f.close()
  }
})

it('admits a lease message deferred from the role notification', async () => {
  const sent: boolean[] = []
  const f = await fixture({
    serving: false,
    role: (state) => {
      // Lease callbacks send after the notification, without waiting for the sync queue to drain.
      queueMicrotask(() => sent.push(f.stop.send({ type: 'claim', epoch: state.epoch! })))
    },
  })
  try {
    const [socket] = f.sockets
    expect(f.stop.send({ type: 'claim', epoch: 1 })).toBe(false)
    socket.open('standby')
    await f.drain()
    expect(sent).toEqual([true])
    expect(socket.messages).toContainEqual({ type: 'claim', epoch: 1 })
  } finally {
    await f.close()
  }
})

it('pings every 30 s and stays connected while the replica answers', async () => {
  const f = await fixture()
  try {
    const [socket] = f.sockets
    socket.open()
    await f.drain()
    await vi.advanceTimersByTimeAsync(PING_EVERY * 10)
    expect(socket.pings).toBe(10)
    expect(socket.closed).toBe(false)
    expect(f.sockets).toHaveLength(1)
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('reconnects a half-open socket that heard no pong for 60 s, once', async () => {
  const f = await fixture()
  try {
    const [socket] = f.sockets
    socket.pong = false
    socket.open()
    await f.drain()
    await vi.advanceTimersByTimeAsync(PING_EVERY * 2)
    expect(socket.pings).toBe(2)
    expect(socket.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(PING_EVERY)
    expect(socket.closed).toBe(true)
    expect(f.notices).toEqual(['Cloud sync: no answer for 60 s; reconnecting'])
    // The socket had been open long enough: the next connection starts at once, without backoff (fake timers make
    // a zero timeout set inside a timer callback 1 ms), and the old one is no longer pinged.
    await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets).toHaveLength(2)
    f.sockets[1].open()
    await f.drain()
    await vi.advanceTimersByTimeAsync(PING_EVERY * 4)
    expect(socket.pings).toBe(2)
    expect(f.sockets[1].closed).toBe(false)
    expect(f.notices).toHaveLength(1)
  } finally {
    await f.close()
  }
})

it('stops reconnecting after a project mismatch and reports it only once', async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    const event = Object.assign(new Event('close'), {
      code: PROJECT_MISMATCH,
      reason: 'root commit differs',
    })
    socket.dispatchEvent(event)
    socket.dispatchEvent(event)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.sockets).toHaveLength(1)
    expect(f.notices).toEqual([
      `Cloud sync stopped: the cloud refused ${KEY} (root commit differs); use cloud.relink if the repository was renamed.`,
    ])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await f.close()
  }
})

it('keeps exponential reconnect backoff for ordinary close codes', async () => {
  const f = await fixture()
  try {
    f.sockets[0].dispatchEvent(
      Object.assign(new Event('close'), { code: 1011, reason: 'temporary' }),
    )
    await vi.advanceTimersByTimeAsync(999)
    expect(f.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets).toHaveLength(2)
    f.sockets[1].dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' }))
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets).toHaveLength(3)
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('stores the lease epoch it is given as writer and names it in the next hello', async () => {
  const f = await fixture()
  try {
    const lease = join(f.host.home, 'cloud-lease.json')
    await writeFile(lease, JSON.stringify({ key: 'github.com/other/project', epoch: 7 }))
    const socket = f.sockets[0]
    socket.open('writer', 3)
    await f.drain()
    expect(socket.messages[0]).not.toHaveProperty('epoch')
    expect(JSON.parse(await readFile(lease, 'utf8'))).toEqual({ key: KEY, epoch: 3 })
    expect(f.stop.state()).toMatchObject({ key: KEY, connected: true, role: 'writer', epoch: 3 })
    socket.dispatchEvent(new Event('close'))
    expect(f.stop.state()).toMatchObject({ connected: false, role: 'writer' })
    await vi.advanceTimersByTimeAsync(1000)
    f.sockets[1].dispatchEvent(new Event('open'))
    await f.drain()
    expect(f.sockets[1].messages[0]).toMatchObject({ type: 'hello', epoch: 3 })
  } finally {
    await f.close()
  }
})

it('sends nothing but its hello as a standby, keeps the socket and follows role updates', async () => {
  const f = await fixture({ serving: false })
  try {
    const socket = f.sockets[0]
    socket.open('standby', 2)
    await f.drain()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket.messages.map((message) => message.type)).toEqual(['hello'])
    expect(socket.closed).toBe(false)
    expect(f.stop.state()).toEqual({
      key: KEY,
      connected: true,
      role: 'standby',
      project: { key: KEY },
      epoch: 2,
      free: false,
      writer: {
        machine: 'writer-machine',
        root: '/writer',
        epoch: 2,
        online: true,
        secrets: [],
        secretsComplete: true,
      },
    })
    await expect(readFile(join(f.host.home, 'cloud-lease.json'))).rejects.toThrow('ENOENT')
    socket.receive(role('standby', 2, false))
    await f.drain()
    expect(f.stop.state()?.writer?.online).toBe(false)
    // A released lease reaches the state, so the machine can offer to claim it.
    socket.receive({
      ...role('standby', 2, false),
      free: true,
      snapshot: { id: 'snap-1', epoch: 2 },
      writer: {
        machine: null,
        root: '/writer',
        epoch: 2,
        online: false,
        secrets: [],
        secretsComplete: true,
      },
    })
    await f.drain()
    expect(f.stop.state()).toMatchObject({
      role: 'standby',
      free: true,
      snapshot: { id: 'snap-1', epoch: 2 },
      writer: { machine: null },
    })
    expect(socket.closed).toBe(false)
    expect(f.sockets).toHaveLength(1)
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('follows a role change on the open socket, notifying the lease of each role', async () => {
  const roles: string[] = []
  const f = await fixture({ serving: true, role: (state) => roles.push(state.role!) })
  try {
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    socket.receive(role('standby', 2))
    await f.drain()
    expect(socket.closed).toBe(false)
    expect(f.sockets).toHaveLength(1)
    expect(roles).toEqual(['writer', 'standby'])
    expect(f.stop.state()).toMatchObject({ connected: true, role: 'standby', epoch: 2 })
  } finally {
    await f.close()
  }
})

it('hands move and release messages from the cloud to the lease', async () => {
  const calls: unknown[] = []
  const f = await fixture({
    serving: true,
    releaseRequested: (...args) => calls.push(['releaseRequested', ...args]),
    releaseWaiting: (waiting) => calls.push(['releaseWaiting', waiting]),
    moveTo: (...args) => calls.push(['moveTo', ...args]),
    cancel: (id) => calls.push(['cancel', id]),
  })
  try {
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    socket.receive({ type: 'release-requested', by: 'rog', id: 't1' })
    socket.receive({ type: 'release-waiting', by: 'rog', tasks: 2 })
    socket.receive({ type: 'move-to', id: 't2', by: 'sync', force: true })
    socket.receive({ type: 'cancel', id: 't2' })
    expect(calls).toEqual([
      ['releaseRequested', 'rog', 't1', false],
      ['releaseWaiting', { type: 'release-waiting', by: 'rog', tasks: 2 }],
      ['moveTo', 't2', true, 'sync'],
      ['cancel', 't2'],
    ])
  } finally {
    await f.close()
  }
})

it('reconnects at once when a connection that had been open drops, as a deploy restarts the replica', async () => {
  const f = await fixture()
  try {
    f.sockets[0].open()
    await f.drain()
    await vi.advanceTimersByTimeAsync(QUICK_RECONNECT_AFTER)
    // The deploy closes the socket: the first attempt runs without waiting.
    f.sockets[0].dispatchEvent(Object.assign(new Event('close'), { code: 1012 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sockets).toHaveLength(2)
    // The Worker is still restarting: backoff applies from the second failure on.
    f.sockets[1].dispatchEvent(Object.assign(new Event('close'), { code: 1006 }))
    await vi.advanceTimersByTimeAsync(999)
    expect(f.sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets).toHaveLength(3)
    f.sockets[2].dispatchEvent(Object.assign(new Event('close'), { code: 1006 }))
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.sockets).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets).toHaveLength(4)
    // Up again: the backoff resets once a role arrives, and a later drop again reconnects at once.
    f.sockets[3].open()
    await f.drain()
    await vi.advanceTimersByTimeAsync(QUICK_RECONNECT_AFTER)
    f.sockets[3].dispatchEvent(Object.assign(new Event('close'), { code: 1012 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sockets).toHaveLength(5)
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('keeps retrying with backoff when the endpoint refuses the upgrade', async () => {
  const f = await fixture()
  try {
    // A Worker without /sync/v2 answers 404: the socket errors, then closes abnormally.
    for (const [index, wait] of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000].entries()) {
      f.sockets[index].dispatchEvent(new Event('error'))
      f.sockets[index].dispatchEvent(Object.assign(new Event('close'), { code: 1006 }))
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(f.sockets).toHaveLength(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(f.sockets).toHaveLength(index + 2)
    }
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('stays off with one notice for a project without a GitHub origin', async () => {
  const home = await temp('ultimate-cloud-off-')
  vi.stubEnv('ULTIMATE_CLOUD_URL', 'wss://fake/sync')
  vi.stubEnv('ULTIMATE_CLOUD_TOKEN', 'token')
  const onOpen = vi.fn<ExtensionHost['onOpen']>()
  const notice = vi.fn<ExtensionHost['notice']>()
  await cloud({
    onOpen,
    onClose: () => {},
    onRelease: () => {},
    want: () => undefined,
    resource: <T>(_key: string, create: () => T) => create(),
    faux: true,
    notice,
    projectRoot: home,
    userHome: home,
  } as unknown as ExtensionHost)
  await onOpen.mock.calls[0][0]()
  expect(notice.mock.calls).toEqual([[`Cloud sync is off: ${home} has no GitHub origin remote.`]])
})

it('opens and closes a faux host without cloud work when no URL is explicit', async () => {
  vi.useFakeTimers()
  vi.stubEnv('ULTIMATE_CLOUD_URL', '')
  const onOpen = vi.fn<ExtensionHost['onOpen']>()
  const onClose = vi.fn<ExtensionHost['onClose']>()
  const notice = vi.fn<ExtensionHost['notice']>()
  const host = {
    onOpen,
    onClose,
    onRelease: () => {},
    want: () => undefined,
    resource: <T>(_key: string, create: () => T) => create(),
    faux: true,
    notice,
  }
  expect((await cloud(host as unknown as ExtensionHost)).name).toBe('cloud')
  await onOpen.mock.calls[0][0]()
  for (const [close] of onClose.mock.calls) await close()
  expect(notice).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
