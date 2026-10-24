// Re-score wrong-target flags of results recorded before blank-line seams were counted separately.
// Rebuilds each flagged run's final files from its saved verifier.diff (expected → actual) and re-runs verify.
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { applyPatch, parsePatch } from 'diff'
import type { Result } from './metrics.ts'
import { regenerate } from './report.ts'
import { files, verify } from './verify.ts'

const out = resolve(process.argv[2] ?? '.')
const temp = await mkdtemp(join(tmpdir(), 'hashline-rescore-'))
try {
  await promisify(execFile)('tar', [
    'xzf',
    join(import.meta.dirname, 'fixtures.tar.gz'),
    '-C',
    temp,
  ])
  const path = join(out, 'results.jsonl')
  const rows = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Result)
  let changed = 0
  for (const row of rows) {
    if (!row.wrongTarget || row.blankSeam !== undefined) continue
    const fixture = join(temp, 'fixtures', row.task)
    const project = join(temp, 'actual', String(changed))
    for (const file of await files(join(fixture, 'expected'))) {
      await mkdir(dirname(join(project, file)), { recursive: true })
      await copyFile(join(fixture, 'expected', file), join(project, file))
    }
    for (const patch of parsePatch(
      await readFile(resolve(out, row.artifact, 'verifier.diff'), 'utf8'),
    )) {
      const file = patch.newFileName!.replace(/^actual\//, '')
      const before = patch.oldFileName!.replace(/^expected\//, '')
      const source = await readFile(join(fixture, 'expected', before), 'utf8').catch(() => '')
      const text = applyPatch(source.replace(/\r\n?/g, '\n'), patch)
      if (text === false) throw new Error(`${row.key}: verifier.diff does not apply`)
      await mkdir(dirname(join(project, file)), { recursive: true })
      await writeFile(join(project, file), text)
    }
    const verified = await verify(fixture, project)
    row.wrongTarget = verified.wrongTarget
    row.blankSeam = verified.blankSeam
    changed++
  }
  await copyFile(path, `${path}.before-rescore`)
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  await regenerate(out)
  console.log(`Re-scored ${changed} flagged runs; original kept as results.jsonl.before-rescore.`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
