import { readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { Conversation, JsonObject, ToolRegistration } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { FileError } from '@earendil-works/pi-durable/env'
import { createReadTool, createWriteTool, createEditTool } from '@earendil-works/pi-durable/tools'
import hashline from '../extensions/hashline/server.ts'
import {
  Provenance,
  carriedSeenLines,
  clearTextCache,
  hash32,
} from '../extensions/hashline/store.ts'
import { computeFileHash } from '../extensions/hashline/engine/index.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

const faux = fauxProvider()
let opened: Awaited<ReturnType<Awaited<ReturnType<typeof prepareHarness>>['open']>>
let prepared: Awaited<ReturnType<typeof prepareHarness>>
beforeAll(async () => {
  const home = await temp('hashline-tools-')
  prepared = await prepareHarness({ ultimateRoot: home, home, userHome: home, faux })
  prepared.registry.install(
    defineExtension({
      name: 'coding-tools',
      tools: [createReadTool(), createWriteTool(), createEditTool()] as ToolRegistration[],
    }),
  )
  prepared.registry.install(hashline({ harness: () => opened.harness }))
  prepared.registry.install(
    defineExtension({
      name: 'nested-test',
      tools: [
        defineTool({
          name: 'nested',
          description: 'test nested rules',
          parameters: Type.Object({
            input: Type.String(),
            read: Type.Boolean(),
            direct: Type.Optional(Type.Boolean()),
            parallel: Type.Optional(Type.Boolean()),
          }),
          async execute(args, api, ctx) {
            if (args.parallel) {
              const results = await Promise.all(
                ['a.txt', 'b.txt'].map((path) => api.executeTool('read', { path }, ctx)),
              )
              return {
                output: [{ type: 'text', text: 'program complete' }],
                details: { nestedError: results.some((result) => result.isError) },
              }
            }
            const name = args.read ? 'read' : 'edit'
            const parameters: JsonObject = args.read ? { path: 'a.txt' } : { input: args.input }
            // Codemode's present direct-call convention: child callId, outer taskId.
            const result = args.direct
              ? await (
                  await api.agent(ctx)
                ).tools
                  .find((tool) => tool.name === name)!
                  .execute(parameters, { ...api, callId: `${api.callId}/1` }, ctx)
              : await api.executeTool(name, parameters, ctx)
            return {
              output: [
                { type: 'text', text: result.isError ? 'nested failed' : 'nested complete' },
              ],
              details: { nestedError: !!result.isError },
            }
          },
        }),
      ],
    }),
  )
  opened = await prepared.open(false)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await opened?.close()
})
async function fixture(text = 'one\ntwo\nthree\n') {
  const cwd = await realpath(await temp('hashline-files-'))
  await writeFile(join(cwd, 'a.txt'), text)
  const conversation = await opened.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { ...(await opened.root.agent(context)), cwd } },
    context,
  )
  return {
    cwd,
    conversation,
    tag: computeFileHash(text),
    path: join(cwd, 'a.txt'),
    read: () => readFile(join(cwd, 'a.txt'), 'utf8'),
  }
}
async function call(conversation: Conversation, name: string, args: JsonObject) {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Complete'),
  ])
  await conversation.submit({ type: 'input', content: `Run ${name}` }, context)
  await conversation.waitForIdle(context)
  const view = await conversation.context(context)
  const result = view.messages.findLast(
    (message) => message.role === 'toolResult' && message.toolName === name,
  )
  if (!result || result.role !== 'toolResult')
    throw new Error(`No ${name} result: ${JSON.stringify(view.messages)}`)
  return {
    ...result,
    text: result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
  }
}
const patch = (tag: string, body: string) => `[a.txt#${tag}]\n${body}`

test('wraps replace the edit schema and preserve sequential mutation execution', async () => {
  const f = await fixture()
  const agent = await f.conversation.agent(context)
  const edit = agent.tools.find((tool) => tool.name === 'edit')!
  expect(edit.parameters).toMatchObject({ properties: { input: { type: 'string' } } })
  expect(edit.executionMode).toBe('sequential')
  expect(edit.description).toContain('Block * forms are unavailable')
})

