import { describe, expect, it, vi } from 'vitest'
import { createDriver } from '../extensions/computer-use/driver.ts'
import { parseObservation } from '../extensions/computer-use/observation.ts'
import { createFakeDriver } from './computer-use-fake-driver.ts'

const expectedVersion = '0.37.0'

describe('Cua Driver client', () => {
  it('connects to the pinned Driver and runs a Calculator sequence', async () => {
    const fake = createFakeDriver()
    const driver = await createDriver({ connect: fake.connect, expectedVersion })
    try {
      expect(driver.version).toBe(expectedVersion)
      for (const label of ['All Clear', '6', 'Multiply', '7', 'Equals']) {
        const observation = parseObservation(
          await driver.call('get_window_state', { full_output: true }),
          'Calculator',
        )
        const element = observation.elements.find((candidate) => candidate.label === label)!
        expect((await driver.call('click', { element_token: element.token })).ok).toBe(true)
      }
      const observation = parseObservation(await driver.call('get_window_state', {}), 'Calculator')
      expect(observation.elements.find((element) => element.role === 'AXStaticText')?.value).toBe(
        '42',
      )
      expect(fake.calls.map((call) => call.tool)).toEqual([
        'get_window_state',
        'click',
        'get_window_state',
        'click',
        'get_window_state',
        'click',
        'get_window_state',
        'click',
        'get_window_state',
        'click',
        'get_window_state',
      ])
    } finally {
      await driver.close()
    }
  })

  it.each([{ version: '0.38.0' }, { name: 'not-cua-driver' }])(
    'rejects a mismatched handshake: %j',
    async (options) => {
      const fake = createFakeDriver(options)
      await expect(createDriver({ connect: fake.connect, expectedVersion })).rejects.toThrow(
        `Expected cua-driver 0.37.0; received ${options.name ?? 'cua-driver'} ${options.version ?? '0.37.0'}. Install with: CUA_DRIVER_RS_VERSION=0.37.0 bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`,
      )
    },
  )

  it('maps text, images, structured content, errors and refusals', async () => {
    const fake = createFakeDriver()
    const driver = await createDriver({ connect: fake.connect, expectedVersion })
    try {
      fake.replyNext({
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          { type: 'text', text: 'two' },
        ],
        structuredContent: { status: 'ok', pid: 123 },
      })
      expect(await driver.call('get_window_state', {})).toEqual({
        ok: true,
        text: 'one\ntwo',
        images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        structured: { status: 'ok', pid: 123 },
      })
      fake.refuseNext('stale_element_token', 'Observe again', 'Get a new snapshot')
      expect(await driver.call('click', { element_token: 'old:1' })).toMatchObject({
        ok: false,
        refusal: {
          code: 'stale_element_token',
          message: 'Observe again',
          hint: 'Get a new snapshot',
        },
      })
      fake.replyNext({ isError: true, content: [{ type: 'text', text: 'failed' }] })
      expect(await driver.call('click', {})).toEqual({
        ok: false,
        text: 'failed',
        images: [],
        structured: undefined,
      })
    } finally {
      await driver.close()
    }
  })

  it('never retries an uncertain call and reconnects on the next call', async () => {
    const fake = createFakeDriver()
    const driver = await createDriver({ connect: fake.connect, expectedVersion })
    try {
      fake.dropNext()
      await expect(driver.call('click', { element_token: 's1:7' })).rejects.toThrow(
        'connection closed; the step may or may not have run',
      )
      expect(fake.connections).toBe(1)
      expect(fake.calls).toEqual([{ tool: 'click', args: { element_token: 's1:7' } }])
      expect((await driver.call('list_apps', {})).ok).toBe(true)
      expect(fake.connections).toBe(2)
      await fake.disconnect()
      expect((await driver.call('list_apps', {})).ok).toBe(true)
      expect(fake.connections).toBe(3)
    } finally {
      await driver.close()
    }
  })

  it('stops the daemon and reconnects only when called again; close is final', async () => {
    const fake = createFakeDriver()
    const stopCommand = vi.fn<() => Promise<void>>(async () => {})
    const driver = await createDriver({ connect: fake.connect, stopCommand, expectedVersion })
    await driver.stop()
    expect(stopCommand).toHaveBeenCalledOnce()
    expect(fake.connections).toBe(1)
    await driver.call('list_apps', {})
    expect(fake.connections).toBe(2)
    await driver.close()
    await expect(driver.call('list_apps', {})).rejects.toThrow('Driver client is closed')
  })
})

describe('parseObservation', () => {
  it('reads the full structured snapshot and its optional screenshot', () => {
    const observation = parseObservation(
      {
        ok: true,
        text: '',
        images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        structured: {
          pid: 803,
          window_id: 22,
          window_title: 'Agent Window',
          snapshot_id: 's000000ae',
          tree_markdown: 'AXWindow\n  AXTextArea AGENT WINDOW:',
          truncated: false,
          returned_element_count: 2,
          total_element_count: 2,
          timeout_ms: 5000,
          walk_elapsed_ms: 125,
          capture_id: 'cap1',
          screenshot_width: 1312,
          screenshot_height: 768,
          screenshot_scale: 2,
          elements: [
            {
              element_index: 0,
              element_token: 's000000ae:0',
              depth: 0,
              role: 'AXWindow',
              actions: [],
            },
            {
              actions: ['AXShowMenu'],
              depth: 1,
              element_index: 1,
              element_token: 's000000ae:1',
              frame: { h: 384, w: 656, x: 337, y: 240 },
              label: 'AGENT WINDOW:',
              parent_index: 0,
              role: 'AXTextArea',
              value: 'AGENT WINDOW:',
            },
          ],
        },
      },
      'TextEdit',
    )
    expect(observation).toEqual({
      app: 'TextEdit',
      pid: 803,
      windowId: 22,
      title: 'Agent Window',
      snapshot: 's000000ae',
      tree: 'AXWindow\n  AXTextArea AGENT WINDOW:',
      truncated: false,
      capture: { id: 'cap1', width: 1312, height: 768, scale: 2 },
      image: { data: 'aGVsbG8=', mimeType: 'image/png' },
      elements: [
        { token: 's000000ae:0', index: 0, depth: 0, role: 'AXWindow', enabled: false, actions: [] },
        {
          token: 's000000ae:1',
          index: 1,
          parent: 0,
          depth: 1,
          role: 'AXTextArea',
          label: 'AGENT WINDOW:',
          value: 'AGENT WINDOW:',
          enabled: true,
          actions: ['AXShowMenu'],
          frame: { h: 384, w: 656, x: 337, y: 240 },
        },
      ],
    })
  })

  it('names a missing required field', () => {
    expect(() =>
      parseObservation(
        { ok: true, text: '', images: [], structured: { elements: [] } },
        'Calculator',
      ),
    ).toThrow('missing or invalid pid')
  })
})
