import type { Message } from '@earendil-works/pi-ai'
import { expect, it, vi } from 'vitest'
import { elideObservations } from '../extensions/computer-use/elide.ts'
import {
  observedOutput,
  judgeValueEquals,
  splitValueEquals,
} from '../extensions/computer-use/observe.ts'
import type { Observation } from '../extensions/computer-use/types.ts'

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  resizeImage: async (data: Buffer, mimeType: string) => ({
    data: data.toString('base64'),
    mimeType,
  }),
}))
const png = 'AAAA'
function observation(n: number, tree = 'AXWindow'): Observation {
  return {
    app: 'Calculator',
    pid: 1,
    windowId: 2,
    title: 'Calculator',
    snapshot: `s${n}`,
    elements: [],
    tree,
    truncated: false,
    capture: { id: `c${n}`, width: 10, height: 10, scale: 1 },
  }
}
/** A computer_act-style result: step summary, observation text, optional image. */
async function result(n: number, image: boolean): Promise<Message> {
  const view = await observedOutput(
    { ...observation(n), ...(image ? { image: { data: png, mimeType: 'image/png' } } : {}) },
    1568,
  )
  return {
    role: 'toolResult',
    toolCallId: `t${n}`,
    toolName: 'computer_act',
    content: [
      {
        type: 'text',
        text: '<untrusted_screen_content>\n{"status":"delivered"}\n</untrusted_screen_content>',
      },
      ...view.output,
    ],
    isError: false,
    timestamp: n,
  }
}
const history = (images: number, trees: number) =>
  Promise.all(
    Array.from({ length: Math.max(images, trees) }, (_, i) =>
      result(i, i >= Math.max(images, trees) - images),
    ),
  )
const count = (messages: Message[]) => {
  const blocks = messages.flatMap((m) => (m.role === 'toolResult' ? m.content : []))
  return {
    images: blocks.filter((b) => b.type === 'image').length,
    imageStubs: blocks.filter((b) => b.type === 'text' && b.text.startsWith('[screenshot elided'))
      .length,
    trees: blocks.filter((b) => b.type === 'text' && b.text.includes('"snapshot"')).length,
    treeStubs: blocks.filter((b) => b.type === 'text' && b.text.startsWith('[AX tree')).length,
  }
}

it.each([
  [0, 0],
  [3, 0],
  [7, 4],
  [8, 4],
])('keeps the newest screenshots and elides whole batches: %i images', async (n, elided) => {
  const out = elideObservations(await history(n, n))
  expect(count(out)).toMatchObject({ images: n - elided, imageStubs: elided })
  expect(
    JSON.stringify(out).includes('[screenshot elided: capture c0; a newer capture supersedes it]'),
  ).toBe(elided > 0)
})

it('elides AX trees in batches of four, keeping the newest two, and names the snapshot', async () => {
  const out = elideObservations(await history(0, 20))
  expect(count(out)).toMatchObject({ trees: 4, treeStubs: 16 })
  expect(JSON.stringify(out[0])).toContain(
    '[AX tree of Calculator snapshot s0 elided; a newer observation supersedes it]',
  )
  // The step-summary block stays.
  expect((out[0] as { content: { text: string }[] }).content[0].text).toContain(
    '"status":"delivered"',
  )
})

it('produces identical output for already elided messages within a batch', async () => {
  const all = await history(11, 11)
  const a = elideObservations(all.slice(0, 8))
  const b = elideObservations(all.slice(0, 11))
  expect(b.slice(0, 4)).toEqual(a.slice(0, 4))
  expect(elideObservations(all.slice(0, 9)).slice(0, 4)).toEqual(a.slice(0, 4))
})

it('leaves other tools and stored messages alone', async () => {
  const all = await history(8, 8)
  const before = structuredClone(all)
  const other = { ...all[0], toolName: 'read' } as Message
  expect(elideObservations([other])).toEqual([other])
  elideObservations(all)
  expect(all).toEqual(before)
})

it('judges value_equals over every match, including static text the Driver omits', () => {
  const calculator = {
    ...observation(
      1,
      'AXWindow\n  AXStaticText = "6×7"\n  AXStaticText = "\u206642\u2069"\n  AXButton',
    ),
    elements: [],
  }
  const equals = (value: string, role = 'AXStaticText') => [
    { element: { selector: { role }, value_equals: value } },
  ]
  expect(judgeValueEquals(calculator, equals('42'))).toBe('satisfied')
  expect(judgeValueEquals(calculator, equals('43'))).toBe('unsatisfied')
  expect(judgeValueEquals(calculator, equals('42', 'AXTextField'))).toBe('unknown')
})

it('leaves value_equals predicates with other element conditions to the Driver', () => {
  // Judging these locally dropped `enabled`, so a disabled button verified as satisfied.
  const guarded = { element: { selector: { role: 'AXButton' }, value_equals: 'x', enabled: true } }
  const plain = { element: { selector: { role: 'AXStaticText' }, value_equals: '42' } }
  expect(splitValueEquals([guarded, plain])).toEqual({ local: [plain], remote: [guarded] })
})
