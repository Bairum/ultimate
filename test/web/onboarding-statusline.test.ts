import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ dismissed: false }))
vi.mock('@/sdk', () => ({
  api: {},
  Card: () => null,
  defineWebExtension: (facet: unknown) => facet,
  errorMessage: String,
  useAction: () => ({ data: { reason: 'Not a Git repository' }, refetch: async () => undefined }),
  useConversation: () => false,
  useDialog: () => [false, () => {}],
  useDocOf: () => ({ roots: {}, dismissed: state.dismissed }),
  useEvent: () => {},
  useExtensions: () => [{ name: 'workspaces' }],
  useSystem: () => ({ project: { config: true, decision: null } }),
  useTranscript: () => [],
  useUltimate: () => ({}),
}))
vi.mock('../../extensions/onboarding/pages.tsx', () => ({}))
vi.mock('../../extensions/onboarding/survey.tsx', () => ({ StartComposer: () => null }))
vi.mock('../../extensions/onboarding/panel.tsx', () => ({ ExtensionsPanel: () => null }))
vi.mock('../../extensions/workspaces/ui.tsx', () => ({ IsolationAction: {} }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: () => null,
}))

async function statusLine(dismissed: boolean) {
  state.dismissed = dismissed
  const facet = (await import('../../extensions/onboarding/web.tsx')).default as unknown as {
    slots: { 'statusline.right': { component: ComponentType }[] }
  }
  return facet.slots['statusline.right']
    .map(({ component }) => renderToStaticMarkup(createElement(component)))
    .join('')
}

it('drops project setup and set up git from the status line once Start here is dismissed', async () => {
  expect(await statusLine(false)).toMatch(/set up git.*project setup/)
  expect(await statusLine(true)).toBe('')
})
