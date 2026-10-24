import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  applyEdits,
  parsePatch,
  computeFileHash,
  xxhash32,
  InMemoryFilesystem,
  InMemorySnapshotStore,
  NodeFilesystem,
  NotFoundError,
  Patch,
  Patcher,
  MismatchError,
  Recovery,
  resolveBlockEdits,
  setSyntaxProbe,
  buildCompactDiffPreview,
  formatNumberedLines,
  formatHashlineHeader,
  parsePatchStreaming,
  splitAddressableFileLines,
  detectLineEnding,
} from '../extensions/hashline/engine/index.ts'

interface Call {
  input: string
  text: string
  path?: string
  error?: string
  expect: {
    editCount: number
    fileOp?: unknown
    warnings?: string[]
    text: string
    firstChangedLine?: number
  }
  clipboard?: { lines?: string[]; named?: Record<string, string[]>; pendingAnonCuts?: string[] }
  onEmptyPaste?: 'drop' | 'throw'
}
interface FixtureCase {
  name: string
  parse?: Call[]
  apply?: Call[]
}
const fixtures = readdirSync(new URL('../extensions/hashline/test/fixtures/', import.meta.url))
  .toSorted()
  .map((name) => ({
    name,
    cases: (
      JSON.parse(
        readFileSync(
          new URL(`../extensions/hashline/test/fixtures/${name}`, import.meta.url),
          'utf8',
        ),
      ) as { cases: FixtureCase[] }
    ).cases,
  }))
const legacy = (message: string) => message.replace(/^(InvalidAbsoluteRangeError|Error): /, '')

// Each named call needs tree-sitter structural/parse evidence, deliberately absent in v1.
const needsSyntax = new Set([
  'retains a swallowed opening comment fence when syntax and indentation prove the boundary',
  'drops a duplicated multi-line closing block (the Root.tsx incident)',
  'preserves a duplicated opener when it does not account for the imbalance',
  'spares the deleted closing line when the payload omits it',
  'drops a one-sided JSX closer echo in a single-line expansion',
  'drops a JSX closer echo after a self-closing tag with a greater-than prop expression',
  'rejects sparing a deleted closer when the payload claims no position inside the block',
  'still spares a closer when the payload indentation claims the block interior',
  'spends the missing-closer residual on the genuine hunk, not an earlier wrapper removal',
  'keeps the closer when the matching opener is replaced rather than removed',
  'keeps only the non-restated outer closer for a nested deleted suffix',
  'ignores non-contiguously deleted openers when choosing which closer to keep',
  'counts earlier kept closers in later projected prefixes',
  'does not let an earlier kept closer cover a later orphan closer',
  'keeps an omitted inner closer when the outer closer survives below',
  'counts head insertions before replacement payloads in original coordinates',
  'counts a separately inserted closer immediately below the range',
  'keeps an omitted outer closer even when the payload restates an inner closer',
  "still keeps a missing closer when another hunk's dupSuffix repair masks the raw delta",
  'does not let an unterminated template in one hunk mask a missing closer in another',
  'spares a leading closer the range swallowed when the payload claims sibling depth',
  'rejects a swallowed leading closer when the payload claims the block interior',
  "warns when a balanced payload's range ends mid-block",
  'spares the swallowed leading closer when the authored edit does not parse',
  'flags a range that swallows a lifetime-carrying signature line',
  'does not resurrect a swallowed signature when body indentation matches',
  'warns when a balance-neutral edit stops the file parsing',
  'drops a trailing attribute echo in a single-line replacement',
  'drops the echo when the body carries several new doc rows',
  'drops a leading attribute echo in a single-line replacement',
  'rejects a single-line annotation echo whose body cannot fill the range',
  'drops a trailing decorator echo in a single-line replacement',
  'applies a same-shape if-opener replacement when an unrelated edit in the batch breaks the parse',
  'applies a same-shape case-label replacement when an unrelated edit in the batch breaks the parse',
  'rejects sparing a deleted keyword closer (Lua end) when the payload claims no position inside the block',
  'applies a same-shape Rust signature replacement with lifetimes when an unrelated edit in the batch breaks the parse',
  'lands a tab-indented construct body after the block, not inside the opener',
  'abandons the escape when the relocated result does not parse',
  'escapes a shallower function body past a class in TypeScript',
  'keeps a shallower Go case label inside its switch when the shift would break the parse',
  'keeps an else branch in place instead of duplicating the if closer',
  'still slides a shallower statement when an unrelated edit in the batch breaks the parse',
])
const skippedCalls: string[] = []
const counts: Record<string, { passing: number; needsSyntax: number }> = {}

