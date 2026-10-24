/** Lazy WASM syntax evidence for the synchronous hashline engine. */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Node, Parser, Tree } from 'web-tree-sitter'
import type { BlockResolver } from './engine/types.ts'
import type { SyntaxProbe } from './engine/syntax.ts'
import { setSyntaxProbe } from './engine/syntax.ts'

const require = createRequire(import.meta.url)
const extensions: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.json': 'json',
  '.css': 'css',
  '.sh': 'bash',
  '.bash': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.lua': 'lua',
  '.el': 'elisp',
}
function language(file: string | undefined): string | undefined {
  return (
    file &&
    (path.basename(file) === '.emacs' ? 'elisp' : extensions[path.extname(file).toLowerCase()])
  )
}
const parsers = new Map<string, Parser>()
const loading = new Map<string, Promise<void>>()
let runtime: Promise<typeof import('web-tree-sitter')> | undefined

/** Await before calling the engine. Unknown languages intentionally supply no evidence. */
export async function prepareSyntax(paths: readonly string[]): Promise<void> {
  await Promise.all(
    paths.map(async (file) => {
      const lang = language(file)
      if (!lang) return
      let pending = loading.get(lang)
      if (!pending) {
        pending = (async () => {
          const { Parser, Language } = await (runtime ??= import('web-tree-sitter').then(
            async (module) => {
              await module.Parser.init()
              return module
            },
          ))
          let wasm: string
          if (['markdown', 'elisp', 'json', 'yaml', 'lua'].includes(lang)) {
            wasm = fileURLToPath(new URL(`./grammars/tree-sitter-${lang}.wasm`, import.meta.url))
          } else {
            wasm = require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${lang}.wasm`)
          }
          const parser = new Parser()
          parser.setLanguage(await Language.load(wasm))
          parsers.set(lang, parser)
        })()
        loading.set(lang, pending)
      }
      await pending
    }),
  )
  setSyntaxProbe(treeSitterProbe)
}

/** Keep only the last tree per language; release WASM memory when its source changes. */
const trees = new Map<string, { text: string; tree: Tree }>()
function parse(file: string | undefined, text: string): Tree | undefined {
  const lang = language(file)
  const parser = lang && parsers.get(lang)
  if (!lang || !parser) return undefined
  const cached = trees.get(lang)
  if (cached?.text === text) return cached.tree
  cached?.tree.delete()
  trees.delete(lang)
  const tree = parser.parse(text)
  if (tree) trees.set(lang, { text, tree })
  return tree ?? undefined
}
function endLine(node: Node): number {
  return node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1)
}
function leafAt(tree: Tree, text: string, line: number): Node | null {
  const row = text.split('\n')[line - 1]
  const column = row?.search(/\S/)
  if (column === undefined || column < 0 || line < 1) return null
  return tree.rootNode.namedDescendantForPosition(
    { row: line - 1, column },
    { row: line - 1, column: column + 1 },
  )
}
export const treeSitterProbe: SyntaxProbe = {
  nodeChain(lines, file, line) {
    const text = lines.join('\n')
    const tree = parse(file, text)
    const chain = []
    for (let node = tree && leafAt(tree, text, line); node?.parent; node = node.parent) {
      if (node.isNamed && !node.isError && !node.isMissing) {
        chain.push({
          kind: node.type,
          startLine: node.startPosition.row + 1,
          endLine: endLine(node),
        })
      }
    }
    return chain
  },
  enclosingBoundaries(lines, file, start, end) {
    const tree = parse(file, lines.join('\n'))
    if (!tree || tree.rootNode.hasError) return []
    const result = new Set<number>()
    const visible = (line: number) => line >= start && line <= end
    const visit = (node: Node) => {
      if (node.startPosition.row + 1 > end || node.endPosition.row + 1 < start) return
      const first = node.startPosition.row + 1,
        last = endLine(node)
      if (node.isNamed && node.parent && last > first) {
        if (visible(first) && !visible(last)) result.add(last)
        else if (visible(last) && !visible(first)) result.add(first)
      }
      for (const child of node.children) if (child) visit(child)
    }
    visit(tree.rootNode)
    return [...result].toSorted((a, b) => a - b)
  },
  parsesCleanly(file, text) {
    const tree = parse(file, text)
    return tree !== undefined && !tree.rootNode.hasError
  },
}
const sequences = new Set([
  'statement_list',
  'block',
  'body_statement',
  'statements',
  'body',
  'indented_block',
  'block_mapping',
  'block_sequence',
  'import_list',
  'hash_literal_body',
])
function statementSequence(parent: Node, node: Node): boolean {
  if (!sequences.has(parent.type) || parent.startIndex !== node.startIndex) return false
  let next = node.nextNamedSibling
  let skipped = false
  while (next?.isExtra) {
    skipped = true
    next = next.nextNamedSibling
  }
  return next
    ? next.startPosition.row > node.endPosition.row &&
        next.startPosition.column === node.startPosition.column
    : skipped
}
export const treeSitterBlockResolver: BlockResolver = ({ path: file, text, line }) => {
  const tree = parse(file, text)
  if (!tree) return null
  let node = leafAt(tree, text, line)
  if (!node || node.startPosition.row !== line - 1) return null
  while (
    node.parent &&
    node.parent.id !== tree.rootNode.id &&
    node.parent.startPosition.row === line - 1 &&
    !statementSequence(node.parent, node)
  ) {
    node = node.parent
  }
  if (node.id === tree.rootNode.id || node.hasError) return null
  return { start: node.startPosition.row + 1, end: endLine(node) }
}
