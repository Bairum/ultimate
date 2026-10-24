import { beforeAll, expect, test, vi } from 'vitest'
import {
  prepareSyntax,
  MAX_SYNTAX_BYTES,
  contentEndLine,
  treeSitterBlockResolver as resolve,
  treeSitterProbe as probe,
} from '../extensions/hashline/parser.ts'
import { applyEdits, resolveBlockEdits, parsePatch } from '../extensions/hashline/engine/index.ts'

const coldText = 'function f() {\n}\n'
const coldParse = probe.parsesCleanly('a.ts', coldText)
const coldBlock = resolve({ path: 'a.ts', text: coldText, line: 1 })
beforeAll(async () => {
  await Promise.all([prepareSyntax(['a.ts']), prepareSyntax(['a.ts'])])
  await prepareSyntax([
    'a.ts',
    'a.tsx',
    'a.js',
    'a.py',
    'a.rs',
    'a.go',
    'a.json',
    'a.css',
    'a.sh',
    'a.yaml',
    'a.md',
    'a.lua',
    'a.el',
  ])
})

test('import stays cold; concurrent first-use initialization supplies syntax evidence', () => {
  expect(coldParse).toBe(false)
  expect(coldBlock).toBeNull()
  expect(probe.parsesCleanly('a.ts', coldText)).toBe(true)
})

test.each([
  ['x.ts', 'function f() {\n  return 1\n}\n', 1, 3],
  ['x.tsx', 'const f = () => (\n  <div />\n)\n', 1, 3],
  ['x.js', 'function f() {\n  return 1\n}\n', 1, 3],
  ['x.py', '@cache\n@other\ndef f():\n    return 1\n', 1, 4],
  ['x.rs', 'struct B {\n    x: u32,\n}\n', 1, 3],
  ['x.go', 'package p\nfunc f() {\n  x()\n}\n', 2, 4],
  ['x.json', '{\n  "key": 1\n}\n', 1, 3],
  ['x.css', 'div {\n  color: red;\n}\n', 1, 3],
  ['x.sh', 'if true; then\n  echo ok\nfi\n', 1, 3],
  ['x.yaml', 'jobs:\n  build:\n    runs-on: ubuntu\nother: 2\n', 1, 3],
  ['x.md', '# One\nbody\n## Two\nbody\n# Three\nbody\n', 1, 4],
  ['x.lua', 'function f()\n  return 1\nend\n', 1, 3],
  ['x.el', '(defun f ()\n  (message "ok"))\n', 1, 2],
] as const)('loads %s grammar and resolves its block', (path, text, line, end) => {
  expect(probe.parsesCleanly(path, text)).toBe(true)
  expect(resolve({ path, text, line })).toEqual({ start: line, end })
})

test('a leading Python statement never absorbs siblings or trailing comments', () => {
  const text = 'def f(x):\n    if x:\n        return 1\n    # comment\n    y = 2\n    return y\n'
  expect(resolve({ path: 'x.py', text, line: 2 })).toEqual({ start: 2, end: 3 })
  expect(resolve({ path: 'x.py', text: 'def f():\n    y = 2\n    # trailing\n', line: 2 })).toEqual(
    { start: 2, end: 2 },
  )
})

test('decorators group only when the grammar groups them; standalone comments and Rust attributes are not swept', () => {
  const text = '// standalone\n#[inline]\nfn f() {\n    g();\n}\n'
  expect(resolve({ path: 'x.rs', text, line: 1 })).toEqual({ start: 1, end: 1 })
  expect(resolve({ path: 'x.rs', text, line: 2 })).toEqual({ start: 2, end: 2 })
  expect(resolve({ path: 'x.rs', text, line: 3 })).toEqual({ start: 3, end: 5 })
  expect(probe.nodeChain(text.split('\n'), 'x.rs', 2)[0]?.kind).toBe('attribute_item')
  const decorated = '@one\n@two\nclass A {\n  f() {}\n}\n'
  expect(resolve({ path: 'x.ts', text: decorated, line: 1 })).toEqual({ start: 1, end: 5 })
  const doc = '/** doc\n * more */\nfunction f() {\n}\n'
  expect(resolve({ path: 'x.ts', text: doc, line: 1 })).toEqual({ start: 1, end: 2 })
})

test('block replacement refuses closers, blank, single-line and ambiguous multi-statement anchors', () => {
  const text = 'function f() {\n\n  x(); y();\n}\n'
  for (const line of [2, 3, 4]) {
    expect(() =>
      resolveBlockEdits(parsePatch(`PUT ${line}*:\n+replacement`).edits, text, 'x.ts', resolve),
    ).toThrow(/could not resolve|single-line block/)
  }
  expect(resolve({ path: 'x.ts', text, line: 0 })).toBeNull()
  expect(resolve({ path: 'x.ts', text, line: 100 })).toBeNull()
  expect(resolve({ path: 'x.ts', text: 'function f() {\n', line: 1 })).toBeNull()
})

test('syntax errors elsewhere do not disable healthy block resolution or node chains', () => {
  const text = 'function f() {\n  return 1\n}\nfunction broken( {\n'
  expect(resolve({ path: 'x.ts', text, line: 1 })).toEqual({ start: 1, end: 3 })
  expect(
    probe
      .nodeChain(text.split('\n'), 'x.ts', 1)
      .some((node) => node.kind === 'function_declaration'),
  ).toBe(true)
  expect(probe.parsesCleanly('x.ts', text)).toBe(false)
  expect(probe.enclosingBoundaries(text.split('\n'), 'x.ts', 1, 1)).toEqual([])
})

