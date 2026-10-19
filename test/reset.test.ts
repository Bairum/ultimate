import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { databaseHash } from '../lib/database-files.ts'
import { apply, plan } from '../scripts/reset.ts'
import { temp } from './helpers.ts'

/** A home with state and its log, released to the cloud at epoch 3 as snapshot `s1`. */
async function home() {
  const path = await temp('ultimate-reset-')
  const db = new DatabaseSync(join(path, 'state.sqlite'))
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  db.close()
  await writeFile(join(path, 'state.sqlite-wal'), 'log')
  await writeFile(join(path, 'conversations.json'), '[]')
  await writeFile(
    join(path, 'cloud-lease.json'),
    JSON.stringify({ key: 'k', epoch: 3, snapshot: 's1', snapshotHash: 'old' }),
  )
  return { path, backups: await temp('ultimate-reset-backups-') }
}

it('checks the home again under its lock: a move that began after planning stops the reset', async () => {
  const { path, backups } = await home()
  const planned = await plan(path, backups)
  await writeFile(join(path, 'cloud-claim.json'), '{}')
  await expect(apply(planned)).rejects.toThrow('A move to this machine is in flight')
  expect(existsSync(join(path, 'state.sqlite'))).toBe(true)
  expect(JSON.parse(await readFile(join(path, 'cloud-lease.json'), 'utf8'))).toMatchObject({
    snapshotHash: 'old',
  })
})

it('finishes an interrupted reset into the same backup, then installs the recorded fresh database', async () => {
  const { path, backups } = await home()
  const first = await plan(path, backups)
  // Interrupted after the journal, the fresh database and its hash, with only the database moved.
  await mkdir(first.backup, { recursive: true })
  await writeFile(
    join(path, 'reset.json'),
    JSON.stringify({ backup: first.backup, cloud: true, phase: 'moving' }),
  )
  new DatabaseSync(join(path, 'state.reset.sqlite')).close()
  await rename(join(path, 'state.sqlite'), join(first.backup, 'state.sqlite'))

  const again = await plan(path, backups, new Date(Date.now() + 60_000))
  expect(again).toMatchObject({ resumes: true, backup: first.backup, cloud: true })
  expect(again.moves.toSorted()).toEqual(['conversations.json', 'state.sqlite-wal'])
  expect(await apply(again)).toBe(first.backup)

  expect((await readdir(first.backup)).toSorted()).toEqual([
    'conversations.json',
    'state.sqlite',
    'state.sqlite-wal',
  ])
  expect(
    (await readdir(path)).filter((name) => !name.startsWith('ultimate.lock')).toSorted(),
  ).toEqual(['cloud-lease.json', 'state.sqlite'])
  const lease = JSON.parse(await readFile(join(path, 'cloud-lease.json'), 'utf8'))
  expect(lease).toMatchObject({ key: 'k', epoch: 3, snapshot: 's1' })
  expect(lease.snapshotHash).toBe(await databaseHash(join(path, 'state.sqlite')))
})

it('never overwrites a file already in the backup', async () => {
  const { path, backups } = await home()
  const planned = await plan(path, backups)
  await mkdir(planned.backup, { recursive: true })
  await writeFile(join(planned.backup, 'conversations.json'), 'kept')
  await expect(apply(planned)).rejects.toThrow('refusing to overwrite')
  expect(await readFile(join(planned.backup, 'conversations.json'), 'utf8')).toBe('kept')
  // The journal stays, so running the reset again names the same backup and the conflict.
  expect(existsSync(join(path, 'reset.json'))).toBe(true)
})
