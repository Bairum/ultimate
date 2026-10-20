import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { R2Bucket } from '@cloudflare/workers-types'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import worker from '../cloud/worker.ts'
import { MAX_SNAPSHOT_OBJECT } from '../cloud/snapshots.ts'
import { databaseHash, downloadSnapshot, uploadSnapshot } from '../extensions/cloud/snapshot.ts'
import type { SnapshotManifest } from '../extensions/cloud/snapshot.ts'
import { git } from '../lib/git.ts'
import { temp } from './helpers.ts'

type Env = Parameters<typeof worker.fetch>[1]
const key = 'github.com/o/project'
const project = (value: string) => createHash('sha256').update(value).digest('hex')

/** An in-memory R2 bucket listing two keys per page; `at` sets the upload time of the next puts. */
function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>()
  const r2 = {
    objects,
    at: undefined as number | undefined,
    async put(name: string, value: Uint8Array) {
      objects.set(name, {
        bytes: new Uint8Array(value),
        uploaded: new Date(r2.at ?? Date.now()),
      })
      if (r2.at !== undefined) r2.at++
    },
    async get(name: string) {
      const object = objects.get(name)
      return object ? { body: object.bytes } : null
    },
    async delete(names: string | string[]) {
      for (const name of [names].flat()) objects.delete(name)
    },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const names = [...objects.keys()].filter((name) => name.startsWith(prefix)).toSorted()
      const start = cursor ? Number(cursor) : 0
      return {
        objects: names
          .slice(start, start + 2)
          .map((name) => ({ key: name, uploaded: objects.get(name)!.uploaded })),
        truncated: start + 2 < names.length,
        cursor: String(start + 2),
      }
    },
  }
  return r2
}
const bucket = memoryBucket()
const env = { SYNC_TOKEN: 'dev', BUILDS: bucket as unknown as R2Bucket } as Env
const remote = { url: 'ws://127.0.0.1:8787', token: 'dev', secret: 'snapshot secret', key }

const commit = async (repo: string, branch: string, message: string) => {
  const parent = await git(repo, 'rev-parse', branch)
  const oid = await git(
    repo,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit-tree',
    `${parent}^{tree}`,
    '-p',
    parent,
    '-m',
    message,
  )
  await git(repo, 'update-ref', `refs/heads/${branch}`, oid)
  return oid
}
const tip = (repo: string, ref: string) => git(repo, 'rev-parse', ref)
const count = (path: string, table: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  } finally {
    db.close()
  }
}

let source: string, target: string, worktree: string, dir: string, database: string
let writer: DatabaseSync
let manifest: SnapshotManifest
let progress: [number, number, number][]
const before: Record<string, string> = {}

