import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClassifyQuestion, ClassifyService } from '../extensions/classify/api.ts'
import { find, NO_CLASSIFY, OPT_IN } from '../extensions/find/cascade.ts'
import { eligible, readText } from '../extensions/find/files.ts'
import type { Source } from '../extensions/find/files.ts'
import { keywords } from '../extensions/find/lexical.ts'
import { sendsSource } from '../extensions/find/server.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

it('admits source files and drops credentials, binaries, hidden files, build output and empty files', () => {
  const admitted = ['src/lander.ts', 'README.md', 'Makefile', 'docs/keys.md']
  expect(admitted.filter((rel) => !eligible(rel, 10))).toEqual([])
  const refused = [
    '.env',
    'config/.env.local',
    'certs/server.pem',
    'tls.key',
    'store.p12',
    'store.pfx',
    'app.keystore',
    'id_rsa',
    'id_rsa.pub',
    'lib/secrets.ts',
    'aws_credentials.json',
    'secrets.json',
    '.npmrc',
    '.netrc',
    'logo.png',
    'font.woff2',
    'app.min.js',
    'pnpm-lock.yaml',
    'Cargo.lock',
    '.github/workflows/ci.yml',
    'node_modules/pkg/index.js',
    'dist/index.js',
  ]
  expect(refused.filter((rel) => eligible(rel, 10))).toEqual([])
  expect(eligible('src/empty.ts', 0)).toBe(false)
})

it('reads text up to the limit at a line boundary and refuses binaries', async () => {
  const root = await temp()
  cleanup.push(root)
  await writeFile(join(root, 'blob'), Buffer.from([0x61, 0x00, 0x62]))
  await writeFile(join(root, 'blank.ts'), '\n  \n')
  await writeFile(join(root, 'long.ts'), 'one\ntwo\nthree\n')
  expect(await readText(join(root, 'blob'), 100)).toBeUndefined()
  expect(await readText(join(root, 'blank.ts'), 100)).toBeUndefined()
  expect(await readText(join(root, 'long.ts'), 10)).toEqual({ text: 'one\ntwo\n', truncated: true })
  expect(await readText(join(root, 'long.ts'), 100)).toEqual({
    text: 'one\ntwo\nthree\n',
    truncated: false,
  })
})

it('derives keywords: drops stopwords, short tokens and numbers, stems, adds extras once', () => {
  expect(
    keywords('where the lander merges and fast-forwards main in 2 steps', [
      'fastForward',
      'lander',
    ]),
  ).toEqual(['lander', 'merg', 'fast', 'forward', 'main', 'step', 'fastforward'])
})

it('reads the opt-in from project settings only when it is exactly true', () => {
  expect(sendsSource({ find: { sendSource: true } })).toBe(true)
  expect(sendsSource({ find: { sendSource: 'yes' } })).toBe(false)
  expect(sendsSource({})).toBe(false)
})

/** An in-memory source over `files`. */
function memory(files: Record<string, string>): Source & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    list: async () =>
      Object.entries(files)
        .map(([rel, text]) => ({ rel, size: text.length }))
        .toSorted((a, b) => (a.rel < b.rel ? -1 : 1)),
    async scan(words) {
      return Object.entries(files).flatMap(([rel, text]) =>
        text
          .split('\n')
          .flatMap((line, at) =>
            words.some((word) => line.toLowerCase().includes(word))
              ? [{ rel, line: at + 1, text: line }]
              : [],
          ),
      )
    },
    async read(rel) {
      reads.push(rel)
      return { text: files[rel], truncated: false }
    },
  }
}

type Asked = {
  kind: 'name' | 'sketch' | 'passage'
  state: Record<string, unknown>
  questions: Record<string, ClassifyQuestion>
}

/** A judge that says yes to the lander by name and to passages that call fastForward. */
function scripted() {
  const asked: Asked[] = []
  const service: ClassifyService = {
    async ask({ state, questions }) {
      const record = state as Record<string, unknown>
      const kind = 'tree' in record ? 'name' : 'files' in record ? 'sketch' : 'passage'
      asked.push({ kind, state: record, questions })
      const answers: Record<string, { type: 'noul'; noul: number }> = {}
      for (const key of Object.keys(questions)) {
        let p = 0.05
        if (kind === 'name') {
          const name = /\("([^"]+)"\)/.exec(questions[key].instructions as string)![1]
          p = name.startsWith('lander') ? 0.9 : 0.1
        } else if (kind === 'sketch') {
          const [, text] = (record.passages as Record<string, [string, string]>)[key]
          p = text.includes('fastForward(') ? 0.8 : 0.1
        } else {
          const text = (record.passages as Record<string, string>)[key]
          p = text.includes('fastForward(') ? 0.93 : 0.1
        }
        answers[key] = { type: 'noul', noul: p }
      }
      return { model: 'jev-test', answers, usage: { inputTokens: 1000 } }
    },
  }
  return { asked, service }
}