test('text read emits headers and numbered rows, clean details, offset/limit and continuation diagnostics', async () => {
  const f = await fixture()
  const result = await call(f.conversation, 'read', { path: 'a.txt', offset: 2, limit: 1 })
  expect(result.isError).toBe(false)
  expect(result.text).toContain(`[a.txt#${f.tag}]\n2:two`)
  expect(result.text).toContain('offset=3')
  expect(result.details).toMatchObject({
    hashline: { path: f.path, tag: f.tag, startLine: 2, text: 'two', full: false },
  })
  const state = await opened.harness.snapshot(Provenance, f.conversation.id, context)
  expect(state?.paths[f.path][0].seen).toEqual([
    [0, 0],
    [2, 2],
  ])
})

test('read keeps Pi truncation and never marks a clipped line as seen', async () => {
  const f = await fixture('x'.repeat(60 * 1024))
  const result = await call(f.conversation, 'read', { path: 'a.txt' })
  expect(result.isError).toBe(false)
  expect(result.text).toContain('exceeds the 50.0KB limit')
  expect(result.details).toMatchObject({ hashline: { full: false } })
  const state = await opened.harness.snapshot(Provenance, f.conversation.id, context)
  expect(state?.paths[f.path][0].seen).toEqual([[0, 0]])
})

