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

  it('never lets an older batch bring back a value written after it', async () => {
    const { state, writes, done } = setup()
    state.receive({ panel: 'start' })
    state.set('panel', 'first')
    await wait()
    state.set('panel', 'second')
    await wait()
    expect(writes).toEqual([
      { set: { panel: 'first' }, delete: [] },
      { set: { panel: 'second' }, delete: [] },
    ])
    // Both commits stream in before either save answers.
    state.receive({ panel: 'first' })
    expect(state.get('panel')).toBe('second')
    state.receive({ panel: 'second' })
    done[0]()
    await wait()
    expect(state.get('panel')).toBe('second')
    done[1]()
    await wait()
    expect(state.get('panel')).toBe('second')
    // Settled: another tab's later write shows at once, not after a timeout.
    state.receive({ panel: 'third' })
    expect(state.get('panel')).toBe('third')
  })

  it('settles when the saves answer before the stream, in either order', async () => {
    const { state, done } = setup()
    state.receive({ panel: 'start' })
    state.set('panel', 'first')
    await wait()
    state.set('panel', 'second')
    await wait()
    done[1]()
    done[0]()
    await wait()
    expect(state.get('panel')).toBe('second')
    state.receive({ panel: 'first' })
    expect(state.get('panel')).toBe('second')
    state.receive({ panel: 'second' })
    state.receive({ panel: 'third' })
    expect(state.get('panel')).toBe('third')
  })

  it('keeps a newer write when an older batch fails', async () => {
    const errors: unknown[] = []
    const answers: { resolve: () => void; reject: (error: unknown) => void }[] = []
    const state = createUiState(
      () => new Promise((resolve, reject) => answers.push({ resolve: () => resolve({}), reject })),
      { delayMs: 5, onError: (error) => errors.push(error) },
    )
    state.receive({ panel: 'start' })
    state.set('panel', 'first')
    state.set('view', 'board')
    await wait()
    state.set('panel', 'second')
    await wait()
    expect(answers).toHaveLength(2)
    answers[0].reject(new Error('offline'))
    await wait()
    expect(errors).toHaveLength(1)
    // The failed batch's own key reverts; the key written again keeps its newer value.
    expect(state.get('view')).toBeUndefined()
    expect(state.get('panel')).toBe('second')
    answers[1].resolve()
    state.receive({ panel: 'second' })
    expect(state.get('panel')).toBe('second')
  })
})