/** A repository: the lander, many decoys mentioning the keywords, and a test that only calls it. */
function repository() {
  const files: Record<string, string> = {}
  const filler = Array.from({ length: 30 }, (_, at) => `const pad${at} = ${at}`).join('\n')
  files['src/lander.ts'] =
    `${filler}\nexport function land(branch) {\n  merge(branch)\n  fastForward(main)\n}\n${filler}\n`
  for (let at = 0; at < 200; at++)
    files[`src/decoy${String(at).padStart(3, '0')}.ts`] =
      `// merges main into the lander queue\n${filler}\n`
  files['test/lander.test.ts'] = `it('lands', () => land('x'))\n`
  return files
}

it('ranks verified ranges through the three waves and respects the caps', async () => {
  const source = memory(repository())
  const { asked, service } = scripted()
  const { text, details } = await find({
    query: 'where the lander merges and fast-forwards main',
    keywords: ['fastForward'],
    project: 'repo',
    source,
    classify: service,
    sendSource: true,
  })
  const kinds = (kind: Asked['kind']) => asked.filter((request) => request.kind === kind)
  // 202 files listed, 128 judged by name in two batches of 64.
  expect(details.stats.listed).toBe(202)
  expect(details.stats.judged).toBe(128)
  expect(kinds('name').map((request) => Object.keys(request.questions).length)).toEqual([64, 64])
  expect(source.reads.length).toBe(20)
  expect(source.reads).toContain('src/lander.ts')
  for (const request of kinds('sketch'))
    expect(Object.keys(request.questions).length).toBeLessThanOrEqual(46)
  // Only the lander's sketch clears 0.45, so one passage is verified.
  expect(kinds('passage')).toHaveLength(1)
  for (const request of kinds('passage'))
    expect(String(request.state.untrusted)).toContain('untrusted')
  expect(details.mode).toBe('semantic')
  expect(details.hits).toEqual([
    {
      path: 'src/lander.ts',
      score: 0.93,
      ranges: [{ start: 1, end: 64, p: 0.93, snippet: 'fastForward(main)' }],
    },
  ])
  expect(details.stats.requests).toBe(asked.length)
  expect(details.stats.inputTokens).toBe(asked.length * 1000)
  expect(details.stats.cost).toBeCloseTo(asked.length * 1000 * 0.042e-6)
  expect(text.split('\n').slice(0, 4)).toEqual([
    '1 hit for "where the lander merges and fast-forwards main", strongest first',
    '',
    'src/lander.ts  0.93',
    '  src/lander.ts:1-64  0.93  fastForward(main)',
  ])
  expect(text).toMatch(
    /listed 202 files · judged 128 · \d+ requests · .* sent · [\d,]+ input tokens · \$0\.\d{4} · /,
  )
})

it('caps verification at 40 passages, 3 per request', async () => {
  const files: Record<string, string> = {}
  // 20 of these files are read, 3 windows each, all calling fastForward: 60 passages pass the sketch cut.
  const line = `fastForward(main) ${'x'.repeat(200)}`
  for (let at = 0; at < 30; at++)
    files[`src/lander${at}.ts`] = Array.from({ length: 100 }, () => line).join('\n')
  const { asked, service } = scripted()
  await find({
    query: 'fast forward main',
    project: 'repo',
    source: memory(files),
    classify: service,
    sendSource: true,
  })
  const verified = asked.filter((request) => request.kind === 'passage')
  expect(verified.reduce((sum, request) => sum + Object.keys(request.questions).length, 0)).toBe(40)
  for (const request of verified)
    expect(Object.keys(request.questions).length).toBeLessThanOrEqual(3)
})

it('sends nothing without the opt-in or without classify, and says why', async () => {
  const ask = vi.fn<ClassifyService['ask']>()
  for (const [options, reason] of [
    [{ classify: { ask }, sendSource: false }, OPT_IN],
    [{ classify: undefined, sendSource: true }, NO_CLASSIFY],
  ] as const) {
    const { text, details } = await find({
      query: 'where the lander fast-forwards main',
      project: 'repo',
      source: memory(repository()),
      ...options,
    })
    expect(text.split('\n')[0]).toBe(reason)
    expect(details.mode).toBe('lexical')
    expect(details.hits[0].path).toBe('src/lander.ts')
    expect(details.hits[0].ranges).toEqual([{ start: 33, end: 33, snippet: 'fastForward(main)' }])
    expect(text).toContain('nothing sent')
  }
  expect(ask).not.toHaveBeenCalled()
})