test('seen-line guard reveals hidden rows, writes nothing, and permits a same-tag retry', async () => {
  const f = await fixture()
  await call(f.conversation, 'read', { path: 'a.txt', offset: 1, limit: 1 })
  const first = await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 3.=3:\n+THREE') })
  expect(first.isError).toBe(true)
  expect(first.text).toContain('3:three')
  expect(await f.read()).toBe('one\ntwo\nthree\n')
  expect(
    (await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 3.=3:\n+THREE') })).isError,
  ).toBe(false)
  expect(await f.read()).toBe('one\ntwo\nTHREE\n')
})

test('unknown stale tag rejects with current context and no write', async () => {
  const f = await fixture()
  const result = await call(f.conversation, 'edit', { input: patch('FFFF', 'PUT 2.=2:\n+TWO') })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('not from this session')
  expect(result.text).toContain('2:two')
  expect(await f.read()).toBe('one\ntwo\nthree\n')
})

test('safe external insertion recovers the original target, never the old line number', async () => {
  const f = await fixture()
  await call(f.conversation, 'read', { path: 'a.txt' })
  await writeFile(f.path, 'external\none\ntwo\nthree\n')
  const result = await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 2.=2:\n+TWO') })
  expect(result.isError).toBe(false)
  expect(await f.read()).toBe('external\none\nTWO\nthree\n')
  expect(result.details).toMatchObject({ hashline: { metrics: { recovered: 1 } } })
})

test('external target rewrite refuses recovery without overwriting that writer', async () => {
  const f = await fixture()
  await call(f.conversation, 'read', { path: 'a.txt' })
  await writeFile(f.path, 'one\nexternal target\nthree\n')
  const result = await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 2.=2:\n+TWO') })
  expect(result.isError).toBe(true)
  expect(await f.read()).toBe('one\nexternal target\nthree\n')
})

test('16-bit collision with a different durable 32-bit hash rejects before writing', async () => {
  const before = 'line one 263\nline two 4471\n',
    collision = 'line one 410\nline two 6970\n'
  const f = await fixture(before)
  expect(computeFileHash(collision)).toBe(f.tag)
  expect(hash32(collision)).not.toBe(hash32(before))
  await call(f.conversation, 'read', { path: 'a.txt' })
  await writeFile(f.path, collision)
  const result = await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 1.=1:\n+wrong') })
  expect(result.isError).toBe(true)
  expect(await f.read()).toBe(collision)
})

test('nested reads do not grant seen lines; nested edits skip only that guard', async () => {
  const f = await fixture()
  expect((await call(f.conversation, 'nested', { read: true, input: '' })).isError).toBe(false)
  const state = await opened.harness.snapshot(Provenance, f.conversation.id, context)
  expect(state?.paths[f.path][0].seen).toEqual([[0, 0]])
  const normal = await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 3.=3:\n+THREE') })
  expect(normal.isError).toBe(true)
  // A fresh nested snapshot has no model-visible lines, but the program's computed anchors are permitted.
  const other = await fixture()
  await call(other.conversation, 'nested', { read: true, input: '' })
  const result = await call(other.conversation, 'nested', {
    read: false,
    input: patch(other.tag, 'PUT 3.=3:\n+THREE'),
  })
  expect(result.details).toMatchObject({ nestedError: false })
  expect(await other.read()).toBe('one\ntwo\nTHREE\n')
  const bad = await call(other.conversation, 'nested', {
    read: false,
    input: patch('FFFF', 'PUT 1.=1:\n+bad'),
  })
  expect(bad.details).toMatchObject({ nestedError: true })
})

test('concurrent nested reads preserve both durable path histories without granting seen lines', async () => {
  const f = await fixture()
  const other = join(f.cwd, 'b.txt')
  await writeFile(other, 'other\n')
  const result = await call(f.conversation, 'nested', { read: true, input: '', parallel: true })
  expect(result.details).toMatchObject({ nestedError: false })
  const state = await opened.harness.snapshot(Provenance, f.conversation.id, context)
  expect(state?.paths[f.path][0].seen).toEqual([[0, 0]])
  expect(state?.paths[other][0].seen).toEqual([[0, 0]])
})

test('codemode direct child callIds use nested read/edit rules despite retaining the outer taskId', async () => {
  const f = await fixture()
  await call(f.conversation, 'nested', { read: true, direct: true, input: '' })
  const state = await opened.harness.snapshot(Provenance, f.conversation.id, context)
  expect(state?.paths[f.path][0].seen).toEqual([[0, 0]])
  const result = await call(f.conversation, 'nested', {
    read: false,
    direct: true,
    input: patch(f.tag, 'PUT 3.=3:\n+THREE'),
  })
  expect(result.details).toMatchObject({ nestedError: false })
  expect(await f.read()).toBe('one\ntwo\nTHREE\n')
})

test('restart without text cache accepts a live tag and retains seen restrictions', async () => {
  const f = await fixture()
  await call(f.conversation, 'read', { path: 'a.txt', offset: 2, limit: 1 })
  await opened.close()
  clearTextCache()
  opened = await prepared.open(false)
  f.conversation = (await opened.harness.conversation(f.conversation.id, context))!
  const hidden = await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 3.=3:\n+THREE') })
  expect(hidden.isError).toBe(true)
  clearTextCache()
  expect(
    (await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 2.=2:\n+TWO') })).isError,
  ).toBe(false)
})

test('restart rebuilds stale text from a full transcript read, not from a partial one', async () => {
  const f = await fixture()
  await call(f.conversation, 'read', { path: 'a.txt' })
  await opened.close()
  clearTextCache()
  opened = await prepared.open(false)
  f.conversation = (await opened.harness.conversation(f.conversation.id, context))!
  await writeFile(f.path, 'external\none\ntwo\nthree\n')
  expect(
    (await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 2.=2:\n+TWO') })).isError,
  ).toBe(false)
  expect(await f.read()).toBe('external\none\nTWO\nthree\n')
  const partial = await fixture()
  await call(partial.conversation, 'read', { path: 'a.txt', limit: 2 })
  clearTextCache()
  await writeFile(partial.path, 'external\none\ntwo\nthree\n')
  expect(
    (await call(partial.conversation, 'edit', { input: patch(partial.tag, 'PUT 2.=2:\n+TWO') }))
      .isError,
  ).toBe(true)
  expect(await partial.read()).toBe('external\none\ntwo\nthree\n')
})

test('REM and MV use the environment; register CUT/paste survives text cache loss', async () => {
  const f = await fixture()
  const cut = await call(f.conversation, 'edit', { input: patch(f.tag, 'CUT 2 @saved') })
  expect(cut.isError).toBe(false)
  clearTextCache()
  const tag = computeFileHash(await f.read())
  expect(
    (
      await call(f.conversation, 'edit', {
        input: patch(tag, 'PUT >$ @saved\nMV nested/moved.txt'),
      })
    ).isError,
  ).toBe(false)
  expect(await readFile(join(f.cwd, 'nested/moved.txt'), 'utf8')).toBe('one\nthree\ntwo\n')
  const movedTag = computeFileHash('one\nthree\ntwo\n')
  expect(
    (await call(f.conversation, 'edit', { input: `[nested/moved.txt#${movedTag}]\nREM` })).isError,
  ).toBe(false)
  await expect(readFile(join(f.cwd, 'nested/moved.txt'))).rejects.toThrow('ENOENT')
})

test('failed MV retains source provenance and does not create destination history', async () => {
  const f = await fixture()
  await call(f.conversation, 'read', { path: 'a.txt', limit: 1 })
  const rename = vi
    .spyOn(NodeExecutionEnv.prototype, 'renameFile')
    .mockResolvedValue({ ok: false, error: new FileError('permission_denied', 'rename denied') })
  const result = await call(f.conversation, 'edit', { input: patch(f.tag, 'MV moved.txt') })
  expect(result.isError).toBe(true)
  expect(rename).toHaveBeenCalledOnce()
  expect(await f.read()).toBe('one\ntwo\nthree\n')
  const state = await opened.harness.snapshot(Provenance, f.conversation.id, context)
  expect(state?.paths[f.path][0].seen).toEqual([[0, 1]])
  expect(state?.paths[join(f.cwd, 'moved.txt')]).toBeUndefined()
  expect(
    (await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 3.=3:\n+unseen') })).isError,
  ).toBe(true)
})

test('REM removes the authored symlink rather than its canonical target', async () => {
  const f = await fixture()
  await symlink(f.path, join(f.cwd, 'alias.txt'))
  expect((await call(f.conversation, 'read', { path: 'alias.txt' })).isError).toBe(false)
  expect((await call(f.conversation, 'edit', { input: `[alias.txt#${f.tag}]\nREM` })).isError).toBe(
    false,
  )
  expect(await f.read()).toBe('one\ntwo\nthree\n')
  await expect(readFile(join(f.cwd, 'alias.txt'))).rejects.toThrow('ENOENT')
})

test('batch preflight prevents partial writes on parse errors and stale later files', async () => {
  const f = await fixture()
  await writeFile(join(f.cwd, 'b.txt'), 'other\n')
  const header = patch(f.tag, 'PUT 1.=1:\n+ONE')
  const invalid = await call(f.conversation, 'edit', {
    input: `${header}\n[b.txt#${computeFileHash('other\n')}]\nREM\nPUT 1.=1:\n+bad`,
  })
  expect(invalid.isError).toBe(true)
  expect(await f.read()).toBe('one\ntwo\nthree\n')
  const stale = await call(f.conversation, 'edit', {
    input: `${header}\n[b.txt#FFFF]\nPUT 1.=1:\n+bad`,
  })
  expect(stale.isError).toBe(true)
  expect(await f.read()).toBe('one\ntwo\nthree\n')
})

test('write result header enables a following edit without seen restrictions', async () => {
  const f = await fixture()
  const result = await call(f.conversation, 'write', { path: 'new.txt', content: 'created\n' })
  const tag = computeFileHash('created\n')
  expect(result.text).toContain(`[new.txt#${tag}]`)
  expect(
    (await call(f.conversation, 'edit', { input: `[new.txt#${tag}]\nPUT 1.=1:\n+changed` }))
      .isError,
  ).toBe(false)
  expect(await readFile(join(f.cwd, 'new.txt'), 'utf8')).toBe('changed\n')
})

test('edit provenance carries unchanged unshifted rows, unions preview rows, not shifted numbers', async () => {
  const source = Array.from({ length: 40 }, (_, i) => `line${i + 1}\n`).join('')
  const f = await fixture(source)
  await call(f.conversation, 'read', { path: 'a.txt' })
  const result = await call(f.conversation, 'edit', {
    input: patch(f.tag, 'PUT >30:\n+new-a\n+new-b'),
  })
  expect(result.isError).toBe(false)
  const tag = computeFileHash(await f.read())
  const shifted = await call(f.conversation, 'edit', {
    input: patch(tag, 'PUT 40.=40:\n+wrong number'),
  })
  expect(shifted.isError).toBe(true)
  const unchanged = await call(f.conversation, 'edit', { input: patch(tag, 'PUT 2.=2:\n+LINE2') })
  expect(unchanged.isError).toBe(false)
  expect(carriedSeenLines('a\nb\nc\n', 'a\nnew\nb\nc\n', [[1, 3]])).toEqual([1])
})

test('grep groups numbered editable matches/context, forwards flags and marks only displayed lines', async () => {
  const f = await fixture()
  const execute = vi
    .spyOn(NodeExecutionEnv.prototype, 'exec')
    .mockImplementation(async (command, options, ctx) => {
      expect(command).toEqual([
        'rg',
        '--json',
        '--max-count',
        '101',
        '--context',
        '1',
        '--glob',
        '*.txt',
        '--ignore-case',
        '--',
        'TWO',
        '.',
      ])
      for (const [type, line] of [
        ['context', 1],
        ['match', 2],
      ] as const)
        options?.onOutput?.(
          JSON.stringify({ type, data: { path: { text: 'a.txt' }, line_number: line } }) + '\n',
          ctx,
          { stream: 'stdout' },
        )
      return { ok: true, value: { exitCode: 0 } }
    })
  const result = await call(f.conversation, 'grep', {
    pattern: 'TWO',
    glob: '*.txt',
    ignoreCase: true,
    context: 1,
  })
  expect(execute).toHaveBeenCalledOnce()
  expect(result.text).toContain(`[a.txt#${f.tag}]\n1:one\n2:two`)
  expect(result.details).toMatchObject({ useless: false, hashline: { matches: 1 } })
  expect(
    (await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 3.=3:\n+THREE') })).isError,
  ).toBe(true)
})

test('empty grep is useless; missing rg has an actionable error', async () => {
  const f = await fixture()
  const exec = vi
    .spyOn(NodeExecutionEnv.prototype, 'exec')
    .mockResolvedValue({ ok: true, value: { exitCode: 1 } })
  expect((await call(f.conversation, 'grep', { pattern: 'absent' })).details).toMatchObject({
    useless: true,
  })
  exec.mockResolvedValue({ ok: true, value: { exitCode: 127 } })
  const missing = await call(f.conversation, 'grep', { pattern: 'absent' })
  expect(missing.isError).toBe(true)
  expect(missing.text).toContain('requires ripgrep')
})

test('CRLF/BOM reads tag normalized text and preserve original bytes through an edit', async () => {
  const f = await fixture('\ufeffone\r\ntwo\r\nthree\r\n')
  const read = await call(f.conversation, 'read', { path: 'a.txt' })
  const tag = computeFileHash('one\ntwo\nthree\n')
  expect(read.isError).toBe(false)
  expect(read.details).toMatchObject({ hashline: { tag, text: 'one\ntwo\nthree\n', full: true } })
  expect(
    (await call(f.conversation, 'edit', { input: patch(tag, 'PUT 2.=2:\n+TWO') })).isError,
  ).toBe(false)
  expect(await f.read()).toBe('\ufeffone\r\nTWO\r\nthree\r\n')
})

test('image reads preserve Pi image content without minting text provenance', async () => {
  const f = await fixture()
  await writeFile(
    join(f.cwd, 'pixel.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  const result = await call(f.conversation, 'read', { path: 'pixel.png' })
  expect(result.isError).toBe(false)
  expect(result.content.some((part) => part.type === 'image')).toBe(true)
  expect(await opened.harness.snapshot(Provenance, f.conversation.id, context)).toBeUndefined()
})

test('compact edit previews do not mark omitted middle rows as seen', async () => {
  const f = await fixture('head\nold\ntail\n')
  await call(f.conversation, 'read', { path: 'a.txt', limit: 2 })
  const body = Array.from({ length: 20 }, (_, i) => `+new${i + 1}`).join('\n')
  const edit = await call(f.conversation, 'edit', { input: patch(f.tag, `PUT 2.=2:\n${body}`) })
  expect(edit.isError).toBe(false)
  expect(edit.text).toContain('…')
  const tag = computeFileHash(await f.read())
  const hidden = await call(f.conversation, 'edit', { input: patch(tag, 'PUT 10.=10:\n+wrong') })
  expect(hidden.isError).toBe(true)
})

test('capped mismatch context grants only rows actually emitted, not clipped wide rows', async () => {
  const f = await fixture(`one\n${'x'.repeat(70 * 1024)}\nthree\n`)
  const result = await call(f.conversation, 'edit', { input: patch('FFFF', 'PUT 2.=2:\n+short') })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('Context capped')
  const state = await opened.harness.snapshot(Provenance, f.conversation.id, context)
  const ranges = state!.paths[f.path][0].seen!
  expect(ranges.some(([a, b]) => a <= 2 && b >= 2)).toBe(false)
  expect(
    (await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 2.=2:\n+short') })).isError,
  ).toBe(true)
})

test('grep caps at 100 matches and 20 files with an explicit narrowing note', async () => {
  const f = await fixture(Array.from({ length: 101 }, (_, i) => `match${i}\n`).join(''))
  const exec = vi
    .spyOn(NodeExecutionEnv.prototype, 'exec')
    .mockImplementation(async (_, options, ctx) => {
      for (let line = 1; line <= 101; line++)
        options?.onOutput?.(
          JSON.stringify({ type: 'match', data: { path: { text: 'a.txt' }, line_number: line } }) +
            '\n',
          ctx,
          { stream: 'stdout' },
        )
      return { ok: true, value: { exitCode: 0 } }
    })
  const matches = await call(f.conversation, 'grep', { pattern: 'match' })
  expect(matches.details).toMatchObject({ hashline: { matches: 100, capped: true } })
  expect(matches.text).toContain('narrow the pattern')
  for (let file = 0; file < 21; file++) await writeFile(join(f.cwd, `${file}.txt`), 'match\n')
  exec.mockImplementation(async (_, options, ctx) => {
    for (let file = 0; file < 21; file++)
      options?.onOutput?.(
        JSON.stringify({ type: 'match', data: { path: { text: `${file}.txt` }, line_number: 1 } }) +
          '\n',
        ctx,
        { stream: 'stdout' },
      )
    return { ok: true, value: { exitCode: 0 } }
  })
  const files = await call(f.conversation, 'grep', { pattern: 'match' })
  expect(files.details).toMatchObject({ hashline: { matches: 20, capped: true } })
})

test('bounded provenance-bearing results are exempt from downstream output offload', async () => {
  const f = await fixture()
  const read = await call(f.conversation, 'read', { path: 'a.txt' })
  const edit = await call(f.conversation, 'edit', { input: patch(f.tag, 'PUT 2.=2:\n+TWO') })
  vi.spyOn(NodeExecutionEnv.prototype, 'exec').mockResolvedValue({
    ok: true,
    value: { exitCode: 1 },
  })
  const grep = await call(f.conversation, 'grep', { pattern: 'absent' })
  const rejected = await call(f.conversation, 'edit', { input: patch('FFFF', 'PUT 1.=1:\n+bad') })
  for (const result of [read, edit, grep, rejected])
    expect(result.details).toMatchObject({ offloadExempt: true })
})

test('provenance forks as of history instead of inheriting later displayed rows', async () => {
  const f = await fixture()
  await call(f.conversation, 'read', { path: 'a.txt', limit: 1 })
  const at = (await f.conversation.context(context)).entries.at(-1)!.id
  await call(f.conversation, 'read', { path: 'a.txt', offset: 3, limit: 1 })
  const fork = await f.conversation.fork(at, { ownership: { kind: 'ownerless' } }, context)
  const state = await opened.harness.snapshot(Provenance, fork.id, context)
  expect(state?.paths[f.path][0].seen).toEqual([[0, 1]])
  expect((await call(fork, 'edit', { input: patch(f.tag, 'PUT 3.=3:\n+THREE') })).isError).toBe(
    true,
  )
})
