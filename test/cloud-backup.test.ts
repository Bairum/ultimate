// Cloud backups and `pnpm restore` against an in-memory Worker (`cloud-stub.ts`): the parent rule, force, and the
// restore that installs a backup as a home's state.
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { backUp, backupPath, classify, Conflict, readBackup } from '../extensions/cloud/backup.ts'
import { BackupEvent } from '../extensions/cloud/refs.ts'
import { git } from '../lib/git.ts'
import { acquireLock } from '../server/lock.ts'
import { findProject, restore } from '../scripts/restore.ts'
import { cloudStub } from './cloud-stub.ts'
import { eventHost, fauxServer, post, temp } from './helpers.ts'

const key = 'github.com/o/app'
const stub = cloudStub()
const cloud = { url: 'ws://127.0.0.1:8787', token: 'dev', secret: 'snapshot secret' }

beforeAll(() => vi.stubGlobal('fetch', stub.fetch))
afterAll(() => vi.unstubAllGlobals())

/** A project checkout named `app` and its home holding `notes` rows. */
async function machine(notes: string[]) {
  const projectRoot = join(await temp('ultimate-backup-project-'), 'app')
  await git(await temp(), 'init', '-q', '-b', 'main', projectRoot)
  const home = await temp('ultimate-backup-home-')
  const db = new DatabaseSync(join(home, 'state.sqlite'))
  db.exec('CREATE TABLE notes (body TEXT)')
  for (const note of notes) db.prepare('INSERT INTO notes VALUES (?)').run(note)
  db.close()
  return { projectRoot, home }
}
const notes = (home: string) => {
  const db = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true })
  try {
    return db
      .prepare('SELECT body FROM notes')
      .all()
      .map((row) => row.body)
  } finally {
    db.close()
  }
}
const back = (
  at: { projectRoot: string; home: string },
  name: string,
  extra: { force?: boolean; tailnet?: string; key?: string } = {},
) => backUp({ ...cloud, key, machine: name, ...at, ...extra })
/** A project of its own for each test, so earlier backups never make its first one stale. */
let projects = 0
const own = () => `github.com/o/other-${++projects}`

it('commits backups with their parent, refuses a stale one with the Worker’s sentence, and sends force', async () => {
  const a = await machine(['from a'])
  const first = await back(a, 'desk', { tailnet: 'https://desk.tail.ts.net' })
  expect(stub.commits.at(-1)).toMatchObject({
    key,
    name: 'app',
    machine: 'desk',
    parent: null,
    tailnet: 'https://desk.tail.ts.net',
  })
  expect(stub.commits.at(-1)).not.toHaveProperty('force')
  // 200 records the new backup as the next one's parent.
  expect(await readBackup(a.home, key)).toEqual({ key, parent: first.id, last: first })
  expect(stub.register.projects).toMatchObject([{ key, name: 'app', latest: { id: first.id } }])

  // Another machine restored A's backup and backed up on top of it.
  const b = await machine([])
  await restore({
    ...cloud,
    key,
    id: first.id,
    home: b.home,
    projectRoot: b.projectRoot,
    backups: await temp(),
  })
  expect(notes(b.home)).toEqual(['from a'])
  const second = await back(b, 'laptop')
  expect(stub.commits.at(-1)).toMatchObject({ machine: 'laptop', parent: first.id })

  // A builds on its own, now stale, parent: 409 keeps that parent and carries the Worker's sentence.
  const before = await readFile(backupPath(a.home), 'utf8')
  const refused = await back(a, 'desk').catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(Conflict)
  expect((refused as Conflict).message).toBe(
    'laptop backed up app after this machine last did; restore its backup or back up anyway to replace it',
  )
  expect((refused as Conflict).latest).toBe(second.id)
  expect(classify(refused)).toBe('conflict')
  expect(await readFile(backupPath(a.home), 'utf8')).toBe(before)
  // The refused upload's chunks stay for the Worker's retention.
  const uploaded = new Set([...stub.objects.keys()].map((name) => name.split('/')[1]))
  expect(uploaded.size).toBe(3)

  // Forced, it replaces the latest and becomes A's parent.
  const forced = await back(a, 'desk', { force: true })
  expect(stub.commits.at(-1)).toMatchObject({ machine: 'desk', parent: first.id, force: true })
  expect(stub.register.projects[0].latest.id).toBe(forced.id)
  expect((await readBackup(a.home, key))?.parent).toBe(forced.id)
})

it('names an HTTP failure and keeps the parent', async () => {
  const a = await machine(['x'])
  const failing = cloudStub('other')
  vi.stubGlobal('fetch', failing.fetch)
  try {
    const error = await back(a, 'desk').catch((failure: unknown) => failure)
    expect(classify(error)).toBe('HTTP 401')
    expect(existsSync(backupPath(a.home))).toBe(false)
  } finally {
    vi.stubGlobal('fetch', stub.fetch)
  }
})

