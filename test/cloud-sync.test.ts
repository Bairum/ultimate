import { defineDoc } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, expect, it, vi } from 'vitest'
import cloud, { MAX_RETAINED_BYTES, startSync } from '../extensions/cloud/server.ts'
import type { SyncSocket } from '../extensions/cloud/server.ts'
import { docHash, PROJECT_MISMATCH } from '../cloud/protocol.ts'
import type { CloudMessage, MachineMessage } from '../cloud/protocol.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

const Note = defineDoc<{ text: string }>({
  kind: 'cloud-test.note',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ text: 'initial' }),
})
const Session = defineDoc<{ secret: string }>({
  kind: 'cloud-test.session',
  version: 1,
  scope: 'session',
  initial: () => ({ secret: 'local' }),
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

class FakeCloud extends EventTarget implements SyncSocket {
  messages: MachineMessage[] = []
  closed = false
  autoAck = true
  private batchWaiters: { count: number; resolve: () => void }[] = []
  waitForBatches(count: number) {
    if (this.batches().length >= count) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.batchWaiters.push({ count, resolve })
    })
  }
  send(data: string) {
    const message = JSON.parse(data) as MachineMessage
    this.messages.push(message)
    for (const waiter of this.batchWaiters)
      if (this.batches().length >= waiter.count) waiter.resolve()
    this.batchWaiters = this.batchWaiters.filter((waiter) => this.batches().length < waiter.count)
    if (message.type === 'batch' && this.autoAck)
      queueMicrotask(() => this.receive({ type: 'ack', batch: message.batch }))
  }
  close() {
    this.closed = true
  }
  receive(message: CloudMessage) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }
  open(
    cursor: Extract<CloudMessage, { type: 'cursor' }> = { type: 'cursor', entries: {}, docs: {} },
  ) {
    this.dispatchEvent(new Event('open'))
    this.receive(cursor)
  }
  batches() {
    return this.messages.filter((message) => message.type === 'batch')
  }
  entries() {
    return this.batches().flatMap((message) => message.entries)
  }
  docs() {
    return this.batches().flatMap((message) => message.docs)
  }
  cursor(): Extract<CloudMessage, { type: 'cursor' }> {
    const entries: Record<string, number> = {}
    for (const entry of this.entries())
      entries[entry.conversationId] = Math.max(entries[entry.conversationId] ?? 0, entry.id)
    const docs: Record<string, string> = {}
    for (const doc of this.docs()) {
      if (doc.value === null) delete docs[doc.id]
      else docs[doc.id] = doc.hash
    }
    return { type: 'cursor', entries, docs }
  }
}

async function fixture() {
  const home = await temp('ultimate-cloud-')
  const prepared = await prepareHarness({ ultimateRoot: home, userHome: home, home, faux: true })
  prepared.faux!.setResponses([fauxAssistantMessage('cloud answer')])
  const opened = await prepared.open()
  const notices: string[] = []
  const host = {
    ...prepared,
    projectRoot: home,
    harness: () => opened.harness,
    conversations: () => [],
    system: () => ({ online: true, process: { url: 'http://127.0.0.1:4800' } }),
    build: () => ({ id: 'test-build' }),
    notice: (message: string) => notices.push(message),
  } as unknown as ExtensionHost
  const sockets: FakeCloud[] = []
  vi.useFakeTimers()
  const stop = startSync(host, 'ws://fake/sync', 'token', 'test-machine', () => {
    const socket = new FakeCloud()
    sockets.push(socket)
    return socket
  })
  return {
    prepared,
    opened,
    host,
    notices,
    sockets,
    stop,
    async drain() {
      await stop.idle()
      await vi.advanceTimersByTimeAsync(250)
      await stop.idle()
    },
    async close() {
      stop()
      vi.useRealTimers()
      await opened.close()
    },
  }
}

it('ignores volatile system changes, refreshes them after a minute, and sends meaningful changes', async () => {
  const f = await fixture()
  try {
    const system = {
      build: { id: 'first' },
      process: { url: 'http://127.0.0.1:4800' },
      machine: { hostname: 'test', freeMemory: 100 },
      persistence: { path: '/test/state.sqlite', sizeBytes: 100, walBytes: 10 },
      extensions: [{ name: 'cloud' }],
    }
    f.host.system = () => system as unknown as ReturnType<ExtensionHost['system']>
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    const sent = () => socket.messages.filter((message) => message.type === 'system')
    system.machine.freeMemory--
    system.persistence.sizeBytes++
    system.persistence.walBytes++
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(sent()).toHaveLength(2)
    expect(sent()[1].value).toEqual(system)
    system.build.id = 'second'
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent()).toHaveLength(3)
    system.extensions.push({ name: 'info' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent()).toHaveLength(4)
    expect(sent()[3].value).toEqual(system)
  } finally {
    await f.close()
  }
})

