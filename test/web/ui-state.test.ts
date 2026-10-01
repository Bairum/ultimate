import { describe, expect, it, vi } from 'vitest'
import { createUiState } from '../../web/src/sdk/ui-state.ts'
import type { UiUpdateRequest } from '../../shared/protocol.ts'

function setup() {
  const writes: UiUpdateRequest[] = []
  const done: (() => void)[] = []
  const write = vi.fn<(change: UiUpdateRequest) => Promise<unknown>>(
    (change) =>
      new Promise((resolve) => {
        writes.push(change)
        done.push(() => resolve({ ok: true }))
      }),
  )
  const state = createUiState(write, { delayMs: 5 })
  return { state, write, writes, done }
}
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe('durable UI state', () => {
  it('applies writes at once, sends them coalesced, and keeps them until the stream confirms', async () => {
    const { state, writes, done } = setup()
    const listener = vi.fn<() => void>()
    state.subscribe(listener)
    state.receive({ 'shell.panelOpen': false, 'shell.view': 'board' })

    state.set('shell.panelOpen', true)
    state.set('shell.panel', 'info')
    state.delete('shell.view')
    expect(state.snapshot()).toEqual({ 'shell.panelOpen': true, 'shell.panel': 'info' })
    expect(listener).toHaveBeenCalled()

    await wait()
    expect(writes).toEqual([
      { set: { 'shell.panelOpen': true, 'shell.panel': 'info' }, delete: ['shell.view'] },
    ])
    // A stream update from before the write does not undo it.
    state.receive({ 'shell.panelOpen': false, 'shell.view': 'board', other: 1 })
    expect(state.snapshot()).toEqual({ 'shell.panelOpen': true, 'shell.panel': 'info', other: 1 })

    done[0]()
    await wait()
    state.receive({ 'shell.panelOpen': true, 'shell.panel': 'info', other: 1 })
    // Confirmed: a later change from another tab shows through.
    state.receive({ 'shell.panelOpen': false, 'shell.panel': 'info', other: 1 })
    expect(state.get('shell.panelOpen')).toBe(false)
  })

  it('skips writes that change nothing and drops a write the server refused', async () => {
    const errors: unknown[] = []
    const state = createUiState(async () => Promise.reject(new Error('Invalid UI key')), {
      delayMs: 5,
      onError: (error) => errors.push(error),
    })
    state.receive({ 'shell.view': 'board' })
    state.set('shell.view', 'board')
    state.set('bad key', 1)
    expect(state.get('bad key')).toBe(1)
    await wait()
    expect(state.get('bad key')).toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})
