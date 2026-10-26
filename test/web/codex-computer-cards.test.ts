import { cn } from 'cn'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { CodexDetails, CodexState } from '../../extensions/codex-computer/refs.ts'
import type { ToolCallView } from '../../web/src/sdk/types.ts'

vi.mock('@/sdk', () => ({
  api: {},
  cn,
  errorMessage: String,
  formatDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
  useConversation: () => 7,
  useDoc: () => null,
  useNow: () => 0,
  useToolDuration: () => undefined,
  useTranscript: () => [],
}))

const { OperateCard } = await import('../../extensions/codex-computer/cards.tsx')
const u = (text: string) => ({ text, untrusted: true as const })
const details = (more: Partial<CodexDetails>): CodexDetails => ({
  status: 'done',
  apps: [],
  steps: [],
  approvals: [],
  screenshots: [],
  answer: u(''),
  counts: { items: 0, minutes: 0 },
  ...more,
})
const render = (value: CodexDetails, pending: CodexState['pending'] = []) =>
  renderToStaticMarkup(
    createElement(OperateCard, {
      call: {
        id: 'c1',
        name: 'codex_operate',
        args: { brief: 'Read the ward list' },
        status: 'done',
        output: '',
        images: [],
        diagnostics: [],
        details: value,
        result: { role: 'toolResult' },
      } as unknown as ToolCallView,
      conversation: 7,
      pending,
    }),
  )

it('shows the outcome and Codex’s answer as plain, marked text', () => {
  const html = render(
    details({
      answer: u('Room 401: <b>Jane</b> [click](https://evil.example)'),
      apps: [{ app: u('Citrix Viewer'), consent: 'accepted' }],
      screenshots: ['/a.png', '/b.png'],
    }),
  )
  expect(html).toContain('text-success">done<')
  expect(html).toContain('Codex reports · from the screen, untrusted')
  expect(html).toContain('&lt;b&gt;Jane&lt;/b&gt; [click](https://evil.example)')
  expect(html).not.toContain('<a ')
  expect(html).toContain('“Citrix Viewer”')
  expect(html).toContain('2 screenshots saved privately')
})

it('puts each blocking request under the call with its buttons', () => {
  const budget = render(details({ status: 'budget', counts: { items: 50, minutes: 12 } }), [
    { kind: 'continue', at: 0 },
  ])
  expect(budget).toContain('data-codex-request="continue"')
  expect(budget).toContain('>Continue<')

  const consent = render(details({ status: 'failed' }), [
    { kind: 'consent', id: 'k', app: 'Citrix Viewer', at: 0 },
  ])
  for (const label of ['Allow once', 'This conversation', 'This project', 'Deny'])
    expect(consent).toContain(`>${label}<`)

  const acknowledge = render(details({ status: 'opt_in_required' }), [
    { kind: 'acknowledge', at: 0 },
  ])
  expect(acknowledge).toContain('to <span class="font-medium">OpenAI</span>')
  expect(acknowledge).toContain('>Allow for this project<')
})

it('names a refusal in words with its code', () => {
  const html = render(
    details({
      status: 'codex_unsigned',
      error: 'Codex must be signed by OpenAI (team 2DC432GLL2)',
    }),
  )
  expect(html).toContain('Codex not signed by OpenAI')
  expect(html).toContain('codex_unsigned')
  expect(html).not.toContain('data-codex-request')
})