describe('upstream parse/apply parity', () => {
  for (const fixture of fixtures)
    for (const entry of fixture.cases) {
      for (const mode of ['parse', 'apply'] as const)
        for (const [index, call] of (entry[mode] ?? []).entries()) {
          const syntax = mode === 'apply' && needsSyntax.has(entry.name)
          const count = (counts[fixture.name] ??= { passing: 0, needsSyntax: 0 })
          if (syntax) {
            count.needsSyntax++
            skippedCalls.push(entry.name)
          } else count.passing++
          test.skipIf(syntax)(
            `${fixture.name}: ${entry.name} [${mode} ${index}]${syntax ? ' — needs syntax: structural/parse proof' : ''}`,
            () => {
              let actual: unknown
              let error: unknown
              try {
                const parsed = parsePatch(call.input)
                if (mode === 'parse')
                  actual = {
                    editCount: parsed.edits.length,
                    fileOp: parsed.fileOp,
                    warnings: parsed.warnings,
                  }
                else {
                  const clipboard = call.clipboard && {
                    ...call.clipboard,
                    named: call.clipboard.named && new Map(Object.entries(call.clipboard.named)),
                  }
                  const result = applyEdits(call.text, parsed.edits, {
                    path: call.path,
                    clipboard,
                    onEmptyPaste: call.onEmptyPaste ?? 'throw',
                  })
                  actual = {
                    text: result.text,
                    firstChangedLine: result.firstChangedLine ?? null,
                    warnings: result.warnings ?? [],
                  }
                }
              } catch (caught) {
                error = caught
              }
              const observed = error instanceof Error ? { error: legacy(error.message) } : actual
              const expected = call.error
                ? { error: legacy(call.error) }
                : mode === 'parse'
                  ? {
                      editCount: call.expect.editCount,
                      fileOp: call.expect.fileOp,
                      warnings: call.expect.warnings,
                    }
                  : {
                      text: call.expect.text,
                      firstChangedLine: call.expect.firstChangedLine ?? null,
                      warnings: call.expect.warnings ?? [],
                    }
              expect(observed).toEqual(expected)
            },
          )
        }
    }
})
test('all 19 fixture files are inventoried; call gate excludes name-only host scenarios', () => {
  expect(fixtures).toHaveLength(19)
  expect(
    fixtures.reduce(
      (sum, fixture) =>
        sum +
        fixture.cases.reduce(
          (calls, entry) => calls + (entry.parse?.length ?? 0) + (entry.apply?.length ?? 0),
          0,
        ),
      0,
    ),
  ).toBe(541)
  expect(
    fixtures.find((fixture) => fixture.name === 'parity_block_replace.json')?.cases,
  ).toHaveLength(14)
})

test('parity accounting and explicit needs-syntax list', () => {
  expect(skippedCalls).toHaveLength(42)
  expect(new Set(skippedCalls)).toEqual(needsSyntax)
  expect(Object.values(counts).reduce((sum, count) => sum + count.passing, 0)).toBe(499)
  console.table(counts)
  console.info('needs syntax (42):', skippedCalls)
})

