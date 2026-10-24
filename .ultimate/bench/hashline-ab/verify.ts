// Adapted from oh-my-pi's MIT edit benchmark verifier/formatter; see LICENSE.omp.
import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { diffLines, createTwoFilesPatch } from 'diff'
import { format, type BuiltInParserName } from 'prettier'

export async function files(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    if (!prefix && ['.git', '.ultimate'].includes(entry.name)) continue
    const name = join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...(await files(root, name)))
    else result.push(name)
  }
  return result.toSorted()
}
const parsers: Record<string, BuiltInParserName> = {
  '.js': 'flow',
  '.jsx': 'flow',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.mdx': 'mdx',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
}
const lines = (text: string) =>
  text.split('\n').filter((line, i, all) => i < all.length - 1 || line)
const normalize = (text: string) => text.replace(/\r\n?/g, '\n')
function restoreWhitespace(expected: string, actual: string) {
  const output: string[] = []
  let removed: string[] = [],
    added: string[] = []
  const flush = () => {
    for (let i = 0; i < added.length; i++) {
      const a = added[i],
        e = removed[i]
      output.push(e !== undefined && e.replace(/\s+/g, '') === a.replace(/\s+/g, '') ? e : a)
    }
    removed = []
    added = []
  }
  for (const part of diffLines(expected, actual)) {
    if (part.removed) removed.push(...lines(part.value))
    else if (part.added) added.push(...lines(part.value))
    else {
      flush()
      output.push(...lines(part.value))
    }
  }
  flush()
  return output.join('\n') + (actual.endsWith('\n') ? '\n' : '')
}
async function formatted(file: string, text: string) {
  text = text.replace(/\n{3,}/g, '\n\n')
  if (parsers[extname(file)]) {
    try {
      text = await format(text, {
        parser: parsers[extname(file)],
        printWidth: 100,
        tabWidth: 2,
        useTabs: false,
        semi: true,
        singleQuote: true,
        quoteProps: 'as-needed',
        trailingComma: 'all',
        bracketSpacing: true,
        arrowParens: 'always',
        endOfLine: 'lf',
        proseWrap: 'preserve',
      })
    } catch {
      /* Upstream deliberately compares raw content when parsing fails (mutated syntax). */
    }
  }
  return /\.(md|mdx|yml|yaml)$/i.test(file)
    ? text
    : text
        .split('\n')
        .filter((line) => line.trim())
        .join('\n')
}

/**
 * Off-target changes outside the mutated region: `content` when a non-blank line was added or removed there,
 * `blank` when only blank lines were (a seam left by an otherwise correct edit).
 */
export function outsideRegion(expected: string, actual: string, start: number, length: number) {
  const found = { content: false, blank: false }
  let line = 1
  for (const part of diffLines(normalize(expected), normalize(actual))) {
    const count = part.count ?? 0
    // Insertions are anchored at the following expected line (end boundary allowed).
    const outside = part.added
      ? line < start || line > start + length
      : part.removed && (line < start || line + count > start + length)
    if (outside) found[part.value.trim() === '' ? 'blank' : 'content'] = true
    if (!part.added) line += count
  }
  return found
}

export async function verify(fixture: string, project: string) {
  const expectedFiles = await files(join(fixture, 'expected'))
  const actualFiles = await files(project)
  const metadata = JSON.parse(await readFile(join(fixture, 'metadata.json'), 'utf8'))
  const start = metadata.line_number ?? metadata.lineNumber
  const snippet = metadata.original_snippet ?? metadata.originalSnippet
  if (!Number.isInteger(start) || typeof snippet !== 'string')
    throw new Error('Unknown mutation metadata')
  const targets = expectedFiles.filter(
    (file) => basename(file) === basename(metadata.file_path ?? metadata.filePath),
  )
  if (targets.length !== 1) throw new Error('Ambiguous metadata target')
  let pass = JSON.stringify(expectedFiles) === JSON.stringify(actualFiles)
  let wrongTarget = false,
    blankSeam = false,
    diff = ''
  for (const file of new Set([...expectedFiles, ...actualFiles])) {
    const e = expectedFiles.includes(file)
      ? normalize(await readFile(join(fixture, 'expected', file), 'utf8'))
      : ''
    const a = actualFiles.includes(file)
      ? normalize(await readFile(join(project, file), 'utf8'))
      : ''
    if (e !== a) {
      diff += createTwoFilesPatch(`expected/${file}`, `actual/${file}`, e, a)
      if (file !== targets[0]) wrongTarget = true
      else {
        const outside = outsideRegion(e, a, start, lines(snippet).length)
        wrongTarget ||= outside.content
        blankSeam ||= outside.blank
      }
    }
    if ((await formatted(file, e)) !== (await formatted(file, restoreWhitespace(e, a))))
      pass = false
  }
  return { pass, wrongTarget, blankSeam, diff }
}
