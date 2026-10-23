import { expect, vi } from 'vitest'
import type { Seed } from '../extensions/dream/types.ts'

export const gateSeed = (): Seed => ({
  from: { name: 'the-beginning', number: 1 },
  session: 1,
  journal: {
    learned: ['One', 'Two', 'Three'],
    text: 'Journal',
    chapter: 'fresh-roots',
    at: 1,
    proposals: [],
  },
  memories: { lesson: { kind: 'lesson', line: 'Read first', body: 'Read the code', updated: 1 } },
  todos: [{ text: 'Do this', owner: 'ultimate' }],
  questions: [{ text: 'Which?', ref: '#123' }],
  automations: [{ name: 'Daily', prompt: 'Review', schedule: { kind: 'every', ms: 86400000 } }],
  subscriptions: [
    { id: 'S1', title: 'User watch', ask: 'Watch' },
    { id: 'ci', scope: 'project', title: 'CI', ask: 'Watch CI' },
  ],
  counts: { memories: 1, todos: 1, questions: 1, automations: 1, subscriptions: 2 },
})

/** A remote instance's actions, not a model. Overrides exercise each observable invariant. */
export function inspection(
  seed: () => Seed,
  overrides: () => Record<string, unknown> = () => ({}),
  searched: () => void = () => {},
) {
  const fetcher = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
    async (input, init) => {
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({
        Origin: 'http://127.0.0.1:12345',
        'Content-Type': 'application/json',
      })
      const { args } = JSON.parse(init.body as string)
      const current = seed()
      const values: Record<string, unknown> = {
        'lineage.memory': { memories: current.memories },
        todos: {
          items: Array.from(
            {
              length:
                current.counts.todos +
                current.counts.questions +
                current.subscriptions.filter((item) => item.scope !== 'project').length,
            },
            () => ({}),
          ),
        },
        'ultimate.standing-agents': { ultimate: 20 },
        'dream.seed': {
          automations: current.automations.map((item) => item.name),
        },
        entries: [{ kind: 'dream.chapter', conversationId: 20 }],
        ...overrides(),
      }
      let result: unknown
      expect(input).toBe('http://127.0.0.1:12345/api/extensions/codemode/actions/read')
      if (args.op === 'search') {
        expect(args.args).toEqual(['"kind":"dream.chapter"', { conversationId: 20, limit: 1 }])
        searched()
        result = values.entries
      } else {
        expect(args.op).toBe('doc')
        expect(args.args[1]).toBe(1)
        result = values[args.args[0]]
      }
      return new Response(JSON.stringify({ result }))
    },
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