interface PatcherCase {
  name: string
  files?: Record<string, string>
  snapshots?: { path: string; text?: string; seenLines?: number[] }[]
  args: { input: string }
  policy?: { enforceSeenLines?: boolean }
  expect: {
    files?: Record<string, string>
    deleted?: string[]
    writes: number
    textContains?: string[]
    error?: string
  }
}
class TestFilesystem extends InMemoryFilesystem {
  writes = 0
  override async readText(file: string) {
    return super.readText(this.canonicalPath(file))
  }
  override canonicalPath(file: string): string {
    return path.posix.normalize(file)
  }
  override async writeText(file: string, text: string) {
    this.writes++
    return super.writeText(file, text)
  }
  override async delete(file: string) {
    this.writes++
    return super.delete(file)
  }
  override async move(from: string, to: string, text?: string) {
    this.writes++
    return super.move(from, to, text)
  }
}
const patcherCases = JSON.parse(
  readFileSync(
    new URL('../extensions/hashline/test/fixtures/patcher.json', import.meta.url),
    'utf8',
  ),
) as { cases: PatcherCase[] }
const retainedTagOverrides = new Set([
  'validates any anchor purely from the content hash, even with no recorded snapshot',
  'normalizes lowercase section tags while parsing',
])
for (const entry of patcherCases.cases)
  test(`patcher.json: ${entry.name}${retainedTagOverrides.has(entry.name) ? ' [Ultimate requires retained tag]' : ''}`, async () => {
    const fs = new TestFilesystem(Object.entries(entry.files ?? {}))
    // Ultimate deliberately tightens legacy no-snapshot acceptance: even a
    // live short tag needs retained, unambiguous 32-bit provenance.
    const expectation = retainedTagOverrides.has(entry.name)
      ? {
          error: 'not from this session',
          writes: 0,
          files: entry.files,
          deleted: undefined,
          textContains: undefined,
        }
      : entry.expect
    const snapshots = new InMemorySnapshotStore()
    const tags = new Map<string, string>()
    for (const snapshot of entry.snapshots ?? [])
      tags.set(
        snapshot.path,
        snapshots.record(
          snapshot.path,
          snapshot.text ?? fs.get(snapshot.path)!,
          snapshot.seenLines,
        ),
      )
    const input = entry.args.input.replace(/\{\{tag:([^}]+)\}\}/g, (_, file: string) =>
      tags.get(file)!,
    )
    const patcher = new Patcher({ fs, snapshots, ...entry.policy })
    let message = ''
    let error: unknown
    try {
      const result = await patcher.apply(Patch.parse(input))
      message = result.sections.flatMap((section) => section.warnings).join('\n')
    } catch (caught) {
      error = caught
    }
    const expectedError = expectation.error
    const matches = expectedError
      ? error instanceof Error && error.message.includes(expectedError)
      : error === undefined
    expect({ matches, message: matches ? undefined : String(error) }).toEqual({
      matches: true,
      message: undefined,
    })
    expect(fs.writes).toBe(expectation.writes)
    for (const [file, text] of Object.entries(expectation.files ?? {}))
      expect(fs.get(file)).toBe(text)
    for (const file of expectation.deleted ?? []) expect(fs.get(file)).toBeUndefined()
    for (const text of expectation.textContains ?? []) expect(message).toContain(text)
  })

