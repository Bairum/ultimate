import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireLock, readOwner, retireStorageOwner, alive } from '../server/lock.ts'

const directories: string[] = []
const locks: Awaited<ReturnType<typeof acquireLock>>[] = []
afterEach(async () => {
  for (const lock of locks.splice(0)) await lock.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})
async function path() {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-lock-'))
  directories.push(directory)
  return join(directory, 'storage.lock')
}
it('drops a stale sidecar without signalling an unrelated live process', async () => {
  const file = await path()
  const child = spawn('sleep', ['60'])
  try {
    await writeFile(file, JSON.stringify({ pid: child.pid }))
    await retireStorageOwner(file)
    expect(alive(child.pid!)).toBe(true)
    expect(await readOwner(file)).toBeUndefined()
    locks.push(await acquireLock(file, { pid: process.pid }))
  } finally {
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }
})
it('refuses to signal an unverified owner of a held storage lock', async () => {
  const file = await path()
  locks.push(await acquireLock(file, { pid: process.pid }))
  await expect(retireStorageOwner(file)).rejects.toThrow('refusing to signal')
  expect(alive(process.pid)).toBe(true)
})
it('uses built-in SQLite without spawning an external binary', async () => {
  const source = await readFile(resolve('server/lock.ts'), 'utf8')
  expect(source).toContain('node:sqlite')
  expect(source).not.toContain('flock')
  expect(source).not.toContain('node:child_process')
})
it('holds ownership until close, then lets a waiting contender acquire it', async () => {
  const file = await path()
  const owner = await acquireLock(file, { pid: process.pid })
  await expect(acquireLock(file, { pid: process.pid })).rejects.toThrow(
    `Ultimate core already owns this storage (pid ${process.pid})`,
  )
  const waiting = acquireLock(file, { pid: process.pid }, 1000)
  await owner.close()
  const successor = await waiting
  locks.push(successor)
  expect(successor.stale).toBe(false)
  expect(await readOwner(file)).toEqual({ pid: process.pid })
})
it('replaces a leftover sidecar under exclusive ownership and updates the public port', async () => {
  const file = await path()
  await writeFile(file, JSON.stringify({ pid: 2147483647 }))
  const lock = await acquireLock(file, { pid: process.pid, port: 4747 })
  locks.push(lock)
  expect(lock.stale).toBe(true)
  await lock.update({ pid: process.pid, port: 5000 })
  expect(await readOwner(file)).toEqual({ pid: process.pid, port: 5000 })
})
it('releases the database when an unparsable sidecar prevents acquisition', async () => {
  const file = await path()
  await writeFile(file, 'not JSON')
  await expect(acquireLock(file, { pid: process.pid })).rejects.toThrow(
    'Cannot parse Ultimate lock',
  )
  await rm(file)
  locks.push(await acquireLock(file, { pid: process.pid }))
})
