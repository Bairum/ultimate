/**
 * Real codemode calls @ultimate (#97078) made while wrapping up branches, trimmed, with the lines the summary model
 * wrote for them, for `seedCodemode`.
 */
import type { JsonValue } from '@earendil-works/chord'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { CallSummary } from '../codemode/refs.ts'

type Step = {
  tool: string
  args: JsonObject
  result: string
  details?: JsonObject
  error?: boolean
  summary?: CallSummary
}
const done = (value: unknown) => `Script completed\nOutput:\n${JSON.stringify(value)}`
const call = (name: string, args: JsonValue[], ms = 12): JsonObject => ({
  name,
  args,
  status: 'ok',
  ms,
})

export const codemodeSteps: Step[] = [
  {
    tool: 'codemode',
    args: {
      code: 'const cs = await ultimate.conversations(); const g = await ultimate.taskGraph();\nreturn cs.filter(c => !c.owner).slice(0, 5).map(c => ({ id: c.id }));',
    },
    result: done([{ id: 1 }, { id: 14 }, { id: 87 }]),
    details: {
      calls: [call('ultimate.conversations', []), call('ultimate.taskGraph', [])],
      value: [{ id: 1 }, { id: 14 }, { id: 87 }],
    },
    summary: { line: 'Listed unowned conversations #1, #14, #87 and read the task graph' },
  },
  {
    tool: 'codemode',
    args: { code: "const a = await ultimate.api('conversations'); return a.slice(0, 400)" },
    result: done('// conversations/api.ts: the server contract …'),
    details: {
      calls: [call('ultimate.api', ['conversations'])],
      value: '// conversations/api.ts: the server contract …',
    },
    summary: { line: "Read the conversations extension's contract" },
  },
  {
    tool: 'bash',
    args: { command: 'git log --oneline -5 main' },
    result:
      '367b8c1 fix(system): walk a parent cycle once\nab7c4c2 fix(system): keep cyclic lanes\n9abe373 Merge main',
  },
  {
    tool: 'codemode',
    args: {
      code: "const r = await ultimate.action('conversations', 'conclude', {ids: [190416, 190537, 195420, 197140, 197459, 197623]}); return r;",
    },
    result: done({ concluded: [190416, 190537, 195420, 197140, 197459, 197623], kept: [] }),
    details: {
      calls: [
        call(
          'ultimate.action',
          ['conversations', 'conclude', { ids: [190416, 190537, 195420, 197140, 197459, 197623] }],
          84,
        ),
      ],
      value: { concluded: [190416, 190537, 195420, 197140, 197459, 197623], kept: [] },
    },
    summary: { line: 'Concluded 6 conversations (#190416, #190537, …)', effect: true },
  },
  {
    tool: 'codemode',
    args: {
      code: "const c = await ultimate.catalogue(); const ex = await ultimate.extensions(); text(JSON.stringify({apis: c.apis.length, cycles: c.cycles, n: ex.length}));\nconst r = await ultimate.action('automations', 'pause', {id: 'A7'}); text('timer: ' + r.enabled);",
    },
    result: 'Script completed\nOutput:\n{"apis":12,"cycles":[],"n":40}\ntimer: false',
    details: {
      calls: [
        call('ultimate.catalogue', []),
        call('ultimate.extensions', []),
        call('ultimate.action', ['automations', 'pause', { id: 'A7' }], 31),
      ],
    },
    summary: { line: 'Paused automation A7', effect: true },
  },
  {
    tool: 'codemode',
    args: {
      code: "const hits = await ultimate.search('\"provider\":\"openai\"', {limit: 200}); text('total ' + hits.length);\nconst s2 = await ultimate.search('openai/gpt-6', {limit: 50}); text(s2.length);",
    },
    result: 'Script completed\nOutput:\ntotal 200\n15',
    details: {
      calls: [
        call('ultimate.search', ['"provider":"openai"', { limit: 200 }], 240),
        call('ultimate.search', ['openai/gpt-6', { limit: 50 }], 180),
      ],
    },
    summary: {
      line: 'Searched history for "provider":"openai" and openai/gpt-6 (200 and 15 hits)',
    },
  },
  {
    tool: 'codemode',
    args: {
      code: "return await ultimate.action('conversations','conclude',{ids:[34790,34804,34820,35701]});",
    },
    result:
      'Script failed\nOutput:\nError: Conversation 34790 is owned, not a top-level conversation',
    error: true,
    details: {
      calls: [
        {
          ...call('ultimate.action', [
            'conversations',
            'conclude',
            { ids: [34790, 34804, 34820, 35701] },
          ]),
          status: 'error',
        },
      ],
      error: 'Error: Conversation 34790 is owned, not a top-level conversation',
    },
    summary: { line: 'Failed to conclude #34790: owned, not top-level' },
  },
  {
    tool: 'read',
    args: { path: 'extensions/conversations/README.md', limit: 40 },
    result: '# Conversations\n\nTitles, summaries, the summary model and concluding conversations.',
  },
]
