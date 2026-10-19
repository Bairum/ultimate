import { expect, it } from 'vitest'
import { fixedLine, parseSummary, summaryInput } from '../extensions/codemode/summary.ts'

it('labels a script with no call or one read-only call without the model', () => {
  expect(fixedLine([])).toEqual({ line: 'Ran a script without tool calls' })
  expect(fixedLine([{ name: 'ultimate.api', args: ['conversations'], status: 'ok' }])).toEqual({
    line: "Read the conversations extension's contract",
  })
  expect(fixedLine([{ name: 'ultimate.entries', args: [97078, {}], status: 'ok' }])).toEqual({
    line: 'Read the history of #97078',
  })
  expect(fixedLine([{ name: 'read', args: { path: '/a/b/notes.md' }, status: 'ok' }])).toEqual({
    line: 'Read notes.md',
  })
})

it('asks the model for actions, writes, commands and several calls', () => {
  const action = { name: 'ultimate.action', args: ['conversations', 'conclude', {}], status: 'ok' }
  expect(fixedLine([action])).toBeUndefined()
  expect(fixedLine([{ name: 'bash', args: { command: 'ls' }, status: 'ok' }])).toBeUndefined()
  expect(fixedLine([{ name: 'write', args: { path: 'a' }, status: 'ok' }])).toBeUndefined()
  const read = { name: 'ultimate.system', args: [], status: 'ok' }
  expect(fixedLine([read, read])).toBeUndefined()
})

it('sends the script, each call and a clipped result as data', () => {
  const input = JSON.parse(
    summaryInput(
      'return 1',
      [
        {
          name: 'ultimate.action',
          args: ['conversations', 'conclude', { ids: [1] }],
          status: 'ok',
        },
      ],
      'x'.repeat(5000),
    ),
  ) as { script: string; calls: { name: string; args: string }[]; result: string }
  expect(input.script).toBe('return 1')
  expect(input.calls[0]).toEqual({
    name: 'ultimate.action',
    status: 'ok',
    args: '["conversations","conclude",{"ids":[1]}]',
  })
  expect(input.result.length).toBeLessThan(1600)
})

it('parses the line and effect, and rejects anything else', () => {
  expect(parseSummary('{"line":"Concluded 2 conversations (#1, #2)","effect":true}')).toEqual({
    line: 'Concluded 2 conversations (#1, #2)',
    effect: true,
  })
  expect(parseSummary('```json\n{"line":" Read the overview ","effect":false}\n```')).toEqual({
    line: 'Read the overview',
  })
  expect(() => parseSummary('{"effect":true}')).toThrow('No summary object')
  expect(() => parseSummary('Concluded things')).toThrow('No summary object')
})
