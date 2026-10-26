import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { PickableWindow } from '../../extensions/computer-use/refs.ts'

vi.mock('@/sdk', () => ({
  api: { action: () => new Promise(() => {}) },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  errorMessage: String,
}))

const { WindowPicker, filterWindows, startWindows, suggestedPick } =
  await import('../../extensions/computer-use/teach-picker.tsx')

const window = (
  w: Partial<PickableWindow> & Pick<PickableWindow, 'app' | 'window' | 'title'>,
): PickableWindow => ({
  pid: 100 + w.window,
  onScreen: true,
  currentSpace: true,
  consent: 'granted',
  ...w,
})
const windows = [
  window({ app: 'Safari', window: 1, title: 'Start Page' }),
  window({
    app: 'Citrix Viewer',
    window: 2,
    title: 'OpsMate AI - Microsoft\u200B Edge',
    currentSpace: false,
    onScreen: false,
  }),
  window({ app: 'Citrix Viewer', window: 3, title: 'Network Drive (E: on MacBook_Pro__3_)' }),
  window({ app: 'Notes', window: 4, title: 'Groceries', consent: 'required' }),
  window({ app: 'Mail', window: 5, title: 'Inbox', consent: 'denied' }),
]

it('finds a title with an invisible character by what the user reads', () => {
  expect(filterWindows(windows, 'microsoft edge').map((w) => w.window)).toEqual([2])
  expect(filterWindows(windows, 'citrix').map((w) => w.window)).toEqual([2, 3])
  expect(filterWindows(windows, '  ')).toHaveLength(windows.length)
})

it('builds the start payload in tick order, sending match only when narrowed', () => {
  expect(
    startWindows(windows, [
      { window: 3, match: 'Network Drive (E: on MacBook_Pro__3_)' },
      { window: 2, match: 'OpsMate AI' },
      { window: 99, match: 'closed since' },
    ]),
  ).toEqual([
    { app: 'Citrix Viewer', window: 3 },
    { app: 'Citrix Viewer', window: 2, match: 'OpsMate AI' },
  ])
})

it('suggests the frontmost window of the last app, never a denied one', () => {
  expect(suggestedPick(windows, 'citrix viewer')?.window).toBe(2)
  expect(suggestedPick(windows, 'Mail')).toBeUndefined()
  expect(suggestedPick(windows, '')).toBeUndefined()
})

it('offers Allow for an app needing consent, badges off-screen windows, and locks denied ones', () => {
  const html = renderToStaticMarkup(
    createElement(WindowPicker, {
      conversation: 1,
      listed: { data: { windows }, loading: false, refetch: async () => undefined },
      picks: [{ window: 2, match: 'OpsMate AI' }],
      onPicks: () => {},
    }),
  )
  expect(html.match(/data-teach-allow="([^"]+)"/g)).toEqual(['data-teach-allow="Notes"'])
  expect(html).toContain('other Space')
  expect(html).toContain('denied')
  expect(html).toContain('value="OpsMate AI"')
  expect(html).toContain('1 of 6')
})