test('boundaries expose only the opposite endpoint outside the visible range', () => {
  const lines = ['function f() {', '  x()', '  y()', '}']
  expect(probe.enclosingBoundaries(lines, 'x.ts', 1, 1)).toEqual([4])
  expect(probe.enclosingBoundaries(lines, 'x.ts', 4, 4)).toEqual([1])
  expect(probe.enclosingBoundaries(lines, 'x.ts', 2, 3)).toEqual([])
  expect(probe.enclosingBoundaries(lines, 'x.ts', 1, 4)).toEqual([])
})

test.each([
  ['Intro paragraph.\n\nSecond paragraph with notes.\n\n- keep me\n\n# Heading\nbody\n', 1],
  ['First paragraph\ncontinues here.\n\nSecond paragraph\n\n# Heading\nbody\n', 2],
  ['- first\n- second\n\nAnother paragraph\n\n# Heading\nbody\n', 2],
  ['```ts\nconst x = 1\n```\n\nAnother paragraph\n\n# Heading\nbody\n', 3],
] as const)('leading Markdown content resolves only its own span: %s', (text, end) => {
  expect(resolve({ path: 'x.md', text, line: 1 })).toEqual({ start: 1, end })
})

test('a leading one-line Markdown paragraph cannot escape single-line refusal', () => {
  const text = 'Intro paragraph.\n\nSecond paragraph with notes.\n\n- keep me\n\n# Heading\nbody\n'
  expect(() => resolveBlockEdits(parsePatch('CUT 1*').edits, text, 'x.md', resolve)).toThrow(
    'single-line block',
  )
})

test('over-cap UTF-8 source supplies no evidence', () => {
  const suffix = '\nfunction f() {\n}\n'
  const boundary = `//${'x'.repeat(MAX_SYNTAX_BYTES - 2 - suffix.length)}${suffix}`
  expect(Buffer.byteLength(boundary)).toBe(MAX_SYNTAX_BYTES)
  expect(probe.parsesCleanly('x.ts', boundary)).toBe(true)
  const text = `// ${'é'.repeat(MAX_SYNTAX_BYTES / 2)}\nfunction f() {\n}\n`
  expect(text.length).toBeLessThan(MAX_SYNTAX_BYTES)
  expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_SYNTAX_BYTES)
  expect(probe.parsesCleanly('x.ts', text)).toBe(false)
  expect(probe.nodeChain(text.split('\n'), 'x.ts', 2)).toEqual([])
  expect(probe.enclosingBoundaries(text.split('\n'), 'x.ts', 2, 2)).toEqual([])
  expect(resolve({ path: 'x.ts', text, line: 2 })).toBeNull()
})

test.each([
  [{ row: 0, column: 0 }, 1],
  [{ row: 1, column: 0 }, 1],
  [{ row: 1, column: 1 }, 2],
])('content end line follows Rust for %j', (endPosition, expected) => {
  expect(contentEndLine({ endPosition })).toBe(expected)
})

test.each(['runtime', 'grammar'] as const)(
  'a failed %s load provides no evidence and retries',
  async (failure) => {
    vi.resetModules()
    const runtime = await import('web-tree-sitter')
    const spy =
      failure === 'runtime'
        ? vi
            .spyOn(runtime.Parser, 'init')
            .mockRejectedValueOnce(new Error('forced runtime load failure'))
        : vi
            .spyOn(runtime.Language, 'load')
            .mockRejectedValueOnce(new Error('forced grammar load failure'))
    try {
      const fresh = await import('../extensions/hashline/parser.ts')
      const text = 'function f() {\n}\n'
      await fresh.prepareSyntax(['x.ts'])
      expect(fresh.treeSitterProbe.parsesCleanly('x.ts', text)).toBe(false)
      expect(fresh.treeSitterBlockResolver({ path: 'x.ts', text, line: 1 })).toBeNull()
      await fresh.prepareSyntax(['x.ts'])
      expect(fresh.treeSitterProbe.parsesCleanly('x.ts', text)).toBe(true)
      expect(fresh.treeSitterBlockResolver({ path: 'x.ts', text, line: 1 })).toEqual({
        start: 1,
        end: 2,
      })
    } finally {
      spy.mockRestore()
    }
  },
)

const jsonList = '{\n  "a": [\n    "x",\n    "y"\n  ]\n}\n'
test.each(['+    "z",', '+    "z",  \n+'])('names a parse-proved trailing comma: %s', (body) => {
  expect(() =>
    applyEdits(jsonList, parsePatch(`PUT 4.=4:\n${body}`).edits, { path: 'x.json' }),
  ).toThrow('ends with a comma that does not parse in place')
})

test.each([
  ['{\n  "a": [\n    "x"\n  ],\n  "b": 1\n}\n', '  "c": 2,'],
  [jsonList, '    "z",\u00a0'],
])('keeps placement guidance when dropping a comma does not parse', (text, row) => {
  expect(() =>
    applyEdits(text, parsePatch(`PUT 4.=4:\n+${row}`).edits, { path: 'x.json' }),
  ).toThrow('body indentation does not establish')
})

test('unknown languages and absent paths provide no syntax evidence', async () => {
  await prepareSyntax(['x.unknown'])
  const text = 'function f() {\n}\n'
  expect(resolve({ path: 'x.unknown', text, line: 1 })).toBeNull()
  expect(probe.nodeChain(text.split('\n'), 'x.unknown', 1)).toEqual([])
  expect(probe.enclosingBoundaries(text.split('\n'), 'x.unknown', 1, 1)).toEqual([])
  expect(probe.parsesCleanly('x.unknown', text)).toBe(false)
  expect(probe.parsesCleanly(undefined, text)).toBe(false)
})
