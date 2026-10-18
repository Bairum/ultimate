import { resolve } from 'node:path'
import { parseSync } from 'vite-plus'
import { expect, it } from 'vitest'
import ultimate from '../lint/ultimate.ts'

type Rule = keyof typeof ultimate.rules
type Located = { type: string; start: number; end: number; parent?: Located }
type Comment = { type: string; value: string; start: number; end: number }

/** Run one rule over `source` as oxlint would for `file` (repository-relative): parse, walk, report messages. */
function lint(rule: Rule, file: string, source: string) {
  const { program, comments } = parseSync(file, source, { lang: 'ts' }) as unknown as {
    program: Located
    comments: Comment[]
  }
  const reports: string[] = []
  // The comments right before a node, with only whitespace between them and it.
  const getCommentsBefore = (node: Located) => {
    const found: Comment[] = []
    let at = node.start
    for (const comment of comments.toReversed()) {
      if (comment.end > at) continue
      if (source.slice(comment.end, at).trim()) break
      found.unshift(comment)
      at = comment.start
    }
    return found
  }
  const visitors = ultimate.rules[rule].create({
    filename: resolve(file),
    options: [],
    sourceCode: { text: source, getCommentsBefore, getCommentsInside: () => [] },
    report: ({ message }) => reports.push(message),
  }) as Record<string, ((node: Located) => void) | undefined>
  const visit = (node: Located, parent?: Located) => {
    node.parent = parent
    visitors[node.type]?.(node)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue
      for (const child of Array.isArray(value) ? value : [value])
        if (child && typeof child === 'object' && typeof child.type === 'string')
          visit(child as Located, node)
    }
  }
  visit(program)
  return reports
}

const api = `/**
 * Echo: says things back. Other extensions ask it to repeat text.
 */
import type { Context } from '@earendil-works/chord'
import { defineDoc } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { BoardMessage } from '../board/api.ts'
import { Board } from '../board/api.ts'
import type { echo } from './server.ts'

type Helper = ReturnType<typeof echo>

export type EchoService = {
  /** Repeat \`text\`; use it to test a round trip. */
  echo(text: string, ctx: Context): Promise<string>
  /** The last message echoed. */
  last: () => BoardMessage | undefined
}
/** The echo service; \`want\` it. */
export const EchoApi = defineApi<EchoService>()('echo')
/** Something was echoed. */
export const Echoed = defineEvent<{ text: string }>('echo.echoed')
/** The echo log. */
export const Log = defineDoc<{ texts: string[] }>({ kind: 'echo.log', version: 1, scope: 'conversation', initial: () => ({ texts: [] }) })
`

it('accepts an api.ts of documented contracts and rejects runtime code, node imports and missing docs', () => {
  expect(lint('api-file-shape', 'extensions/echo/api.ts', api)).toEqual([])
  expect(lint('api-naming', 'extensions/echo/api.ts', api)).toEqual([])
  // Only api.ts files are checked.
  expect(lint('api-file-shape', 'extensions/echo/server.ts', 'const x = 1')).toEqual([])

  const bad = `import { readFile } from 'node:fs/promises'
import { echo } from './server.ts'
import { Board } from '../board/server.ts'
import { defineApi } from '../../shared/extension-api.ts'
export interface EchoService {
  echo(text: string): string
  /** Documented. */
  last(): string
}
export const EchoApi = defineApi<EchoService>()('echo')
export const limit = 3
export function helper() {}
`
  expect(lint('api-file-shape', 'extensions/echo/api.ts', bad)).toEqual([
    "Start api.ts with a doc comment on the extension's intent; its first sentence is the one-line summary.",
    'api.ts is browser-safe: it imports no node:* module.',
    "api.ts imports at runtime only shared/, packages and other extensions' api.ts; use `import type` for the rest.",
    "api.ts imports at runtime only shared/, packages and other extensions' api.ts; use `import type` for the rest.",
    'Document each exported token: what it is and when to use it.',
    'api.ts holds only contracts: imports, `export const X = defineApi/defineEvent/defineDoc/defineEntry(...)` and types.',
    'api.ts holds only contracts: imports, `export const X = defineApi/defineEvent/defineDoc/defineEntry(...)` and types.',
    'Document EchoService.echo: what it does and when to call it.',
  ])
  // A header without a sentence is no summary.
  expect(
    lint(
      'api-file-shape',
      'extensions/echo/api.ts',
      `/** Echo */\n${api.slice(api.indexOf('import'))}`,
    ),
  ).toContain(
    "Start api.ts with a doc comment on the extension's intent; its first sentence is the one-line summary.",
  )
})

it('names an API after its folder and prefixes its events', () => {
  const source = `export const A = defineApi<S>()('other')
export const B = defineEvent('other.thing')
export const C = defineEvent('echo.')
export const D = defineEvent('echo.thing')`
  expect(lint('api-naming', 'extensions/echo/api.ts', source)).toEqual([
    "The API of extensions/echo is named 'echo'.",
    "Events of extensions/echo are named 'echo.<event>'.",
    "Events of extensions/echo are named 'echo.<event>'.",
  ])
})

it("allows another extension's api.ts and type imports, and rejects its other runtime files", () => {
  const source = `import { BoardApi } from '../board/api.ts'
import type { BoardService } from '../board/server.ts'
import { git } from '../../lib/git.ts'
import { helper } from './helper.ts'
import { Board } from '../board/server.ts'
import { type Standing } from '../subagents/server.ts'
export { roots } from '../lineage/roots.ts'
const later = () => import('../questions/server.ts')`
  expect(lint('api-only-imports', 'extensions/echo/server.ts', source)).toEqual([
    'echo imports board/server.ts at runtime; reach board through its api.ts (a service, document or event token), import types with `import type`, or move a pure helper to lib/.',
    'echo imports subagents/server.ts at runtime; reach subagents through its api.ts (a service, document or event token), import types with `import type`, or move a pure helper to lib/.',
    'echo imports lineage/roots.ts at runtime; reach lineage through its api.ts (a service, document or event token), import types with `import type`, or move a pure helper to lib/.',
    'echo imports questions/server.ts at runtime; reach questions through its api.ts (a service, document or event token), import types with `import type`, or move a pure helper to lib/.',
  ])
  // Outside extensions/ nothing is checked.
  expect(lint('api-only-imports', 'test/example.test.ts', source)).toEqual([])
})

it('rejects host.provide, host.use and host.events, also through an action context', () => {
  const source = `host.provide('echo', {})
host.use('echo')?.echo()
host.events.on('x', () => {})
ctx.host.use('echo')
host.implement(EchoApi, {})
host.want(EchoApi)
service.use('echo')`
  expect(lint('no-raw-services', 'extensions/echo/server.ts', source)).toEqual([
    'host.provide is untyped: declare a token in api.ts and use host.implement, host.need or host.want for services, host.emit and host.react for events.',
    'host.use is untyped: declare a token in api.ts and use host.implement, host.need or host.want for services, host.emit and host.react for events.',
    'host.events is untyped: declare a token in api.ts and use host.implement, host.need or host.want for services, host.emit and host.react for events.',
    'host.use is untyped: declare a token in api.ts and use host.implement, host.need or host.want for services, host.emit and host.react for events.',
  ])
})
