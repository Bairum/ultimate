import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { outsideRegion, verify } from './verify.ts'
import { metrics, type Result } from './metrics.ts'
import { report } from './report.ts'

await test('all 106 expected trees pass; wrong content and extra files fail', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'hashline-test-'))
  try {
    await promisify(execFile)('tar', [
      '-xzf',
      fileURLToPath(new URL('./fixtures.tar.gz', import.meta.url)),
      '-C',
      temp,
    ])
    const tasks = await readdir(join(temp, 'fixtures'))
    assert.equal(tasks.length, 106)
    for (const task of tasks) {
      const fixture = join(temp, 'fixtures', task)
      assert.deepEqual(await verify(fixture, join(fixture, 'expected')), {
        pass: true,
        wrongTarget: false,
        blankSeam: false,
        diff: '',
      })
    }
    const fixture = join(temp, 'fixtures/access-remove-optional-chain-001')
    const project = join(temp, 'actual')
    await cp(join(fixture, 'input'), project, { recursive: true })
    const broken = await verify(fixture, project)
    assert.equal(broken.pass, false)
    assert.equal(broken.wrongTarget, false) // Unrepaired mutation is not a wrong-location write.
    await cp(join(fixture, 'expected'), project, { recursive: true })
    const path = join(project, 'uuid.ts')
    const code = await readFile(path, 'utf8')
    await writeFile(path, '\n\n' + code)
    assert.equal((await verify(fixture, project)).pass, true) // Code blank-line count ignored.
    const seam = await verify(fixture, project)
    assert.equal(seam.wrongTarget, false) // Only blank lines changed off target: a seam, not a wrong-line write.
    assert.equal(seam.blankSeam, true)
    await writeFile(path, '  ' + code)
    assert.equal((await verify(fixture, project)).wrongTarget, true) // Off-target indentation is content.
    await writeFile(join(project, 'unexpected.txt'), 'extra')
    const extra = await verify(fixture, project)
    assert.equal(extra.pass, false)
    assert.equal(extra.wrongTarget, true)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

await test('wrong-target checks use expected line coordinates and insertion boundary', () => {
  const expected = 'a\nb\nc\nd\n'
  const none = { content: false, blank: false }
  assert.deepEqual(outsideRegion(expected, 'a\nx\nc\nd\n', 2, 1), none)
  assert.deepEqual(outsideRegion(expected, 'a\nb\nx\nc\nd\n', 2, 1), none)
  assert.deepEqual(outsideRegion(expected, 'x\nb\nc\nd\n', 2, 1), { content: true, blank: false })
  assert.deepEqual(outsideRegion(expected, 'a\nb\nc\nx\n', 2, 1), { content: true, blank: false })
  assert.deepEqual(outsideRegion(expected, 'a\nb\nc\n\nd\n', 2, 1), { content: false, blank: true })
})

await test('metrics count persisted usage and explicit edit errors, never assistant prose', () => {
  const result = metrics([
    {
      model: [
        {
          role: 'assistant',
          usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.1 } },
          content: [
            { type: 'text', text: 'passed, no errors' },
            { type: 'toolCall', name: 'edit' },
          ],
        },
        { role: 'toolResult', toolName: 'edit', isError: true },
      ],
    },
  ])
  assert.equal(result.output, 3)
  assert.equal(result.cost, 0.1)
  assert.equal(result.editCalls, 1)
  assert.equal(result.editErrors, 1)
  assert.equal(metrics([{ model: [{ role: 'assistant', usage: {} }] }]).cost, null)
  assert.throws(() => metrics([{ model: [{ role: 'assistant' }] }]), /missing usage/)
})

await test('pass bars require paired arms; ordering does not depend on completion order', () => {
  const a: Result = {
    ...metrics([]),
    key: 'a',
    task: 'one',
    arm: 'baseline',
    armOrder: 0,
    extensions: [],
    model: 'test/model',
    run: 1,
    pass: true,
    wrongTarget: false,
    wallMs: 1000,
    artifact: '',
    output: 100,
    cost: 1,
    editCalls: 1,
  }
  const b: Result = { ...a, key: 'b', arm: 'hashline', armOrder: 1, output: 85 }
  const paired = report([b, a])
  assert.match(paired, /hashline vs baseline/)
  assert.match(paired, /15% lower: PASS/)
  assert.match(report([a]), /only one arm measured/)
  assert.match(report([a, { ...b, run: 2 }]), /incomplete paired runs/)
  assert.match(report([a, { ...b, cost: null }]), /not higher: N\/A/)
  assert.match(
    report([a, { ...b, wrongTarget: true, editErrors: 1, output: 86, cost: 2 }]),
    /15% lower: FAIL/,
  )
})
