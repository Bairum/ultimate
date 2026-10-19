import { createElement, Fragment, useContext } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ExtensionRecord } from '../../web/src/sdk/registry.ts'
import { definePoint, defineWebExtension, provide } from '../../web/src/sdk/types.ts'
import { ExtensionNameContext } from '../../web/src/sdk/hooks.ts'
import { Provided } from '../../web/src/app/boundary.tsx'

const state = vi.hoisted(() => ({ records: [] as ExtensionRecord[] }))
// The real hooks connect to a server; Provided needs only the extension name context and the installed facets.
vi.mock('../../web/src/sdk/hooks.ts', async () => ({
  ExtensionNameContext: (await import('react')).createContext<string | undefined>(undefined),
  useExtensions: () => state.records,
  useSystem: () => undefined,
}))

const Label = definePoint<number, string>('low.label')
const record = (name: string, version: number, use: (id: number) => string): ExtensionRecord => ({
  name,
  version,
  loading: false,
  extension: defineWebExtension({ provides: [provide(Label, use)] }),
})
const Owner = () => createElement(Fragment, null, `[${useContext(ExtensionNameContext)}]`)
/** What `low` renders for conversation 7, and the extension its elements believe they belong to. */
function render() {
  return renderToStaticMarkup(
    createElement(
      ExtensionNameContext.Provider,
      { value: 'low' },
      createElement(Provided<number, string>, {
        point: Label,
        input: 7,
        children: (label) => createElement(Fragment, null, label ?? 'none', createElement(Owner)),
      }),
    ),
  )
}

it('renders with undefined while no facet provides the point', () => {
  state.records = [{ name: 'low', version: 1, loading: false, extension: {} }]
  expect(render()).toBe('none[low]')
})

it("renders with the last provider's value, keeping the caller's extension name", () => {
  state.records = [
    record('high', 1, (id) => `high #${id}`),
    record('higher', 1, (id) => `higher #${id}`),
  ]
  expect(render()).toBe('higher #7[low]')
})
