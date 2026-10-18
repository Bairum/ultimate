import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { Transition } from '../../cloud/protocol.ts'
import { movedAway, TransitionCard } from '../../extensions/cloud/transition.tsx'

// The card only formats action errors with the SDK; the rest of it needs a browser.
vi.mock('@/sdk', () => ({ errorMessage: String }))

const at = new Date(2026, 9, 18, 13, 51).getTime()
const moved = (patch: Partial<Transition> = {}): Transition => ({
  id: 'move-1',
  target: 'haza-pc',
  from: 'rog',
  by: 'sync',
  step: 'claim',
  steps: [
    { name: 'fetch', state: 'done' },
    { name: 'claim', state: 'done' },
  ],
  cancellable: false,
  startedAt: at,
  ...patch,
})
const rog = {
  machine: 'rog',
  role: 'standby' as const,
  writer: {
    machine: 'haza-pc',
    root: '/p',
    epoch: 2,
    online: true,
    secrets: [],
    secretsComplete: true,
  },
}

it('tells the machine the project moved away from that Move here pulls it back', () => {
  expect(movedAway({ ...rog, transition: moved() }, 'Moved to haza-pc')).toBe(
    'The project moved to haza-pc (by @sync · 13:51). Move here pulls it back to rog.',
  )
  expect(movedAway({ ...rog, transition: moved({ by: 'cloud' }) }, undefined)).toBe(
    'The project moved to haza-pc (started from the cloud UI · 13:51). Move here pulls it back to rog.',
  )
  // Without the finished move, its standby reason still says where it went.
  expect(movedAway(rog, 'Moved to haza-pc')).toBe(
    'The project moved to haza-pc. Move here pulls it back to rog.',
  )
  // A move that is still running, or one this machine took no part in, is not a give-away.
  expect(
    movedAway({ ...rog, transition: moved({ steps: [{ name: 'claim', state: 'running' }] }) }, ''),
  ).toBeUndefined()
  expect(movedAway({ ...rog, transition: moved({ from: 'mac' }) }, '')).toBeUndefined()
  // Released, it keeps the "Released · resume here" wording; serving, it has nothing to pull back.
  expect(
    movedAway({ ...rog, writer: { ...rog.writer, machine: null } }, 'Released · resume here'),
  ).toBeUndefined()
  expect(movedAway({ ...rog, role: 'writer' }, 'Moved to haza-pc')).toBeUndefined()
  // The project moved on since: the old reason no longer names where it runs.
  expect(
    movedAway({ ...rog, writer: { ...rog.writer, machine: 'mac' } }, 'Moved to haza-pc'),
  ).toBeUndefined()
})

/** The card header's text. */
const header = (transition: Transition) =>
  /<header[^>]*>.*<\/header>/s
    .exec(renderToStaticMarkup(createElement(TransitionCard, { transition })))![0]
    .replace(/<[^>]+>/g, '')
    .replaceAll('&#x27;', "'")

it('lists what a held handover waits for: the running conversations, then the worktrees', () => {
  const holding = (patch: Partial<Transition>) =>
    renderToStaticMarkup(
      createElement(TransitionCard, {
        transition: moved({
          step: 'handover',
          steps: [{ name: 'handover', state: 'running', detail: 'finishing 2 runs' }],
          ...patch,
        }),
      }),
    ).replaceAll('&#x27;', "'")
  const busy = holding({ waiting: ['#12 Review the lease', '#14'] })
  expect(busy).toContain('show 2 conversations')
  expect(busy).toContain('#12 Review the lease')
  expect(busy).toContain('Handing over: rog finishing 2 runs')
  const dirty = holding({
    steps: [
      {
        name: 'handover',
        state: 'running',
        detail: 'waiting for 1 worktree with uncommitted changes',
      },
    ],
    left: ['/w/feature'],
  })
  expect(dirty).toContain('show the worktree')
  expect(dirty).toContain('/w/feature')
  expect(dirty).not.toContain('conversation')
})

it('names who started the move in the card header', () => {
  const running = moved({ steps: [{ name: 'fetch', state: 'running' }], step: 'fetch' })
  expect(header({ ...running, by: 'cloud' })).toBe('Preparing haza-pc · started from the cloud UI')
  expect(header({ ...running, by: 'sync' })).toBe('Preparing haza-pc · by @sync')
  expect(header({ ...running, by: 'local' })).toBe("Preparing haza-pc · from haza-pc's page")
  expect(header({ ...running, by: 'auto' })).toBe('Preparing haza-pc · automatically')
  expect(header({ ...running, by: undefined })).toBe('Preparing haza-pc')
})
