import { access, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { acquireLock } from '../server/lock.ts'
import { Metadata } from '../server/metadata.ts'
import type { SystemInfo } from '../shared/protocol.ts'
import { post, prepareFauxServer } from './helpers.ts'
import { fixture, servers } from './server-fixture.ts'

// Records each lifecycle callback, and whether the harness was still open when `onRelease` ran.
const probe = `import { defineExtension } from '@earendil-works/pi-durable'
export default (host) => {
  globalThis.standbyProbe = { host, log: globalThis.standbyProbe?.log ?? [] }
  const { log } = globalThis.standbyProbe
  host.onOpen(async () => { log.push('open') })
  host.onRelease(async () => {
    try {
      host.harness()
      log.push('release with harness')
    } catch {
      log.push('release without harness')
    }
  })
  return defineExtension({ name: 'probe' })
}
export const actions = { ping: async () => 'pong' }`
const probed = () =>
  (globalThis as unknown as { standbyProbe: { host: ExtensionHost; log: string[] } }).standbyProbe

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
/** Move a SQLite database with its `-wal` and `-shm` files, as a park or install does. */
async function moveDatabase(from: string, to: string) {
  for (const suffix of ['', '-wal', '-shm'])
    if (await exists(from + suffix)) await rename(from + suffix, to + suffix)
}
/** The first `system` event of `/api/events`, and the stream's reader. */
async function events(url: string) {
  const response = await fetch(url + '/api/events')
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  let wire = ''
  for (;;) {
    const block = /event: system\ndata: (.+)\n\n/.exec(wire)
    if (block) return { system: JSON.parse(block[1]) as SystemInfo, reader }
    const { value, done } = await reader.read()
    if (done) throw new Error('Stream ended before a system event')
    wire += new TextDecoder().decode(value)
  }
}
async function drained(reader: ReadableStreamDefaultReader<Uint8Array>) {
  while (!(await reader.read()).done);
}

describe('standby', () => {
  it('parks the database, restarts without opening it, and activates another one', async () => {
    delete (globalThis as { standbyProbe?: unknown }).standbyProbe
    const { server, options } = await fixture(false, { probe })
    const before = await post(server, '/api/conversations', { title: 'Here before' })
    expect(before.status).toBe(201)
    const parked = join(options.home, 'state.parked.sqlite')
    const info = { reason: 'Runs on the laptop now' }

    await probed().host.deactivate(info, async (database) => {
      // Nothing holds the database or its storage lock while parking.
      const lock = await acquireLock(join(options.home, 'storage.lock'), { pid: process.pid })
      await lock.close()
      await moveDatabase(database, parked)
    })
    expect(probed().log).toEqual(['open', 'release with harness'])
    expect(probed().host.standby()).toEqual(info)
    expect(JSON.parse(await readFile(join(options.home, 'standby.json'), 'utf8'))).toEqual(info)
    expect(await exists(server.host.database)).toBe(false)
    expect(await exists(parked)).toBe(true)
    // Deactivating again changes nothing.
    await probed().host.deactivate({ reason: 'other' })
    expect(probed().host.standby()).toEqual(info)

    const stream = await events(server.url)
    expect(stream.system.standby).toEqual(info)
    expect(stream.system.persistence).toMatchObject({ sizeBytes: 0, walBytes: 0 })
    await stream.reader.cancel()
    expect(await post(server, '/api/extensions/probe/actions/ping', { args: null })).toEqual({
      status: 200,
      data: { result: 'pong' },
    })
    const refused = { status: 503, data: { error: 'standby', standby: info } }
    expect(
      await post(server, '/api/extensions/probe/actions/ping', { args: null, conversationId: 1 }),
    ).toEqual(refused)
    expect(await post(server, '/api/conversations', {})).toEqual(refused)
    expect(await post(server, '/api/conversations/1/submit', { text: 'hi' })).toEqual(refused)
    const models = await fetch(server.url + '/api/models')
    expect({ status: models.status, data: await models.json() }).toEqual(refused)

    servers.splice(servers.indexOf(server), 1)
    await server.vite.watcher.close()
    await server.close()
    const prepared = await prepareFauxServer(options)
    try {
      const open = vi.spyOn(prepared.host, 'open')
      expect(await prepared.go()).toBeUndefined()
      expect(open).not.toHaveBeenCalled()
      expect(await exists(prepared.host.database)).toBe(false)
      expect(probed().log).toEqual(['open', 'release with harness'])
      const restarted = await events(prepared.url)
      expect(restarted.system.standby).toEqual(info)
      // Activating while open does nothing; this one is on standby, so it installs a database written elsewhere.
      const elsewhere = await prepareHarness({ ...options, home: join(options.userHome, 'other') })
      const other = await elsewhere.open(false)
      const created = await other.harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { cwd: options.projectRoot } },
        context,
      )
      await created.commit(async (tx) => {
        ;(await tx.doc(Metadata, created.id)).title = 'Written elsewhere'
      }, context)
      await other.close()
      await probed().host.activate((database) => moveDatabase(elsewhere.database, database))
      expect(open).toHaveBeenCalledOnce()
      expect(probed().log).toEqual(['open', 'release with harness', 'open'])
      expect(probed().host.standby()).toBeUndefined()
      expect(await exists(join(options.home, 'standby.json'))).toBe(false)
      // The standby stream ends, so its client reconnects to the opened server.
      await drained(restarted.reader)
      const titles = probed()
        .host.conversations()
        .map((conversation) => conversation.title)
      expect(titles).toContain('Written elsewhere')
      expect(titles).not.toContain('Here before')
      expect((await events(prepared.url)).system.standby).toBeUndefined()
      expect((await post(prepared, '/api/conversations', {})).status).toBe(201)
      await probed().host.activate()
      expect(open).toHaveBeenCalledOnce()
    } finally {
      await prepared.vite.watcher.close()
      await prepared.close()
    }
  })

  it('stays on standby when parking fails, and reopens the same database', async () => {
    delete (globalThis as { standbyProbe?: unknown }).standbyProbe
    const { server, options } = await fixture(false, { probe })
    expect((await post(server, '/api/conversations', { title: 'Kept' })).status).toBe(201)
    await expect(
      probed().host.deactivate({ reason: 'moving' }, async () => {
        throw new Error('disk full')
      }),
    ).rejects.toThrow('disk full')
    expect(probed().host.standby()).toEqual({ reason: 'moving' })
    expect(await exists(join(options.home, 'standby.json'))).toBe(true)
    expect(await exists(server.host.database)).toBe(true)
    expect((await post(server, '/api/conversations', {})).status).toBe(503)
    await probed().host.activate()
    expect(
      probed()
        .host.conversations()
        .map((conversation) => conversation.title),
    ).toContain('Kept')
    expect((await post(server, '/api/conversations', {})).status).toBe(201)
  })
})