it('restores into a home: moves the old state aside, installs the backup and records it as parent', async () => {
  const source = await machine(['kept history'])
  const other = own()
  const done = await back(source, 'desk', { key: other })
  const target = await machine(['old state'])
  await writeFile(join(target.home, 'conversations.json'), '[]')
  await writeFile(join(target.home, 'project.json'), '{}')
  const backups = await temp('ultimate-restore-backups-')
  const result = await restore({
    ...cloud,
    key: other,
    id: done.id,
    home: target.home,
    projectRoot: target.projectRoot,
    backups,
    now: new Date('2026-10-21T10:00:00Z'),
  })
  expect(result.backup).toBe(
    join(backups, 'restore-2026-10-21T10-00-00-000Z', target.home.split('/').at(-1)!),
  )
  expect(result.moves).toEqual(['conversations.json', 'state.sqlite'])
  expect(notes(target.home)).toEqual(['kept history'])
  expect(notes(result.backup)).toEqual(['old state'])
  // Settings like project.json stay; the download leaves nothing behind.
  expect(
    (await readdir(target.home)).filter((name) => !name.startsWith('ultimate.lock')).toSorted(),
  ).toEqual(['cloud-backup.json', 'project.json', 'state.sqlite'])
  expect(await readBackup(target.home, other)).toEqual({ key: other, parent: done.id, last: done })
})

it('refuses to restore while Ultimate holds the home, and moves nothing', async () => {
  const source = await machine(['a'])
  const other = own()
  const done = await back(source, 'desk', { key: other })
  const target = await machine(['running'])
  const lock = await acquireLock(join(target.home, 'ultimate.lock'), {
    pid: process.pid,
    port: 4747,
  })
  try {
    await expect(
      restore({
        ...cloud,
        key: other,
        id: done.id,
        home: target.home,
        projectRoot: target.projectRoot,
        backups: await temp(),
      }),
    ).rejects.toThrow('Ultimate is running here (pid')
    expect(notes(target.home)).toEqual(['running'])
  } finally {
    await lock.close()
  }
})

it('finds a project in the register by name or key, and names the ones it knows otherwise', () => {
  const register = {
    projects: [
      { ...stub.register.projects[0], name: 'app', key },
      { ...stub.register.projects[0], name: 'blog', key: 'github.com/o/blog' },
    ],
    machines: [],
  }
  expect(findProject(register, 'APP', undefined).key).toBe(key)
  expect(findProject(register, undefined, 'github.com/o/blog').name).toBe('blog')
  expect(() => findProject(register, 'shop', undefined)).toThrow(
    'No backup of shop in the cloud. Backed up: app, blog',
  )
})

it('backs up from the UI, records the refusal as a failed event with the sentence, and forces on request', async () => {
  const userHome = await temp('ultimate-backup-server-')
  const projectRoot = join(userHome, 'app')
  await git(userHome, 'init', '-q', '-b', 'main', projectRoot)
  const other = own()
  await git(projectRoot, 'remote', 'add', 'origin', `https://${other}.git`)
  await git(
    projectRoot,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'root',
  )
  vi.stubEnv('ULTIMATE_CLOUD_URL', cloud.url)
  vi.stubEnv('ULTIMATE_CLOUD_TOKEN', cloud.token)
  vi.stubEnv('ULTIMATE_CLOUD_SNAPSHOT_KEY', cloud.secret)
  vi.stubEnv('ULTIMATE_CLOUD_MACHINE', 'desk')
  const server = await fauxServer({
    ultimateRoot: join(import.meta.dirname, '..'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
  })
  const action = (name: string, args: unknown = null) =>
    post(server, `/api/extensions/cloud/actions/${name}`, { args })
  try {
    const first = await action('backup')
    expect(first.status).toBe(200)
    expect(first.data.result).toMatchObject({ machine: 'desk' })
    expect((await action('state')).data.result).toMatchObject({
      status: 'on',
      name: 'app',
      machine: 'desk',
      lastBackup: { id: first.data.result.id },
    })
    // Another machine backs up after it: this home's parent is stale now.
    stub.register.projects.find((project) => project.key === other)!.latest = {
      ...stub.register.projects.find((project) => project.key === other)!.latest,
      id: 'zz-other',
      machine: 'rog',
    }
    const refused = await action('backup')
    expect(refused.status).not.toBe(200)
    const sentence =
      'rog backed up app after this machine last did; restore its backup or back up anyway to replace it'
    expect(JSON.stringify(refused.data)).toContain(sentence)
    expect((await action('state')).data.result).toMatchObject({
      lastBackup: { id: first.data.result.id },
      conflict: { error: sentence, latest: { id: 'zz-other', machine: 'rog' } },
    })
    const events = await eventHost(() => server.harness, 'test').eventLog.recent({
      events: [BackupEvent],
    })
    expect(events.map((event) => event.data)).toContainEqual(
      expect.objectContaining({ phase: 'failed', reason: 'conflict', error: sentence }),
    )
    // Agents cannot back up; the UI can force it.
    const forced = await action('backup', { force: true })
    expect(forced.status).toBe(200)
    expect(stub.commits.at(-1)).toMatchObject({ force: true, parent: first.data.result.id })
    expect((await action('state')).data.result).not.toHaveProperty('conflict')
  } finally {
    await server.close()
    vi.unstubAllEnvs()
  }
})
