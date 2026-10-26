import { cn } from 'cn'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { CodexDetails } from '../../extensions/codex-computer/refs.ts'
import type { ToolCallView } from '../../web/src/sdk/types.ts'

vi.mock('@/sdk', () => ({
  api: {},
  cn,
  errorMessage: String,
  useConversation: () => 7,
  useToolDuration: () => undefined,
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
  guidance: [],
  ...more,
})
const render = (value: CodexDetails) =>
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

it('a running card offers Tell Codex… and shows a steer in its step stream', () => {
  const html = renderToStaticMarkup(
    createElement(OperateCard, {
      call: {
        id: 'c1',
        name: 'codex_operate',
        args: { brief: 'Read the ward list' },
        status: 'running',
        output:
          'Codex session started.\nStep 1: <untrusted_screen_content>\ncua_repl/js\n</untrusted_screen_content>\nGuidance from the user: Maximise Citrix first\n',
        images: [],
        diagnostics: [],
      } as unknown as ToolCallView,
      conversation: 7,
    }),
  )
  expect(html).toContain('placeholder="Tell Codex…"')
  expect(html).toContain('↳ Guidance from the user: Maximise Citrix first')
  expect(html).toContain('1 step<')
})