test('Node filesystem moves neither overwrite destinations nor modify a source on failure', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hashline-move-'))
  const fs = new NodeFilesystem()
  const source = path.join(dir, 'source'),
    destination = path.join(dir, 'destination')
  try {
    await fs.writeText(source, 'original\n')
    await fs.writeText(destination, 'keep\n')
    await expect(fs.move(source, destination, 'after cut\n')).rejects.toThrow('REM it first')
    expect(await fs.readText(source)).toBe('original\n')
    expect(await fs.readText(destination)).toBe('keep\n')
    await expect(
      fs.move(source, path.join(destination, 'not-a-directory'), 'after cut\n'),
    ).rejects.toThrow(/ENOTDIR|EEXIST/)
    expect(await fs.readText(source)).toBe('original\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Node filesystem reads, creates parents, moves, removes, and distinguishes missing files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hashline-'))
  const fs = new NodeFilesystem()
  try {
    const source = path.join(dir, 'nested/source.txt')
    const dest = path.join(dir, 'dest.txt')
    await fs.writeText(source, 'héllo\n')
    expect(await fs.readText(source)).toBe('héllo\n')
    expect(new Uint8Array(await fs.readBinary(source))).toEqual(new TextEncoder().encode('héllo\n'))
    expect(await fs.exists(source)).toBe(true)
    await fs.move(source, dest)
    expect(await fs.exists(source)).toBe(false)
    expect(await fs.readText(dest)).toBe('héllo\n')
    await fs.delete(dest)
    await expect(fs.readText(dest)).rejects.toBeInstanceOf(NotFoundError)
    await expect(fs.delete(dest)).rejects.toBeInstanceOf(NotFoundError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function session(source = 'same\n', seen?: number[]) {
  const fs = new TestFilesystem([['a.txt', source]])
  const snapshots = new InMemorySnapshotStore()
  const tag = snapshots.record('a.txt', source, seen)
  const patcher = new Patcher({ fs, snapshots })
  return {
    fs,
    snapshots,
    patcher,
    tag,
    apply: (body: string, hash = tag) => patcher.apply(Patch.parse(`[a.txt#${hash}]\n${body}`)),
  }
}
for (const operation of ['REM', 'MV moved.txt', 'CUT 2 @saved\nMV moved.txt']) {
  for (const mode of ['stale', 'invented'])
    test(`engine ${operation} rejects ${mode} tags before file operations`, async () => {
      const s = session('one\ntwo\nthree\n')
      const live = 'external\none\ntwo\nthree\n'
      s.fs.set('a.txt', live)
      await expect(s.apply(operation, mode === 'stale' ? s.tag : 'FFFF')).rejects.toBeInstanceOf(
        MismatchError,
      )
      expect(s.fs.get('a.txt')).toBe(live)
      expect(s.fs.get('moved.txt')).toBeUndefined()
      expect(s.fs.writes).toBe(0)
    })
}

const noopScenarios: (() => Promise<void>)[] = [
  async () => {
    const s = session()
    for (let i = 0; i < 2; i++)
      expect((await s.apply('PUT 1.=1:\n+same')).sections[0].warnings.join('\n')).toContain(
        'produced no change',
      )
  },
  async () => {
    const s = session()
    await s.apply('PUT 1.=1:\n+same')
    await s.apply('PUT 1.=1:\n+same')
    await expect(s.apply('PUT 1.=1:\n+same')).rejects.toThrow(
      'STOP. Edits to a.txt have been a byte-identical no-op 3 times in a row',
    )
  },
  async () => {
    const s = session()
    s.fs.set('b.txt', 'same\n')
    s.snapshots.record('b.txt', 'same\n')
    for (const file of ['a.txt', 'b.txt'])
      for (let i = 0; i < 2; i++) {
        const result = await s.patcher.apply(Patch.parse(`[${file}#${s.tag}]\nPUT 1.=1:\n+same`))
        expect(result.sections[0].op).toBe('noop')
      }
  },
  async () => {
    const s = session()
    await s.apply('PUT 1.=1:\n+same')
    await s.apply('PUT 1.=1:\n+same')
    const changed = await s.apply('PUT 1.=1:\n+changed')
    for (let i = 0; i < 2; i++)
      expect(
        (await s.apply('PUT 1.=1:\n+changed', changed.sections[0].fileHash)).sections[0].op,
      ).toBe('noop')
  },
  async () => {
    for (let run = 0; run < 2; run++) {
      const s = session()
      for (let i = 0; i < 2; i++)
        expect((await s.apply('PUT 1.=1:\n+same')).sections[0].op).toBe('noop')
    }
  },
]
for (const [i, entry] of fixtures
  .find((fixture) => fixture.name === 'parity_hashline_loop_guard.json')!
  .cases.entries()) {
  test(`parity_hashline_loop_guard.json: ${entry.name}`, async () => {
    expect(noopScenarios[i]).toBeTypeOf('function')
    await noopScenarios[i]()
  })
}

const snapshotScenarios: Record<string, () => void> = {
  'derives the tag from whole-file content (matches computeFileHash)': () => {
    const store = new InMemorySnapshotStore()
    expect(store.record('a', 'L1\nL2\n')).toBe(computeFileHash('L1\nL2\n'))
  },
  'fuses repeated reads of identical content onto one tag': () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record('a', 'same')
    const snapshot = store.head('a')
    expect(store.record('a', 'same')).toBe(tag)
    expect(store.head('a')).toBe(snapshot)
  },
  'mints a new tag when content changes and retains the prior version': () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record('a', 'old')
    expect(store.record('a', 'new')).not.toBe(tag)
    expect(store.byHash('a', tag)?.text).toBe('old')
  },
  'promotes a re-observed older version back to head': () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record('a', 'old')
    store.record('a', 'new')
    store.record('a', 'old')
    expect(store.head('a')?.hash).toBe(tag)
  },
  'bounds per-path history to maxVersionsPerPath (oldest dropped)': () => {
    const store = new InMemorySnapshotStore({ maxVersionsPerPath: 2 })
    const tag = store.record('a', 'first')
    store.record('a', 'second')
    store.record('a', 'third')
    expect(store.byHash('a', tag)).toBeNull()
  },
  'bounds tracked paths to maxPaths (cold path evicted)': () => {
    const store = new InMemorySnapshotStore({ maxPaths: 1 })
    store.record('a', 'first')
    store.record('b', 'second')
    expect(store.head('a')).toBeNull()
  },
  'keeps an early tag resolvable across a wide session at default capacity': () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record('a', 'first')
    for (let i = 0; i < 100; i++) store.record(`file${i}`, `text${i}`)
    expect(store.byHash('a', tag)?.text).toBe('first')
  },
  'rejects cross-path lookups': () => {
    const store = new InMemorySnapshotStore()
    expect(store.byHash('b', store.record('a', 'first'))).toBeNull()
  },
  'invalidate drops one path; clear drops everything': () => {
    const store = new InMemorySnapshotStore()
    store.record('a', 'first')
    store.record('b', 'second')
    store.invalidate('a')
    expect(store.head('a')).toBeNull()
    expect(store.head('b')?.text).toBe('second')
    store.clear()
    expect(store.head('b')).toBeNull()
  },
  'relocate moves version history and read provenance to a new path': () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record('a', 'first', [1])
    store.relocate('a', 'b')
    expect(store.head('a')).toBeNull()
    expect(store.byHash('b', tag)?.seenLines).toEqual(new Set([1]))
  },
  'findByHash returns every retained version with that tag across paths': () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record('a', 'same')
    store.record('b', 'same')
    expect(
      store
        .findByHash(tag)
        .map((snapshot) => snapshot.path)
        .toSorted(),
    ).toEqual(['a', 'b'])
  },
  'keeps two colliding texts as separate versions with separate seenLines': () => {
    const store = new InMemorySnapshotStore()
    const a = 'line one 263\nline two 4471\n',
      b = 'line one 410\nline two 6970\n'
    expect(store.record('a', a, [1])).toBe(store.record('a', b, [2]))
    expect(store.byContent('a', a)?.seenLines).toEqual(new Set([1]))
    expect(store.byContent('a', b)?.seenLines).toEqual(new Set([2]))
  },
  'still fuses identical repeated reads of one colliding text onto one snapshot': () => {
    const store = new InMemorySnapshotStore()
    const a = 'line one 263\nline two 4471\n',
      b = 'line one 410\nline two 6970\n'
    store.record('a', a, [1])
    store.record('a', b, [2])
    store.record('a', a, [2])
    expect(store.byContent('a', a)?.seenLines).toEqual(new Set([1, 2]))
  },
}
for (const entry of fixtures.find((fixture) => fixture.name === 'parity_snapshots.json')!.cases) {
  test(`parity_snapshots.json: ${entry.name}`, () => {
    expect(snapshotScenarios[entry.name]).toBeTypeOf('function')
    snapshotScenarios[entry.name]()
  })
}

