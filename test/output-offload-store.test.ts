import { mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ToolExecutionResult, ToolHookCall } from '@earendil-works/pi-durable'
import { temp } from './helpers.ts'
import {
  keepMs,
  maxOpenBytes,
  offload,
  openOutput,
  pruneOutputs,
} from '../extensions/output-offload/store.ts'
import { actions, userActions } from '../extensions/output-offload/server.ts'
import type { ActionContext } from '../server/actions.ts'

const call: ToolHookCall = { type: 'toolCall', id: 'call/unsafe', name: 'bash', arguments: {} }
const full = Array.from(
  { length: 5000 },
  (_, i) => `${i === 2000 ? 'ERROR' : 'ok'} row ${i + 1} ${'x'.repeat(30)}`,
).join('\n')
const result: ToolExecutionResult = {
  output: [
    { type: 'text', text: full },
    { type: 'image', data: 'AA==', mimeType: 'image/png' },
  ],
  isError: true,
  details: { original: true },
}

it('stores full text, excerpts head/tail and numbered matching lines, preserving images and metadata', async () => {
  const home = await temp()
  const shortened = await offload(home, 1, call, result)
  const path = join(home, 'outputs/1/call_unsafe.txt')
  expect(await readFile(path, 'utf8')).toBe(full)
  expect(shortened).toMatchObject({
    isError: true,
    details: { original: true, offload: { path, bytes: Buffer.byteLength(full), lines: 5000 } },
  })
  expect(shortened?.output?.[1]).toEqual(result.output?.[1])
  const text = shortened?.output?.[0]
  expect(text?.type).toBe('text')
  if (text?.type !== 'text') throw new Error('Missing excerpt')
  expect(text.text).toContain('… 4,880 lines')
  expect(text.text).toContain(
    `Full output: ${path}. Use read with offset/limit or grep on that file.`,
  )
  expect(text.text).toContain('2001: ERROR row 2001')
  expect(text.text).toContain('ok row 5000')
  expect(text.text).not.toContain('ok row 1000')
})

it('leaves small, read, nested and excluded tool results untouched, including errors', async () => {
  const home = await temp()
  expect(
    await offload(home, 1, call, { output: [{ type: 'text', text: 'small' }] }),
  ).toBeUndefined()
  for (const skipped of [
    { ...call, name: 'read' },
    { ...call, parent: { taskId: 'task' as never, callId: 'outer' } },
    { ...call, name: 'excluded' },
  ])
    for (const isError of [false, true])
      expect(
        await offload(
          home,
          1,
          skipped,
          { ...result, isError },
          { thresholdBytes: 100, exclude: ['excluded'] },
        ),
      ).toBeUndefined()
})

it('leaves large results that opt out with details.offloadExempt untouched', async () => {
  const home = await temp()
  expect(
    await offload(
      home,
      1,
      { ...call, name: 'grep' },
      { ...result, details: { offloadExempt: true } },
      { thresholdBytes: 100, exclude: [] },
    ),
  ).toBeUndefined()
})

it('uses bytes for the configurable threshold and caps matching lines at 20', async () => {
  const home = await temp()
  const output = [{ type: 'text' as const, text: '警告 warn\n'.repeat(1500) }]
  expect(
    await offload(home, 1, call, { output }, { thresholdBytes: 50000, exclude: [] }),
  ).toBeUndefined()
  const shortened = await offload(home, 1, call, { output }, { thresholdBytes: 1000, exclude: [] })
  const text = shortened?.output?.[0]
  if (text?.type !== 'text') throw new Error('Missing excerpt')
  expect(text.text.split('Matching lines:\n')[1].split('\n').slice(0, -1)).toHaveLength(20)
})

it('keeps original output and adds a diagnostic on disk failure or missing spill', async () => {
  const home = await temp()
  await writeFile(join(home, 'outputs'), 'not a directory')
  for (const original of [
    result,
    { ...result, structuredOutput: { fullOutputPath: join(home, 'missing') } },
  ]) {
    const failed = await offload(home, 1, call, original)
    expect(failed?.output).toBe(original.output)
    expect(failed?.details).toBe(original.details)
    expect(failed?.isError).toBe(original.isError)
    expect(failed?.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warn',
        message: expect.stringContaining('original result kept:'),
      }),
    ])
  }
})

