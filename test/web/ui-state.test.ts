import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord'
import { createUiState, WRITE_MARKER } from '../../web/src/sdk/ui-state.ts'
import type { UiUpdateRequest } from '../../shared/protocol.ts'
import { MachineOfflineError } from '../../web/src/sdk/api.ts'

/**
 * A tab against a fake server. A request is committed (`commit(i)`, returning the snapshot the stream would deliver)
 * and acknowledged (`ack(i)`) separately, so tests choose the order in which the stream and the HTTP answer arrive.
 */
function setup() {
  let doc: Record<string, JsonValue> = {}
  const requests: {
    change: UiUpdateRequest
    ack: () => void
    fail: (error: unknown) => void
  }[] = []
  const errors: unknown[] = []
  const state = createUiState(
    (change) =>
      new Promise((resolve, reject) =>
        requests.push({ change, ack: () => resolve({ ok: true }), fail: reject }),
      ),
    { delayMs: 5, tab: 'me', onError: (error) => errors.push(error) },
  )
  const apply = (set: Record<string, JsonValue> = {}, remove: readonly string[] = []) => {
    doc = { ...doc, ...set }
    for (const key of remove) delete doc[key]
    return { ...doc }
  }
  return {
    state,
    requests,
    errors,
    commit: (index: number) =>
      apply(requests[index].change.set, requests[index].change.delete ?? []),
    ack: (index: number) => requests[index].ack(),
    /** Another tab's write. */
    other: (set: Record<string, JsonValue>) => apply({ ...set, [WRITE_MARKER]: 'other:1' }),
    start: (set: Record<string, JsonValue>) => state.receive(apply(set)),
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const wait = (ms = 20) => vi.advanceTimersByTimeAsync(ms)
const marker = (batch: number) => ({ [WRITE_MARKER]: `me:${batch}` })

describe('durable UI state', () => {
  it('keeps offline browsing choices across replica snapshots and the write settle timeout', async () => {
    const { state, requests, errors, start } = setup()
    start({ 'shell.conversation': 1 })
    state.set('shell.conversation', 26)
    await wait()
    requests[0].fail(new MachineOfflineError('The machine is offline'))
    await wait(3000)
    start({ 'shell.conversation': 1 })
    expect(state.get('shell.conversation')).toBe(26)
    expect(errors).toEqual([])
    expect(requests).toHaveLength(1)
    state.set('shell.conversation', 32)
    await wait()
    expect(requests[1].change.set?.['shell.conversation']).toBe(32)
  })

  it('applies writes at once, sends them coalesced, and keeps them until the stream shows them', async () => {
    const { state, requests, commit, ack, other, start } = setup()
    const listener = vi.fn<() => void>()
    state.subscribe(listener)
    start({ 'shell.panelOpen': false, 'shell.surface': 'board' })

    state.set('shell.panelOpen', true)
    state.set('shell.panel', 'info')
    state.delete('shell.surface')
    expect(state.get('shell.panelOpen')).toBe(true)
    expect(state.get('shell.surface')).toBeUndefined()
    expect(listener).toHaveBeenCalled()

    await wait()
    expect(requests.map((request) => request.change)).toEqual([
      {
        set: { 'shell.panelOpen': true, 'shell.panel': 'info', ...marker(1) },
        delete: ['shell.surface'],
      },
    ])
    // A stream update from before the write does not undo it.
    state.receive({ 'shell.panelOpen': false, 'shell.surface': 'board', other: 1 })
    expect(state.get('shell.panelOpen')).toBe(true)
    expect(state.get('other')).toBe(1)

    const committed = commit(0)
    ack(0)
    await wait()
    state.receive(committed)
    // Confirmed: a later change from another tab shows through at once.
    state.receive(other({ 'shell.panelOpen': false }))
    expect(state.get('shell.panelOpen')).toBe(false)
    expect(state.get('shell.panel')).toBe('info')
  })

  it('sends one batch at a time, so the server commits writes in order', async () => {
    const { state, requests, ack, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'first')
    await wait()
    state.set('panel', 'second')
    state.set('panel', 'third')
    await wait()
    expect(requests).toHaveLength(1)
    ack(0)
    await wait()
    expect(requests.map((request) => request.change.set)).toEqual([
      { panel: 'first', ...marker(1) },
      { panel: 'third', ...marker(2) },
    ])
  })

  it('confirms by write identity: A → B → A never flashes B', async () => {
    const { state, requests, commit, ack, start } = setup()
    start({ panel: 'start' })
    // info, tasks, info: each committed and answered, while the stream lags behind all three.
    state.set('panel', 'info')
    await wait()
    const first = commit(0)
    ack(0)
    await wait()
    state.set('panel', 'tasks')
    await wait()
    const second = commit(1)
    ack(1)
    await wait()
    state.set('panel', 'info')
    await wait()
    expect(requests).toHaveLength(3)
    // The first commit equals the newest local value but is not its write.
    state.receive(first)
    expect(state.get('panel')).toBe('info')
    state.receive(second)
    expect(state.get('panel')).toBe('info')
    // The last write's answer comes before its commit streams in.
    const third = commit(2)
    ack(2)
    await wait()
    expect(state.get('panel')).toBe('info')
    state.receive(third)
    expect(state.get('panel')).toBe('info')
    // Settled by identity: another tab's later write shows at once.
    state.receive({ ...third, panel: 'agents', [WRITE_MARKER]: 'other:1' })
    expect(state.get('panel')).toBe('agents')
  })

  it('keeps its write when another tab wrote the same key just before', async () => {
    const { state, commit, ack, other, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'mine')
    await wait()
    // Another tab's commit lands before this tab's.
    state.receive(other({ panel: 'theirs' }))
    expect(state.get('panel')).toBe('mine')
    const mine = commit(0)
    ack(0)
    await wait()
    expect(state.get('panel')).toBe('mine')
    state.receive(mine)
    expect(state.get('panel')).toBe('mine')
  })

  it('skips no-op writes, drops refused writes, and keeps a newer write when an older batch fails', async () => {
    const refused = setup()
    refused.start({ panel: 'start' })
    refused.state.set('panel', 'start')
    await wait()
    expect(refused.requests).toHaveLength(0)
    refused.state.set('bad key', 1)
    expect(refused.state.get('bad key')).toBe(1)
    await wait()
    refused.requests[0].fail(new Error('Invalid UI key'))
    await wait()
    expect(refused.state.get('bad key')).toBeUndefined()
    expect(refused.errors).toHaveLength(1)

    const { state, requests, errors, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'first')
    state.set('view', 'board')
    await wait()
    state.set('panel', 'second')
    requests[0].fail(new Error('offline'))
    await wait()
    expect(errors).toHaveLength(1)
    // The failed batch's own key reverts; the key written again keeps its newer value and is sent next.
    expect(state.get('view')).toBeUndefined()
    expect(state.get('panel')).toBe('second')
    expect(requests[1].change.set).toEqual({ panel: 'second', ...marker(2) })
  })

  it('lets go of an acknowledged write the stream never names', async () => {
    const errors: unknown[] = []
    const state = createUiState(async () => ({ ok: true }), {
      delayMs: 5,
      settleMs: 30,
      tab: 'me',
      onError: (error) => errors.push(error),
    })
    state.receive({ panel: 'start' })
    state.set('panel', 'mine')
    await wait()
    // Another tab's commit in the same frame replaced the marker before the stream showed this tab's.
    state.receive({ panel: 'theirs', [WRITE_MARKER]: 'other:1' })
    expect(state.get('panel')).toBe('mine')
    await wait(60)
    expect(state.get('panel')).toBe('theirs')
    expect(errors).toHaveLength(0)
  })
})
