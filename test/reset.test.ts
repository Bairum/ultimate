import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { apply, plan } from '../scripts/reset.ts'
import { prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

/** A home with state, its log and a conversation list. */
async function home() {
  const path = await temp('ultimate-reset-')
  const db = new DatabaseSync(join(path, 'state.sqlite'))
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  db.close()
  await writeFile(join(path, 'state.sqlite-wal'), 'log')
  await writeFile(join(path, 'conversations.json'), '[]')
  return { path, backups: await temp('ultimate-reset-backups-') }
}

it('finishes an interrupted reset into the same backup', async () => {
  const { path, backups } = await home()
  const first = await plan(path, backups)
  // Interrupted after the journal, with only the database moved.
  await mkdir(first.backup, { recursive: true })
  await writeFile(join(path, 'reset.json'), JSON.stringify({ backup: first.backup }))
  await rename(join(path, 'state.sqlite'), join(first.backup, 'state.sqlite'))

  const again = await plan(path, backups, new Date(Date.now() + 60_000))
  expect(again).toMatchObject({ resumes: true, backup: first.backup })
  expect(again.moves.toSorted()).toEqual(['conversations.json', 'state.sqlite-wal'])
  expect(await apply(again)).toEqual({ backup: first.backup })

  expect((await readdir(first.backup)).toSorted()).toEqual([
    'conversations.json',
    'state.sqlite',
    'state.sqlite-wal',
  ])
  expect((await readdir(path)).filter((name) => !name.includes('.lock'))).toEqual([])
})

it('keeps every path from opening storage on a home an interrupted reset left', async () => {
  const path = await temp('ultimate-reset-open-')
  await writeFile(join(path, 'reset.json'), '{}')
  const prepared = await prepareHarness({
    ultimateRoot: path,
    userHome: path,
    home: path,
    faux: fauxProvider(),
  })
  await expect(prepared.open(false)).rejects.toThrow('A reset or restore of')
  expect(existsSync(join(path, 'state.sqlite'))).toBe(false)
  // The refusal released storage's lock: once the reset finishes, the home opens.
  await rm(join(path, 'reset.json'))
  await (await prepared.open(false)).close()
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
