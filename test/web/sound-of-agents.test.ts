import { expect, it } from 'vitest'
import { demo, demoPlayer, tracker } from '../../extensions/sounds/agents.ts'
import type { Snapshot } from '../../extensions/sounds/agents.ts'

const snapshot = (extra: Partial<Snapshot> = {}): Snapshot => ({
  conversations: [],
  standing: new Set([2]),
  tools: {},
  streaming: 0,
  runs: {},
  events: [],
  ...extra,
})

it('turns project changes into happenings and a level, taking the first snapshot as heard', () => {
  const follow = tracker()
  const busy = snapshot({
    conversations: [
      { id: 2, label: 'agent', busy: true },
      { id: 10, label: 'coordinator', busy: true },
    ],
    tools: { '10:a': { name: 'bash', conversationId: 10 } },
    events: [{ id: 1, kind: 'event.workspaces.landed', data: {} }],
  })
  expect(follow(busy)).toEqual({
    happenings: [],
    level: { busy: { ultimate: 1, coordinator: 1 }, streaming: 0 },
  })
  const next = follow(
    snapshot({
      conversations: [
        { id: 2, label: 'agent', busy: false },
        { id: 10, label: 'coordinator', busy: true },
        { id: 11, label: 'worker', busy: true },
      ],
      streaming: 1,
      tools: {
        '10:a': { name: 'bash', conversationId: 10 },
        '11:b': { name: 'edit', conversationId: 11 },
      },
      runs: { '11': { runState: 'error', inputId: 3 } },
      events: [
        { id: 1, kind: 'event.workspaces.landed', data: {} },
        { id: 2, kind: 'event.coding-tools.committed', data: {} },
        { id: 3, kind: 'event.workspaces.check', data: { result: 'passed' } },
      ],
    }),
  )
  expect(next.happenings).toEqual([
    { kind: 'start', role: 'worker' },
    { kind: 'stop', role: 'ultimate' },
    { kind: 'tool', role: 'worker', tool: 'edit' },
    { kind: 'commit' },
    { kind: 'failed' },
  ])
  expect(next.level).toEqual({ busy: { coordinator: 1, worker: 1 }, streaming: 1 })
})

it('takes what a tab catches up on after a reconnect as heard', () => {
  const follow = tracker()
  follow(snapshot({ conversations: [{ id: 10, label: 'coordinator', busy: true }] }))
  // Back from hidden or a dropped stream: the snapshot and the event feed bring everything that happened meanwhile.
  const away = snapshot({
    conversations: [
      { id: 10, label: 'coordinator', busy: false },
      { id: 11, label: 'worker', busy: true },
    ],
    tools: { '11:a': { name: 'edit', conversationId: 11 } },
    runs: { '11': { runState: 'error', inputId: 1 } },
    events: [
      { id: 4, kind: 'event.workspaces.landed', data: {} },
      { id: 5, kind: 'event.coding-tools.committed', data: {} },
    ],
  })
  expect(follow(away, true).happenings).toEqual([])
  // Replayed again once caught up, it stays heard; only what is new from then on sounds.
  expect(follow(away).happenings).toEqual([])
  expect(
    follow({
      ...away,
      events: [...away.events, { id: 6, kind: 'event.coding-tools.committed', data: {} }],
    }).happenings,
  ).toEqual([{ kind: 'commit' }])
})

it('plays the demo from first message to a quiet project', () => {
  const step = demoPlayer()
  const played = demo.map(step)
  const kinds = new Set(played.map((p) => p.happening?.kind))
  expect([...kinds]).toEqual(
    expect.arrayContaining(['start', 'tool', 'commit', 'failed', 'landed', 'stop']),
  )
  expect(played.at(-1)!.level).toEqual({ busy: {}, streaming: 0 })
})