beforeAll(async () => {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
    worker.fetch(new Request(input, init), env),
  )
  source = await temp('ultimate-snapshot-source-')
  target = join(await temp('ultimate-snapshot-target-'), 'checkout')
  worktree = join(await temp('ultimate-snapshot-worktree-'), 'checkout')
  dir = await temp('ultimate-snapshot-download-')
  await git(source, 'init', '-b', 'main')
  await git(
    source,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'root',
  )
  for (const name of ['ff', 'diverged', 'behind', 'checked'])
    await git(source, 'branch', `ultimate/${name}`)
  await git(source, 'clone', '--quiet', source, target)
  await git(target, 'fetch', '--quiet', 'origin', 'refs/heads/ultimate/*:refs/heads/ultimate/*')
  // The source moves on; the target writes its own history on two branches and checks one out.
  await git(source, 'branch', 'ultimate/new')
  await commit(source, 'ultimate/new', 'new')
  for (const name of ['ff', 'diverged', 'checked']) await commit(source, `ultimate/${name}`, name)
  await commit(target, 'ultimate/diverged', 'local')
  await commit(target, 'ultimate/behind', 'ahead')
  await commit(target, 'main', 'local main')
  await git(target, 'worktree', 'add', '--quiet', worktree, 'ultimate/checked')
  for (const ref of ['main', 'ultimate/diverged', 'ultimate/behind', 'ultimate/checked'])
    before[ref] = await tip(target, ref)

  // An open writer with uncheckpointed WAL frames: the copy must still be consistent and complete. The random
  // blob compresses to more than one 16 MiB chunk.
  database = join(await temp('ultimate-snapshot-home-'), 'state.sqlite')
  writer = new DatabaseSync(database)
  writer.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE blobs (data BLOB);`)
  const note = writer.prepare('INSERT INTO notes (body) VALUES (?)')
  for (let i = 0; i < 500; i++) note.run(`note ${i}`)
  writer.prepare('INSERT INTO blobs VALUES (?)').run(randomBytes(17 * 1024 * 1024))
  progress = []
  manifest = await uploadSnapshot({
    ...remote,
    epoch: 4,
    machine: 'desk',
    database,
    repo: source,
    progress: (done, total, uploaded) => progress.push([done, total, uploaded]),
  })
})
afterAll(() => {
  writer?.close()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
})

it('round-trips the database and fetches branches without force, keeping conflicting ones aside', async () => {
  expect(manifest).toMatchObject({ key, epoch: 4, machine: 'desk', database: { chunks: 2 } })
  expect(manifest.bundle?.chunks).toBe(1)
  expect(await databaseHash(database)).toBe(manifest.database.sha256)
  expect(progress.at(-1)).toEqual([
    manifest.database.bytes + manifest.bundle!.bytes,
    manifest.database.bytes + manifest.bundle!.bytes,
    manifest.database.uploaded! + manifest.bundle!.uploaded!,
  ])
  // `uploaded` is exactly what went to R2: every encrypted chunk of the part.
  const stored = (kind: string) =>
    [...bucket.objects]
      .filter(([name]) => name.includes(`/${manifest.id}/${kind}-`))
      .reduce((sum, [, object]) => sum + object.bytes.length, 0)
  expect(manifest.database.uploaded).toBe(stored('db'))
  expect(manifest.bundle!.uploaded).toBe(stored('bundle'))
  // The temporary copies leave nothing next to the database.
  expect(await readdir(join(database, '..'))).toEqual(
    expect.not.arrayContaining([expect.stringMatching(/^\.snapshot-/)]),
  )

  const result = await downloadSnapshot({ ...remote, id: manifest.id, dir, repo: target })
  expect(result.manifest).toEqual(manifest)
  expect(result.database).toBe(join(dir, `snapshot-${manifest.id}.sqlite`))
  expect(count(result.database, 'notes')).toBe(500)
  expect(count(result.database, 'blobs')).toBe(1)
  const db = new DatabaseSync(result.database, { readOnly: true })
  expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  db.close()
  expect(await readdir(dir)).toEqual([`snapshot-${manifest.id}.sqlite`])

  const moved = (name: string) => `refs/heads/ultimate-moved/${manifest.id}/${name}`
  expect(result.keptRefs.toSorted()).toEqual([moved('checked'), moved('diverged')])
  for (const name of ['new', 'ff'])
    expect(await tip(target, `ultimate/${name}`)).toBe(await tip(source, `ultimate/${name}`))
  for (const ref of ['main', 'ultimate/diverged', 'ultimate/behind', 'ultimate/checked'])
    expect(await tip(target, ref)).toBe(before[ref])
  for (const name of ['checked', 'diverged'])
    expect(await tip(target, moved(name))).toBe(await tip(source, `ultimate/${name}`))
  expect(await git(target, 'for-each-ref', '--format=%(refname)', 'refs/heads/main')).toBe(
    'refs/heads/main',
  )

  // A repeated download finds its kept refs in place.
  const again = await downloadSnapshot({ ...remote, id: manifest.id, dir, repo: target })
  expect(again.keptRefs.toSorted()).toEqual(result.keptRefs.toSorted())
  expect(await databaseHash(database)).toBe(manifest.database.sha256)
  writer.prepare('INSERT INTO notes (body) VALUES (?)').run('changed')
  expect(await databaseHash(database)).not.toBe(manifest.database.sha256)
})

it('stores only ciphertext in R2', () => {
  const names = [...bucket.objects.keys()]
  const prefix = `snapshots/${project(key)}/${manifest.id}/`
  expect(names.toSorted()).toEqual(
    ['bundle-0', 'db-0', 'db-1', 'manifest'].map((name) => prefix + name),
  )
  for (const { bytes } of bucket.objects.values()) {
    const text = Buffer.from(bytes)
    for (const plain of ['SQLite format 3', 'git bundle', key, manifest.id, 'desk'])
      expect(text.includes(plain)).toBe(false)
    expect(() => JSON.parse(text.toString())).toThrow(SyntaxError)
  }
})

it.each<[string, (objects: typeof bucket.objects, prefix: string) => void, RegExp]>([
  [
    'a tampered chunk',
    (objects, prefix) => {
      objects.get(`${prefix}db-1`)!.bytes[100] ^= 1
    },
    /failed verification \(db 1\)/,
  ],
  [
    'reordered chunks',
    (objects, prefix) => {
      const first = objects.get(`${prefix}db-0`)!
      objects.set(`${prefix}db-0`, objects.get(`${prefix}db-1`)!)
      objects.set(`${prefix}db-1`, first)
    },
    /failed verification \(db 0\)/,
  ],
  [
    'a missing last chunk',
    (objects, prefix) => {
      objects.delete(`${prefix}db-1`)
    },
    /db-1 returned 404/,
  ],
  [
    'a cut-off chunk',
    (objects, prefix) => {
      const chunk = objects.get(`${prefix}db-1`)!
      chunk.bytes = chunk.bytes.subarray(0, 1000)
    },
    /failed verification \(db 1\)/,
  ],
  [
    'a manifest from another snapshot',
    (objects, prefix) => {
      objects.set(`${prefix}manifest`, objects.get(`${prefix}db-0`)!)
    },
    /failed verification \(manifest 0\)/,
  ],
])('rejects %s and leaves nothing behind', async (_, alter, error) => {
  const saved = new Map(
    [...bucket.objects].map(([name, object]) => [name, { ...object, bytes: object.bytes.slice() }]),
  )
  alter(bucket.objects, `snapshots/${project(key)}/${manifest.id}/`)
  const empty = await temp('ultimate-snapshot-rejected-')
  const refs = await git(target, 'for-each-ref')
  try {
    await expect(
      downloadSnapshot({ ...remote, id: manifest.id, dir: empty, repo: target }),
    ).rejects.toThrow(error)
    expect(await readdir(empty)).toEqual([])
    expect(await git(target, 'for-each-ref')).toBe(refs)
  } finally {
    bucket.objects.clear()
    for (const [name, object] of saved) bucket.objects.set(name, object)
  }
})

it('rejects the wrong secret and the wrong project key', async () => {
  const empty = await temp('ultimate-snapshot-rejected-')
  await expect(
    downloadSnapshot({ ...remote, secret: 'other', id: manifest.id, dir: empty, repo: target }),
  ).rejects.toThrow(/failed verification \(manifest 0\)/)
  // The same objects under another project's prefix: the key derivation, not the path, refuses them.
  const other = 'github.com/o/other'
  for (const [name, object] of new Map(bucket.objects))
    bucket.objects.set(name.replace(project(key), project(other)), object)
  await expect(
    downloadSnapshot({ ...remote, key: other, id: manifest.id, dir: empty, repo: target }),
  ).rejects.toThrow(/failed verification \(manifest 0\)/)
  expect(await readdir(empty)).toEqual([])
})

it('skips the bundle when the repository has no ultimate branches', async () => {
  const repo = await temp('ultimate-snapshot-plain-')
  await git(repo, 'init', '-b', 'main')
  const path = join(await temp('ultimate-snapshot-small-'), 'state.sqlite')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1), (2), (3)')
  db.close()
  const small = await uploadSnapshot({
    ...remote,
    epoch: 1,
    machine: 'laptop',
    database: path,
    repo,
  })
  expect(small.bundle).toBeUndefined()
  expect(small.database.chunks).toBe(1)
  const result = await downloadSnapshot({ ...remote, id: small.id, dir, repo })
  expect(result.keptRefs).toEqual([])
  expect(count(result.database, 't')).toBe(3)
})

it('never carries provider logins or secrets that sit next to the database', async () => {
  // Logins rotate their refresh tokens: a copy on another machine dies on the first refresh, so moves must leave them.
  const home = await temp('ultimate-snapshot-logins-')
  const marker = 'refresh-token-marker-7f3a'
  await mkdir(join(home, '.pi/agent'), { recursive: true })
  await writeFile(
    join(home, '.pi/agent/auth.json'),
    JSON.stringify({ anthropic: { refresh: marker } }),
  )
  await writeFile(join(home, 'secrets.json'), JSON.stringify({ ULTIMATE_CLOUD_TOKEN: marker }))
  const path = join(home, 'state.sqlite')
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('history')")
  db.close()
  const repo = await temp('ultimate-snapshot-logins-repo-')
  await git(repo, 'init', '-b', 'main')
  const uploaded = await uploadSnapshot({
    ...remote,
    epoch: 1,
    machine: 'desk',
    database: path,
    repo,
  })
  const downloads = await temp('ultimate-snapshot-logins-target-')
  const result = await downloadSnapshot({ ...remote, id: uploaded.id, dir: downloads, repo })
  expect(await readdir(downloads)).toEqual([`snapshot-${uploaded.id}.sqlite`])
  expect((await readFile(result.database)).includes(marker)).toBe(false)
  expect(count(result.database, 't')).toBe(1)
})

it('carries a branch checked out in a source worktree, with commits of its own, to a fresh clone', async () => {
  // A writer's concluded conversations leave branches checked out in their worktrees; the move must take them along.
  const repo = await temp('ultimate-snapshot-worktree-source-')
  await git(repo, 'init', '-b', 'main')
  await git(
    repo,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'root',
  )
  const clone = join(await temp('ultimate-snapshot-worktree-target-'), 'checkout')
  await git(repo, 'clone', '--quiet', repo, clone)
  const checkedOut = join(await temp('ultimate-snapshot-worktree-'), 'feature')
  await git(repo, 'worktree', 'add', '--quiet', '-b', 'ultimate/feature', checkedOut)
  await commit(repo, 'ultimate/feature', 'feature work')
  const own = await commit(repo, 'ultimate/feature', 'more feature work')
  const path = join(await temp('ultimate-snapshot-worktree-home-'), 'state.sqlite')
  new DatabaseSync(path).close()
  const uploaded = await uploadSnapshot({
    ...remote,
    epoch: 1,
    machine: 'desk',
    database: path,
    repo,
  })
  expect(uploaded.bundle).toBeDefined()
  const result = await downloadSnapshot({ ...remote, id: uploaded.id, dir, repo: clone })
  expect(result.keptRefs).toEqual([])
  expect(await tip(clone, 'ultimate/feature')).toBe(own)
  expect(await git(clone, 'log', '--format=%s', 'ultimate/feature')).toBe(
    'more feature work\nfeature work\nroot',
  )
})

const call = (path: string, init: RequestInit = {}, token = 'dev') =>
  worker.fetch(
    new Request(`https://cloud.example/sync/snapshots/${path}`, {
      ...init,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    env,
  )

