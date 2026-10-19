import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { keepCalling, stopCalling } from '../extensions/faux/lanes.ts'

const homes: string[] = []
afterEach(() => {
  stopCalling()
  vi.useRealTimers()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function trace() {
  const home = mkdtempSync(join(tmpdir(), 'faux-lanes-'))
  homes.push(home)
  const file = join(home, 'trace.sqlite')
  const database = new DatabaseSync(file)
  database.exec(`CREATE TABLE calls (id TEXT PRIMARY KEY, parent TEXT, trace TEXT NOT NULL, at REAL NOT NULL,
    ms REAL NOT NULL, caller TEXT NOT NULL, callee TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
    ok INTEGER NOT NULL, error TEXT, args TEXT, result TEXT, conversation INTEGER, task INTEGER, entry INTEGER)`)
  database.close()
  const count = () => {
    const reader = new DatabaseSync(file)
    try {
      return (reader.prepare('SELECT count(*) AS n FROM calls').get() as { n: number }).n
    } finally {
      reader.close()
    }
  }
  return { file, count }
}

it('writes a call every 3 s until stopped, then nothing more', () => {
  vi.useFakeTimers()
  const { file, count } = trace()
  keepCalling(file, 7)
  vi.advanceTimersByTime(9000)
  expect(count()).toBe(3)
  stopCalling()
  vi.advanceTimersByTime(30_000)
  expect(count()).toBe(3)
})

it('replaces the calls of an earlier seed instead of adding a second ticker', () => {
  vi.useFakeTimers()
  const { file, count } = trace()
  keepCalling(file, 7)
  keepCalling(file, 7)
  vi.advanceTimersByTime(6000)
  expect(count()).toBe(2)
})

it('stops on its own after an hour', () => {
  vi.useFakeTimers()
  const { file, count } = trace()
  keepCalling(file, 7)
  vi.advanceTimersByTime(60 * 60_000)
  const written = count()
  vi.advanceTimersByTime(60_000)
  expect(count()).toBe(written)
})