const recoveryScenarios = [
  { previous: 'a\nb\nc\n', current: 'a\nCHANGED\nc\n', input: 'PUT 2.=2:\n+B', expected: null },
  {
    previous: 'a\nb\nc\n',
    current: 'external\na\nb\nc\n',
    input: 'PUT 2.=2:\n+B',
    expected: 'external\na\nB\nc\n',
  },
  {
    previous: 'a\nb\nc\n',
    current: 'new\na\nb\nc\n',
    input: 'PUT 2.=2:\n+B',
    expected: 'new\na\nB\nc\n',
    chain: true,
  },
  {
    previous: 'gone\na\nb\nc\n',
    current: 'a\nb\nc\n',
    input: 'PUT 3.=3:\n+B',
    expected: 'a\nB\nc\n',
    chain: true,
  },
  {
    previous: 'x\ndup\ny\ndup\nz\n',
    current: 'unrelated\ndup\nother\ndup\nchanged\n',
    input: 'PUT 2.=2:\n+B',
    expected: null,
  },
  {
    previous: 'x\ndup\ny\ndup\nz\n',
    current: 'unrelated\ndup\nother\ndup\nchanged\n',
    input: 'PUT 2.=3:\n+B',
    expected: null,
  },
  {
    previous: 'before\nunique\nafter\n',
    current: 'different\nunique\nchanged\n',
    input: 'PUT 2.=2:\n+B',
    expected: null,
  },
  {
    previous: 'x\ndup\ny\ndup\nz\n',
    current: 'new\nx\ndup\ny\ndup\nz\n',
    input: 'PUT 2.=2:\n+B',
    expected: 'new\nx\nB\ny\ndup\nz\n',
    chain: true,
  },
  {
    previous: 'line one 410\nline two 6970\n',
    current: 'line one 410\nline two 6970\nextra\n',
    input: 'PUT 1.=1:\n+B',
    // Ultimate refuses ambiguity instead of choosing a collider by recency.
    expected: null,
    collision: true,
  },
  {
    previous: 'a\nb\nc\n',
    current: 'a\nb\nc\nextra\n',
    input: 'PUT 2.=2:\n+B',
    expected: 'a\nB\nc\nextra\n',
  },
  {
    previous: 'a\n\ud800\nc\n',
    current: 'extra\na\n\ud800\nc\n',
    input: 'PUT 2.=2:\n+B',
    expected: 'extra\na\nB\nc\n',
  },
]
for (const [i, entry] of fixtures
  .find((fixture) => fixture.name === 'parity_recovery_session_chain.json')!
  .cases.entries()) {
  test(`parity_recovery_session_chain.json: ${entry.name}${recoveryScenarios[i].collision ? ' [Ultimate refuses ambiguous tags]' : ''}`, () => {
    const scenario = recoveryScenarios[i]
    const store = new InMemorySnapshotStore()
    if (scenario.collision) store.record('a.txt', 'line one 263\nline two 4471\n')
    const tag = store.record('a.txt', scenario.previous)
    if (scenario.chain) store.record('a.txt', scenario.current)
    const result = new Recovery(store).tryRecover({
      path: 'a.txt',
      fileHash: tag,
      currentText: scenario.current,
      edits: parsePatch(scenario.input).edits,
    })
    expect(result?.text ?? null).toBe(scenario.expected)
  })
}