it('authenticates before touching R2 and validates paths and sizes', async () => {
  const touch = vi.fn<() => never>(() => {
    throw new Error('binding touched')
  })
  const guarded = new Proxy(
    { SYNC_TOKEN: 'dev' },
    {
      get: (held, name) => (name === 'BUILDS' ? touch() : Reflect.get(held, name)),
    },
  ) as unknown as Env
  const path = `${project(key)}/abcdefgh/manifest`
  for (const headers of [{}, { Authorization: 'Bearer wrong' }] as HeadersInit[])
    expect(
      (
        await worker.fetch(
          new Request(`https://cloud.example/sync/snapshots/${path}`, { headers }),
          guarded,
        )
      ).status,
    ).toBe(401)
  expect(touch).not.toHaveBeenCalled()

  const p = project('github.com/o/limits')
  for (const bad of [
    `${p}/short/db-0`,
    `${p}/Upper-case-id/db-0`,
    `${p}/${'a'.repeat(65)}/db-0`,
    `${p}/abcdefgh/db-01`,
    `${p}/abcdefgh/wal-0`,
    `${p}/abcdefgh/manifest.json`,
    `${p.slice(1)}/abcdefgh/db-0`,
    `${p}/abcdefgh`,
    `${p}/abcdefgh/db-0/extra`,
  ])
    expect((await call(bad, { method: 'PUT', body: 'x' })).status).toBe(400)
  expect((await call(`${p}/abcdefgh/db-0`, { method: 'DELETE' })).status).toBe(400)
  expect((await call(`${p}/abcdefgh/db-0`)).status).toBe(404)
  expect(
    (
      await call(`${p}/abcdefgh/db-0`, {
        method: 'PUT',
        body: new Uint8Array(MAX_SNAPSHOT_OBJECT + 1),
      })
    ).status,
  ).toBe(413)
  expect(bucket.objects.has(`snapshots/${p}/abcdefgh/db-0`)).toBe(false)
  expect(
    (await call(`${p}/abcdefgh/db-0`, { method: 'PUT', body: new Uint8Array(MAX_SNAPSHOT_OBJECT) }))
      .status,
  ).toBe(204)
  const read = await call(`${p}/abcdefgh/db-0`)
  expect(read.headers.get('cache-control')).toBe('no-store')
  expect((await read.arrayBuffer()).byteLength).toBe(MAX_SNAPSHOT_OBJECT)
})

