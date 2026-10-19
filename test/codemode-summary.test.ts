import { expect, it } from 'vitest'
import { fixedLine, parseSummary, scrub, summaryInput } from '../extensions/codemode/summary.ts'

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

it('labels a failed read-only or empty script without the model, and asks it when a failure may follow a change', () => {
  const read = { name: 'ultimate.entries', args: [1], status: 'error' }
  expect(fixedLine([read], 'Error: Unknown conversation')).toEqual({
    line: 'Failed: Error: Unknown conversation',
  })
  expect(fixedLine([], 'SyntaxError: unexpected token')).toEqual({
    line: 'Failed: SyntaxError: unexpected token',
  })
  expect(fixedLine([], 'Error: token=abc123 rejected')).toEqual({
    line: 'Failed: Error: token=[redacted] rejected',
  })
  const write = { name: 'write', args: { path: 'a' }, status: 'ok' }
  expect(fixedLine([write], 'Error: later step failed')).toBeUndefined()
})

it('asks the model for actions, writes, commands and several calls', () => {
  const action = { name: 'ultimate.action', args: ['conversations', 'conclude', {}], status: 'ok' }
  expect(fixedLine([action])).toBeUndefined()
  expect(fixedLine([{ name: 'bash', args: { command: 'ls' }, status: 'ok' }])).toBeUndefined()
  expect(fixedLine([{ name: 'write', args: { path: 'a' }, status: 'ok' }])).toBeUndefined()
  const read = { name: 'ultimate.system', args: [], status: 'ok' }
  expect(fixedLine([read, read])).toBeUndefined()
})

it('sends only the calls and a failure, never the script or a result', () => {
  const conclude = {
    name: 'ultimate.action',
    args: ['conversations', 'conclude', { ids: [1] }],
    status: 'ok',
  }
  expect(JSON.parse(summaryInput([conclude]))).toEqual({
    calls: [
      { name: 'ultimate.action', status: 'ok', args: '["conversations","conclude",{"ids":[1]}]' },
    ],
  })
  expect(JSON.parse(summaryInput([], 'Error: no such conversation'))).toEqual({
    calls: [],
    error: 'Error: no such conversation',
  })
})

it('removes credentials from arguments and errors before they reach the summary model', () => {
  const input = summaryInput(
    [
      {
        name: 'ultimate.action',
        args: ['secrets', 'set', { name: 'GH', value: 'v', apiKey: 'sk-live-1' }],
        status: 'ok',
      },
      {
        name: 'bash',
        args: {
          command: 'curl -H "Authorization: Bearer ghp_abcdef123" https://x?token=s3cr3t',
        },
        status: 'ok',
      },
    ],
    'Error: password=hunter2 refused for ' + 'A'.repeat(40),
  )
  for (const secret of ['sk-live-1', 'ghp_abcdef123', 's3cr3t', 'hunter2', 'A'.repeat(40)])
    expect(input).not.toContain(secret)
  expect(scrub('see notes.md line 4')).toBe('see notes.md line 4')
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