it('the user-only action opens full output and refuses traversal, symlinks outside outputs and oversized files', async () => {
  const home = await temp()
  await offload(home, 1, call, result)
  const path = join(home, 'outputs/1/call_unsafe.txt')
  const ctx = { host: { home } } as ActionContext
  expect(userActions).toContain('open')
  expect(await actions.open({ path }, ctx)).toBe(full)
  const outside = join(home, 'private')
  await writeFile(outside, 'private')
  await symlink(outside, join(home, 'outputs/escape'))
  for (const target of [outside, join(home, 'outputs/../private'), join(home, 'outputs/escape')])
    await expect(actions.open({ path: target }, ctx)).rejects.toThrow('outside outputs')
  await writeFile(path, 'x'.repeat(maxOpenBytes + 1))
  await expect(openOutput(home, path)).rejects.toThrow('exceeds 4 MB')
  await expect(actions.open({ path: 42 }, ctx)).rejects.toThrow('Expected')
})

it('prunes files older than 30 days and empty conversation directories, keeping recent output', async () => {
  const home = await temp()
  await pruneOutputs(home)
  const old = join(home, 'outputs/1/old.txt')
  const recent = join(home, 'outputs/2/recent.txt')
  await mkdir(join(home, 'outputs/1'), { recursive: true })
  await mkdir(join(home, 'outputs/2'), { recursive: true })
  await writeFile(old, 'old')
  await writeFile(recent, 'recent')
  const now = Date.now()
  await utimes(old, new Date(now - keepMs - 1), new Date(now - keepMs - 1))
  await pruneOutputs(home, now)
  await expect(readFile(old, 'utf8')).rejects.toThrow('ENOENT')
  await expect(readFile(join(home, 'outputs/1'))).rejects.toThrow('ENOENT')
  expect(await readFile(recent, 'utf8')).toBe('recent')
})

it('bounds long multibyte lines and keeps the durable marker last', async () => {
  const home = await temp()
  const longLines = Array.from({ length: 8 }, (_, i) => `warn ${i}: ${'警'.repeat(20000)}`).join(
    '\n',
  )
  const shortened = await offload(home, 1, call, { output: [{ type: 'text', text: longLines }] })
  const text = shortened?.output?.[0]
  if (text?.type !== 'text') throw new Error('Missing excerpt')
  expect(Buffer.byteLength(text.text)).toBeLessThan(22000)
  expect(text.text).toContain('chars]')
  expect(text.text).toContain('bytes not shown')
  expect(text.text.split('\n').at(-1)).toContain('Full output: ')
  expect(await readFile(join(home, 'outputs/1/call_unsafe.txt'), 'utf8')).toBe(longLines)
})

it('does not offload when the marker and excerpt would grow the original', async () => {
  const home = await temp()
  expect(
    await offload(
      home,
      1,
      call,
      { output: [{ type: 'text', text: 'small' }] },
      { thresholdBytes: 1, exclude: [] },
    ),
  ).toBeUndefined()
})

it('prefers the structured spill path and removes only the redundant full_output diagnostic after copying', async () => {
  const home = await temp()
  const spill = join(home, 'spill')
  await writeFile(spill, full)
  const shortened = await offload(home, 1, call, {
    output: [{ type: 'text', text: 'retained tail' }],
    structuredOutput: { fullOutputPath: spill },
    diagnostics: [
      { code: 'full_output', severity: 'info', message: 'Full output: /missing/spill' },
      { code: 'exit_code', severity: 'error', message: 'Command exited with code 1' },
    ],
  })
  expect(await readFile(join(home, 'outputs/1/call_unsafe.txt'), 'utf8')).toBe(full)
  expect(shortened?.diagnostics).toEqual([
    { code: 'exit_code', severity: 'error', message: 'Command exited with code 1' },
  ])
})