it('keeps the newest three snapshots and fresh partial uploads after each manifest', async () => {
  const p = project('github.com/o/retention')
  const other = project('github.com/o/neighbour')
  const put = (owner: string, id: string, name: string) =>
    call(`${owner}/${id}/${name}`, { method: 'PUT', body: 'ciphertext' })
  const held = () =>
    new Set(
      [...bucket.objects.keys()]
        .filter((name) => name.startsWith(`snapshots/${p}/`))
        .map((name) => name.split('/')[2]),
    )
  const hour = 60 * 60 * 1000
  bucket.at = Date.now() - 2 * hour
  await put(p, 'abandoned', 'db-0')
  await put(other, 'neighbour', 'manifest')
  bucket.at = Date.now() - 10 * 60 * 1000
  for (const id of ['snap-001', 'snap-002', 'snap-003', 'snap-004']) {
    await put(p, id, 'db-0')
    await put(p, id, 'manifest')
  }
  await put(p, 'inflight', 'db-0')
  expect(held()).toEqual(new Set(['snap-002', 'snap-003', 'snap-004', 'inflight']))
  // The manifest just uploaded is kept even when R2's clock places it before the others.
  bucket.at = Date.now() - 20 * 60 * 1000
  await put(p, 'snap-000', 'manifest')
  bucket.at = undefined
  expect(held()).toEqual(new Set(['snap-000', 'snap-003', 'snap-004', 'inflight']))
  expect(bucket.objects.has(`snapshots/${other}/neighbour/manifest`)).toBe(true)
})