for (const input of ['PUT 2*:\n+replacement', 'CUT 2*', 'PUT >2*:\n+inserted'])
  test(`block resolver seam: ${input}`, async () => {
    const s = session('head\nopen\nbody\nclose\ntail\n')
    const patcher = new Patcher({
      fs: s.fs,
      snapshots: s.snapshots,
      blockResolver: () => ({ start: 2, end: 4 }),
    })
    const result = await patcher.apply(Patch.parse(`[a.txt#${s.tag}]\n${input}`))
    const expected = input.startsWith('CUT')
      ? 'head\ntail\n'
      : input.startsWith('PUT >')
        ? 'head\nopen\nbody\nclose\ninserted\ntail\n'
        : 'head\nreplacement\ntail\n'
    expect(result.sections[0].after).toBe(expected)
  })
test('block resolver absence fails clearly; after-block insertion falls back with a warning', () => {
  const edits = parsePatch('PUT 2*:\n+replacement').edits
  expect(() =>
    resolveBlockEdits(edits, 'head\nopen\nbody', 'a.txt', undefined, { onUnresolved: 'throw' }),
  ).toThrow('block')
  const warnings: string[] = []
  const fallback = resolveBlockEdits(
    parsePatch('PUT >2*:\n+inserted').edits,
    'head\nopen\nbody',
    'a.txt',
    undefined,
    { onUnresolved: 'throw', onWarning: (warning) => warnings.push(warning) },
  )
  expect(applyEdits('head\nopen\nbody', fallback).text).toBe('head\nopen\ninserted\nbody')
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('PUT >2')
})

