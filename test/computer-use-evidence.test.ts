import { expect, it } from 'vitest'
import { mkdir, writeFile, utimes, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pruneEvidence } from '../extensions/computer-use/evidence-files.ts'
import { temp, removeTemp } from './helpers.ts'

it('expires 30-day evidence and caps each conversation by deleting oldest PNGs first', async () => {
  const home = await temp()
  const now = Date.UTC(2026, 9, 25)
  try {
    for (const conversation of ['1', '2']) {
      const folder = join(home, 'computer-use', conversation)
      await mkdir(folder, { recursive: true })
      for (const [name, age] of [
        ['expired.png', 31 * 86400],
        ['old.png', 100],
        ['new.png', 10],
      ] as const) {
        const path = join(folder, name)
        await writeFile(path, Buffer.alloc(6))
        await utimes(path, (now - age * 1000) / 1000, (now - age * 1000) / 1000)
      }
    }
    await pruneEvidence(home, now, 10)
    expect(await readdir(join(home, 'computer-use', '1'))).toEqual(['new.png'])
    expect(await readdir(join(home, 'computer-use', '2'))).toEqual(['new.png'])
  } finally {
    await removeTemp(home)
  }
})