it('notices a batch older than 60 seconds once and reconnects from the replica cursor', async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]
    socket.autoAck = false
    socket.open()
    await f.drain()
    expect(socket.batches().length).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(59_750)
    expect(f.notices).toEqual([])
    expect(socket.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.notices).toEqual(['Cloud sync stalled: no acknowledgement for 60 s; reconnecting'])
    expect(socket.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sockets).toHaveLength(2)
    f.sockets[1].open()
    await f.drain()
    expect(f.sockets[1].batches().flatMap((batch) => batch.conversations)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.notices).toHaveLength(1)
    expect(f.sockets).toHaveLength(2)
  } finally {
    await f.close()
  }
})

it('does not notice or reconnect when a batch is acknowledged within 60 seconds', async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]
    socket.autoAck = false
    socket.open()
    await f.drain()
    await vi.advanceTimersByTimeAsync(59_000)
    for (const batch of socket.batches()) socket.receive({ type: 'ack', batch: batch.batch })
    await f.drain()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.notices).toEqual([])
    expect(socket.closed).toBe(false)
    expect(f.sockets).toHaveLength(1)
  } finally {
    await f.close()
  }
})

it('sends every conversation, only its own entries in ID order, and conversation docs from an empty cursor', async () => {
  const f = await fixture()
  try {
    const { root, harness } = f.opened
    const first = await harness.commit(async (tx) => {
      await tx.doc(Note, root.id)
      await tx.doc(Session)
      return tx.appendEntry(root.id, { kind: 'cloud-test.entry', data: { text: 'parent' } })
    }, context)
    const fork = await harness.commit(async (tx) => {
      const child = await tx.forkConversation(root.id, first.id, {
        ownership: { kind: 'ownerless' },
      })
      const second = await tx.appendEntry(child.id, {
        kind: 'cloud-test.entry',
        data: { text: 'child' },
      })
      return { child, second }
    }, context)
    f.sockets[0].open()
    await f.drain()
    const socket = f.sockets[0]
    expect(socket.messages[0]).toEqual({
      type: 'hello',
      machine: 'test-machine',
      port: 4800,
      build: 'test-build',
      project: f.host.projectRoot,
    })
    expect(
      socket
        .batches()
        .flatMap((batch) => batch.conversations)
        .map((record) => record.id),
    ).toEqual([root.id, fork.child.id])
    expect(socket.entries().filter((entry) => entry.id === first.id)).toHaveLength(1)
    expect(socket.entries().map((entry) => entry.id)).toContain(fork.second.id)
    for (const id of [root.id, fork.child.id]) {
      const ids = socket
        .entries()
        .filter((entry) => entry.conversationId === id)
        .map((entry) => entry.id)
      expect(ids).toEqual(ids.toSorted((a, b) => a - b))
    }
    const notes = socket.docs().filter((doc) => doc.kind === Note.definition.kind)
    expect(notes.map((doc) => doc.conversationId)).toEqual([root.id, fork.child.id])
    expect(notes.every((doc) => doc.value?.text === 'initial')).toBe(true)
    expect(socket.docs().some((doc) => doc.kind === Session.definition.kind)).toBe(false)
    expect(socket.messages.some((message) => message.type === 'system')).toBe(true)
    const models = socket.messages.find((message) => message.type === 'models')
    expect(models).toMatchObject({
      type: 'models',
      value: {
        providers: expect.arrayContaining([expect.objectContaining({ id: 'faux' })]),
        models: expect.arrayContaining([
          expect.objectContaining({ provider: 'faux', id: 'faux-1', available: true }),
        ]),
      },
    })
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('reconnects with no entries or unchanged docs and retires a missing cursor document', async () => {
  const f = await fixture()
  try {
    await f.opened.harness.commit(async (tx) => {
      await tx.doc(Note, f.opened.root.id)
    }, context)
    f.sockets[0].open()
    await f.drain()
    const socket = f.sockets[0]
    const cursor = socket.cursor()
    socket.dispatchEvent(new CloseEvent('close'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sockets).toHaveLength(2)
    f.sockets[1].open(cursor)
    await f.drain()
    expect(f.sockets[1].entries()).toEqual([])
    expect(f.sockets[1].docs()).toEqual([])
    expect(f.sockets[1].batches().flatMap((batch) => batch.conversations)).toHaveLength(1)
    f.sockets[1].dispatchEvent(new CloseEvent('close'))
    await f.opened.harness.commit((tx) => tx.retireDoc(Note, f.opened.root.id), context)
    await vi.advanceTimersByTimeAsync(1000)
    f.sockets[2].open(cursor)
    await f.drain()
    const retired = f.sockets[2].docs().filter((doc) => doc.value === null)
    expect(retired.map((doc) => doc.id)).toEqual(
      socket
        .docs()
        .filter((doc) => doc.kind === Note.definition.kind)
        .map((doc) => doc.id),
    )
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('resends a document changed while disconnected', async () => {
  const f = await fixture()
  try {
    await f.opened.harness.commit(async (tx) => {
      await tx.doc(Note, f.opened.root.id)
    }, context)
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    const cursor = socket.cursor()
    socket.dispatchEvent(new CloseEvent('close'))
    await f.opened.harness.commit(async (tx) => {
      ;(await tx.doc(Note, f.opened.root.id)).text = 'offline change'
    }, context)
    await vi.advanceTimersByTimeAsync(1000)
    f.sockets[1].open(cursor)
    await f.drain()
    expect(f.sockets[1].entries()).toEqual([])
    expect(f.sockets[1].docs()).toEqual([
      expect.objectContaining({
        kind: Note.definition.kind,
        value: { text: 'offline change' },
        hash: await docHash({ text: 'offline change' }),
      }),
    ])
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('batches live entries and coalesces changed docs, then sends their retirement', async () => {
  const f = await fixture()
  try {
    f.sockets[0].open()
    await f.drain()
    f.sockets[0].messages = []
    const entry = await f.opened.harness.commit(async (tx) => {
      ;(await tx.doc(Note, f.opened.root.id)).text = 'one'
      return tx.appendEntry(f.opened.root.id, { kind: 'cloud-test.live', data: { live: true } })
    }, context)
    await f.opened.harness.commit(async (tx) => {
      ;(await tx.doc(Note, f.opened.root.id)).text = 'two'
    }, context)
    await f.drain()
    expect(f.sockets[0].entries()).toEqual([entry])
    const docs = f.sockets[0].docs().filter((doc) => doc.kind === Note.definition.kind)
    expect(docs).toHaveLength(1)
    expect(docs[0].value).toEqual({ text: 'two' })
    expect(docs[0].hash).toBe(await docHash({ text: 'two' }))
    await f.opened.harness.commit((tx) => tx.retireDoc(Note, f.opened.root.id), context)
    await f.drain()
    expect(f.sockets[0].docs().at(-1)).toMatchObject({ id: docs[0].id, value: null })
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('buffers commits during catch-up and materializes live fork document copies', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    await f.opened.harness.commit(async (tx) => {
      await tx.doc(Note, f.opened.root.id)
    }, context)
    const read = f.host.document
    let held = false
    f.host.document = async (...args) => {
      if (!held) {
        held = true
        entered.resolve()
        await release.promise
      }
      return read(...args)
    }
    f.sockets[0].open()
    await entered.promise
    const entry = await f.opened.harness.commit(
      (tx) => tx.appendEntry(f.opened.root.id, { kind: 'cloud-test.buffered', data: {} }),
      context,
    )
    release.resolve()
    await f.drain()
    expect(f.sockets[0].entries().filter((item) => item.id === entry.id)).toEqual([entry])
    f.sockets[0].messages = []
    const child = await f.opened.harness.commit(
      (tx) => tx.forkConversation(f.opened.root.id, entry.id, { ownership: { kind: 'ownerless' } }),
      context,
    )
    await f.drain()
    expect(f.sockets[0].docs().filter((doc) => doc.kind === Note.definition.kind)).toEqual([
      expect.objectContaining({ conversationId: child.id, value: { text: 'initial' } }),
    ])
    expect(f.notices).toEqual([])
  } finally {
    release.resolve()
    await f.close()
  }
})

it('admits duplicate outbox items once and acknowledges the same submission twice', async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    const item = {
      id: 'outbox-uuid',
      conversationId: f.opened.root.id,
      text: 'queued in cloud',
      createdAt: 1,
    }
    socket.receive({ type: 'outbox', items: [item, item] })
    await f.drain()
    const delivered = socket.messages.filter((message) => message.type === 'delivered')
    expect(delivered).toHaveLength(2)
    expect(delivered[0]).toEqual(delivered[1])
    const entries = await f.opened.harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: f.opened.root.id }, 256)).items,
      context,
    )
    expect(entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
    socket.receive({ type: 'outbox', items: [{ ...item, id: 'missing', conversationId: 99999 }] })
    await f.drain()
    expect(socket.messages.filter((message) => message.type === 'delivered')).toHaveLength(2)
    expect(f.notices).toEqual(['Cloud outbox: unknown conversation 99999'])
  } finally {
    await f.close()
  }
})

it('limits outstanding batches to four and resumes on acknowledgements', async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    const firstBatch = socket.batches().at(-1)!.batch + 1
    socket.messages = []
    socket.autoAck = false
    for (let n = 0; n < 6; n++) {
      await f.opened.harness.commit(
        (tx) => tx.appendEntry(f.opened.root.id, { kind: 'cloud-test.live', data: { n } }),
        context,
      )
      await f.drain()
    }
    expect(socket.batches()).toHaveLength(4)
    socket.receive({ type: 'ack', batch: firstBatch })
    expect(socket.batches()).toHaveLength(5)
    expect(socket.batches().map((batch) => batch.batch)).toEqual(
      Array.from({ length: 5 }, (_, index) => firstBatch + index),
    )
    expect(socket.entries().filter((entry) => entry.kind === 'cloud-test.live')).toHaveLength(6)
    f.stop()
    expect(socket.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.sockets).toHaveLength(1)
  } finally {
    await f.close()
  }
})

async function seedBacklog(f: Awaited<ReturnType<typeof fixture>>) {
  return f.opened.harness.commit(async (tx) => {
    const other = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const expected: Record<string, number[]> = { [f.opened.root.id]: [], [other.id]: [] }
    for (let index = 0; index < 1500; index++) {
      for (const id of [f.opened.root.id, other.id]) {
        const entry = await tx.appendEntry(id, { kind: 'cloud-test.backlog', data: { index } })
        expected[id].push(entry.id)
      }
    }
    return expected
  }, context)
}

it('streams catch-up within four unacked batches and reads no next page until capacity returns', async () => {
  const f = await fixture()
  try {
    const expected = await seedBacklog(f)
    let pagesRead = 0
    const lookup = f.opened.harness.conversation.bind(f.opened.harness)
    vi.spyOn(f.opened.harness, 'conversation').mockImplementation(async (...args) => {
      const conversation = await lookup(...args)
      if (conversation) {
        const read = conversation.entries.bind(conversation)
        vi.spyOn(conversation, 'entries').mockImplementation(async (...query) => {
          pagesRead++
          return read(...query)
        })
      }
      return conversation
    })
    const socket = f.sockets[0]
    socket.autoAck = false
    socket.open()
    await socket.waitForBatches(4)
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.batches()).toHaveLength(4)
    // One conversation-record batch and three 256-entry pages fill the window.
    expect(pagesRead).toBe(3)
    expect(socket.entries().length).toBeLessThan(3000)
    socket.autoAck = true
    for (const batch of socket.batches()) socket.receive({ type: 'ack', batch: batch.batch })
    await f.drain()
    for (const [id, ids] of Object.entries(expected)) {
      const received = socket.entries().filter((entry) => String(entry.conversationId) === id)
      expect(received.map((entry) => entry.id)).toEqual(
        received.map((entry) => entry.id).toSorted((a, b) => a - b),
      )
      expect(
        received.filter((entry) => entry.kind === 'cloud-test.backlog').map((entry) => entry.id),
      ).toEqual(ids)
    }
    expect(f.notices).toEqual([])
  } finally {
    vi.restoreAllMocks()
    await f.close()
  }
})

it('leaves the commit line free while catch-up is stalled on withheld acknowledgements', async () => {
  const f = await fixture()
  try {
    await seedBacklog(f)
    const socket = f.sockets[0]
    socket.autoAck = false
    socket.open()
    await socket.waitForBatches(4)
    let committed = false
    const write = f.opened.harness
      .commit(
        (tx) => tx.appendEntry(f.opened.root.id, { kind: 'cloud-test.unblocked', data: {} }),
        context,
      )
      .then(() => {
        committed = true
      })
    await vi.advanceTimersByTimeAsync(0)
    expect(committed).toBe(true)
    await write
    expect(socket.batches()).toHaveLength(4)
    f.stop()
    await f.stop.idle()
    expect(socket.closed).toBe(true)
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('resumes each conversation exactly after its own partial cursor', async () => {
  const f = await fixture()
  try {
    const expected = await seedBacklog(f)
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    const cursor = socket.cursor()
    const ids = Object.keys(expected)
    cursor.entries[ids[0]] = expected[ids[0]][749]
    cursor.entries[ids[1]] = expected[ids[1]][999]
    socket.dispatchEvent(new CloseEvent('close'))
    await vi.advanceTimersByTimeAsync(1000)
    f.sockets[1].open(cursor)
    await f.drain()
    const resumed = f.sockets[1].entries()
    expect(
      resumed.filter((entry) => String(entry.conversationId) === ids[0]).map((entry) => entry.id),
    ).toEqual(expected[ids[0]].slice(750))
    expect(
      resumed.filter((entry) => String(entry.conversationId) === ids[1]).map((entry) => entry.id),
    ).toEqual(expected[ids[1]].slice(1000))
    expect(f.sockets[1].docs()).toEqual([])
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('streams an entry page larger than the retained-data cap without reconnecting', async () => {
  const f = await fixture()
  try {
    const payload = 'x'.repeat(100 * 1024)
    const expected = await f.opened.harness.commit(async (tx) => {
      const ids = []
      for (let index = 0; index < 256; index++) {
        const entry = await tx.appendEntry(f.opened.root.id, {
          kind: 'cloud-test.large-page',
          data: { index, payload },
        })
        ids.push(entry.id)
      }
      return ids
    }, context)
    const page = await f.opened.root.entries({ order: 'ascending' }, 256, undefined, context)
    expect(Buffer.byteLength(JSON.stringify(page.items))).toBeGreaterThan(MAX_RETAINED_BYTES)
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    expect(socket.closed).toBe(false)
    expect(f.sockets).toHaveLength(1)
    expect(
      socket
        .entries()
        .filter((entry) => entry.kind === 'cloud-test.large-page')
        .map((entry) => entry.id),
    ).toEqual(expected)
    const ids = socket.entries().map((entry) => entry.id)
    expect(ids).toEqual(ids.toSorted((a, b) => a - b))
    expect(f.stop.retainedBytes()).toBe(0)
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})

it('reconnects on retained-data overflow and converges from the replica cursor', async () => {
  const f = await fixture()
  try {
    const other = await f.opened.harness.commit(async (tx) => {
      await tx.doc(Note, f.opened.root.id)
      return tx.createConversation({ ownership: { kind: 'ownerless' } })
    }, context)
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    socket.autoAck = false
    const expected: Record<string, number[]> = { [f.opened.root.id]: [], [other.id]: [] }
    const payload = 'x'.repeat(256 * 1024)
    for (let index = 0; index < 96; index++) {
      const id = index % 2 === 0 ? f.opened.root.id : other.id
      const entry = await f.opened.harness.commit(async (tx) => {
        ;(await tx.doc(Note, f.opened.root.id)).text = `latest ${index}`
        return tx.appendEntry(id, { kind: 'cloud-test.overflow', data: { payload, index } })
      }, context)
      expected[id].push(entry.id)
      expect(f.stop.retainedBytes()).toBeLessThanOrEqual(MAX_RETAINED_BYTES)
      await f.stop.idle()
      expect(f.stop.retainedBytes()).toBeLessThanOrEqual(MAX_RETAINED_BYTES)
    }
    expect(f.stop.retainedBytes()).toBe(0)
    expect(socket.closed).toBe(true)
    expect(f.notices).toEqual([
      'Cloud sync retained-data limit exceeded; reconnecting from the replica cursor',
    ])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sockets).toHaveLength(2)
    f.sockets[1].open(socket.cursor())
    await f.drain()
    const entries = [...socket.entries(), ...f.sockets[1].entries()].filter(
      (entry) => entry.kind === 'cloud-test.overflow',
    )
    for (const [id, ids] of Object.entries(expected)) {
      expect(
        entries.filter((entry) => String(entry.conversationId) === id).map((entry) => entry.id),
      ).toEqual(ids)
    }
    expect(
      [...socket.docs(), ...f.sockets[1].docs()]
        .filter((doc) => doc.kind === Note.definition.kind)
        .at(-1)?.value,
    ).toEqual({ text: 'latest 95' })
  } finally {
    await f.close()
  }
})

it('buffers only changed document IDs during catch-up and sends one current value', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    await f.opened.harness.commit(async (tx) => {
      await tx.doc(Note, f.opened.root.id)
    }, context)
    const read = f.host.document
    let held = false
    f.host.document = async (...args) => {
      if (!held) {
        held = true
        entered.resolve()
        await release.promise
      }
      return read(...args)
    }
    const socket = f.sockets[0]
    socket.open()
    await entered.promise
    const payload = 'x'.repeat(1_100_000)
    for (let index = 0; index < 16; index++) {
      await f.opened.harness.commit(async (tx) => {
        ;(await tx.doc(Note, f.opened.root.id)).text = `${index}:${payload}`
      }, context)
      expect(f.stop.retainedBytes()).toBeLessThan(1024)
    }
    expect(socket.closed).toBe(false)
    release.resolve()
    await f.drain()
    expect(
      socket
        .docs()
        .filter((doc) => doc.kind === Note.definition.kind)
        .map((doc) => doc.value),
    ).toEqual([{ text: `15:${payload}` }])
    expect(f.notices).toEqual([])
  } finally {
    release.resolve()
    await f.close()
  }
})

it('keeps the last non-empty summaries when the host conversation list empties during shutdown', async () => {
  const f = await fixture()
  try {
    const summaries = [{ id: f.opened.root.id, title: 'Root conversation', busy: false }]
    const conversations = vi.spyOn(f.host, 'conversations').mockReturnValue(summaries)
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    conversations.mockReturnValue([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(conversations).toHaveLastReturnedWith([])
    expect(socket.messages.filter((message) => message.type === 'summaries')).toEqual([
      { type: 'summaries', value: summaries, removed: [], full: true },
    ])
  } finally {
    await f.close()
  }
})

it('sends a full summary list once per connection and only changed/removed summaries thereafter', async () => {
  const f = await fixture()
  try {
    const first = { id: 1, title: 'one', busy: false },
      second = { id: 2, title: 'two', busy: false }
    const conversations = vi.spyOn(f.host, 'conversations').mockReturnValue([first, second])
    const socket = f.sockets[0]
    socket.open()
    await f.drain()
    conversations.mockReturnValue([{ ...second, busy: true }])
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.messages.filter((message) => message.type === 'summaries')).toEqual([
      { type: 'summaries', value: [first, second], removed: [], full: true },
      { type: 'summaries', value: [{ ...second, busy: true }], removed: [1], full: false },
    ])
    socket.dispatchEvent(new Event('close'))
    await vi.advanceTimersByTimeAsync(1000)
    f.sockets[1].open()
    await f.drain()
    expect(f.sockets[1].messages.filter((message) => message.type === 'summaries')).toEqual([
      { type: 'summaries', value: [{ ...second, busy: true }], removed: [], full: true },
    ])
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
      reason: '/other-project',
    })
    socket.dispatchEvent(event)
    socket.dispatchEvent(event)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.sockets).toHaveLength(1)
    expect(f.notices).toEqual([
      'Cloud sync stopped: the replica at ws://fake/sync belongs to another project (/other-project).',
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

it('opens and closes a faux host without cloud work when no URL is explicit', async () => {
  vi.useFakeTimers()
  vi.stubEnv('ULTIMATE_CLOUD_URL', '')
  const onOpen = vi.fn<ExtensionHost['onOpen']>()
  const onClose = vi.fn<ExtensionHost['onClose']>()
  const notice = vi.fn<ExtensionHost['notice']>()
  expect(cloud({ onOpen, onClose, faux: true, notice } as unknown as ExtensionHost).name).toBe(
    'cloud',
  )
  await onOpen.mock.calls[0][0]()
  await onClose.mock.calls[0][0]()
  expect(notice).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