const diffCases = JSON.parse(
  readFileSync(
    new URL('../extensions/hashline/test/fixtures/parity_diff_preview.json', import.meta.url),
    'utf8',
  ),
) as { cases: { name: string; input: string; expect: unknown }[] }
for (const entry of diffCases.cases)
  test(`parity_diff_preview.json: ${entry.name}`, () => {
    expect(buildCompactDiffPreview(entry.input)).toEqual(entry.expect)
  })

for (const [name, body] of [
  [
    'parity_block.json: applyPartialTo drops an unresolvable block edit instead of throwing',
    'PUT 2*:\n+changed',
  ],
  ['parity_block.json: applyPartialTo drops an unresolvable cut-block edit', 'CUT 2*'],
  [
    'parity_clipboard.json: drops an empty-register PUT on the streaming-tolerant path',
    'PUT >2 @empty',
  ],
])
  test(`streaming tolerance: ${name}`, () => {
    expect(
      Patch.parseSingle(`[a.txt#ABCD]\n${body}`).applyPartialTo('one\ntwo\nthree\n').text,
    ).toBe('one\ntwo\nthree\n')
  })

test('format and streaming contracts from Rust parity harness', () => {
  expect(Patch.parseSingle('[a.txt#f27c]\nPUT 1.=1:\n+new').fileHash).toBe('F27C')
  expect(detectLineEnding('a\r\nb\nc')).toBe('\r\n')
  expect(detectLineEnding('a\nb\r\nc')).toBe('\n')
  expect(splitAddressableFileLines('a\nb\n')).toEqual(['a', 'b'])
  expect(splitAddressableFileLines('a\nb\n\n')).toEqual(['a', 'b', ''])
  expect(formatNumberedLines('a\n', 1)).toBe('1:a\n2:')
  expect(formatHashlineHeader('a.txt', 'ABCD')).toBe('[a.txt#ABCD]')
  expect(parsePatchStreaming('PUT 5-5:\n').edits).toEqual([])
  expect(parsePatchStreaming('CUT 2\nPUT >$:\n').edits).toHaveLength(2)
})

test('recovery refuses a replacement aimed at current authored numbers', () => {
  const previous =
    'alpha = oldValue();\nreturn completelyDifferentResult + 17382;\ngamma = thirdValue();\n'
  const current = `new preface\n${previous}`
  const store = new InMemorySnapshotStore()
  const tag = store.record('a.txt', previous)
  const result = new Recovery(store).tryRecover({
    path: 'a.txt',
    currentText: current,
    fileHash: tag,
    edits: parsePatch('PUT 2.=2:\n+alpha = newValue();').edits,
  })
  expect(result).toBeNull()
})

test('recovery refuses moving an anchor into a different enclosing construct', () => {
  const store = new InMemorySnapshotStore()
  const before = 'old opener\nanchor\nend\n'
  const current = 'new opener\nanchor\nend\n'
  const tag = store.record('a.txt', before)
  setSyntaxProbe({
    nodeChain: () => [{ kind: 'function', startLine: 1, endLine: 3 }],
    enclosingBoundaries: () => [],
    parsesCleanly: () => false,
  })
  try {
    expect(
      new Recovery(store).tryRecover({
        path: 'a.txt',
        currentText: current,
        fileHash: tag,
        edits: parsePatch('PUT 2.=2:\n+replacement').edits,
      }),
    ).toBeNull()
  } finally {
    setSyntaxProbe()
  }
})

test('shifted recovery that breaks parsing refuses without publishing CUT registers', () => {
  const before = 'head\nanchor\ntail\n'
  const current = `preface\n${before}`
  const store = new InMemorySnapshotStore()
  const tag = store.record('a.txt', before)
  const clipboard = { named: new Map([['keep', ['original']]]) }
  setSyntaxProbe({
    nodeChain: () => [],
    enclosingBoundaries: () => [],
    parsesCleanly: (_, text) => !text.includes('BROKEN'),
  })
  try {
    expect(
      new Recovery(store).tryRecover({
        path: 'a.txt',
        currentText: current,
        fileHash: tag,
        clipboard,
        edits: parsePatch('CUT 2 @taken\nPUT >2:\n+BROKEN').edits,
      }),
    ).toBeNull()
    expect(clipboard.named).toEqual(new Map([['keep', ['original']]]))
  } finally {
    setSyntaxProbe()
  }
})

test('seen-line reveal supplies actual rows and permits a same-tag retry', async () => {
  const s = session('one\ntwo\nthree\n', [1])
  await expect(s.apply('PUT 2.=2:\n+TWO')).rejects.toThrow('2:two')
  expect(s.fs.get('a.txt')).toBe('one\ntwo\nthree\n')
  expect(s.snapshots.head('a.txt')?.seenLines).toEqual(new Set([1, 2]))
  expect((await s.apply('PUT 2.=2:\n+TWO')).sections[0].after).toBe('one\nTWO\nthree\n')
})

test('seen-line reveal cap never promotes a partially revealed range', async () => {
  const source = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n')
  const s = session(source, [1])
  await expect(s.apply('CUT 2.=45')).rejects.toThrow('re-read')
  expect(s.snapshots.head('a.txt')?.seenLines).toEqual(new Set([1]))
})

test('wide unseen lines require a full read and are not leaked into the error', async () => {
  const s = session(`one\n${'x'.repeat(600)}\n`, [1])
  await expect(s.apply('PUT 2.=2:\n+short')).rejects.toThrow('not fully displayed')
  expect(s.snapshots.head('a.txt')?.seenLines).toEqual(new Set([1]))
})

test('without retained provenance, even live short tags require a read', async () => {
  const s = session(`${'x'.repeat(600)}\nshort\n`)
  s.snapshots.clear()
  await expect(s.apply('PUT 1.=1:\n+short')).rejects.toThrow('not from this session')
  s.snapshots.clear()
  await expect(s.apply('PUT 2.=2:\n+changed')).rejects.toThrow('not from this session')
  s.snapshots.record('a.txt', `${'x'.repeat(600)}\nshort\n`, [2])
  expect((await s.apply('PUT 2.=2:\n+changed')).sections[0].after).toBe(
    `${'x'.repeat(600)}\nchanged\n`,
  )
})

test('seen guard off accepts an unseen anchor; block replace guards the whole resolved span', async () => {
  const s = session('one\ntwo\nthree\n', [1])
  const guarded = new Patcher({
    fs: s.fs,
    snapshots: s.snapshots,
    blockResolver: () => ({ start: 1, end: 3 }),
  })
  await expect(guarded.apply(Patch.parse(`[a.txt#${s.tag}]\nPUT 1*:\n+new`))).rejects.toThrow(
    'lines 2-3',
  )
  const unguarded = new Patcher({ fs: s.fs, snapshots: s.snapshots, enforceSeenLines: false })
  expect(
    (await unguarded.apply(Patch.parse(`[a.txt#${s.tag}]\nPUT 3.=3:\n+THREE`))).sections[0].after,
  ).toBe('one\ntwo\nTHREE\n')
})

test('mismatch carries current tag and context rows without writing', async () => {
  const s = session('one\ntwo\nthree\n')
  s.fs.set('a.txt', 'one\nexternal\nthree\n')
  await expect(s.apply('PUT 2.=2:\n+TWO')).rejects.toThrow('2:external')
  await expect(s.apply('PUT 2.=2:\n+TWO')).rejects.toThrow(
    `#${computeFileHash('one\nexternal\nthree\n')}`,
  )
  expect(s.fs.writes).toBe(0)
})

test('xxHash32 seed-zero reference vectors and whitespace-normalized native tag', () => {
  expect(xxhash32('')).toBe(0x02cc5d05)
  expect(xxhash32('a')).toBe(0x550d7456)
  expect(xxhash32('abc')).toBe(0x32d153ff)
  expect(computeFileHash('a \t\r\nb\t\n')).toBe(computeFileHash('a\nb\n'))
})

test('native tag known value', () => {
  expect(computeFileHash('def greet(name):\n    print("Hello, " + name)\n\ngreet("world")\n')).toBe(
    '0BE8',
  )
})
