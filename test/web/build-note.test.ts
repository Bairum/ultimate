import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { git } from '../../lib/git.ts'
import { buildNote, landings } from '../../extensions/prompt/server.ts'
import { Note } from '../../extensions/prompt/web.tsx'
import type { BuildNote } from '../../extensions/prompt/refs.ts'
import { temp } from '../helpers.ts'

vi.mock('@/sdk', () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  definePoint: (name: string) => ({ name }),
  defineWebExtension: (facet: unknown) => facet,
  useConversations: () => [],
  useDocOf: () => undefined,
  useUltimate: () => ({ switchConversation: () => {} }),
}))

const text = (data: BuildNote) =>
  renderToStaticMarkup(createElement(Note, { entry: { data } as unknown as EntryRecord }))
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()

it('names the branches that landed between two commits, a worker under its branch', async () => {
  const cwd = await temp()
  const commit = async (subject: string, trailer?: number) => {
    await writeFile(join(cwd, 'file'), subject)
    await git(cwd, 'add', '.')
    await git(
      cwd,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-qm',
      trailer ? `${subject}\n\nUltimate-Conversation: ${trailer}` : subject,
    )
    return git(cwd, 'rev-parse', 'HEAD')
  }
  await git(cwd, 'init', '-q')
  const from = await commit('base')
  await commit('questions: answer card', 50)
  await commit('Merge 1234567 from #40 into main')
  await commit('hand edit')
  const to = await commit('skills: chip', 60)
  const conversations = [
    { id: 40, title: 'Answer card redesign', busy: false },
    { id: 50, title: 'Prototype a card', label: 'designer', parentConversationId: 40, busy: false },
  ]
  const landed = await landings(cwd, from, to, conversations)
  expect(landed.map(({ conversation, title }) => ({ conversation, title }))).toEqual([
    { conversation: 60, title: 'skills: chip' },
    { conversation: undefined, title: 'hand edit' },
    { conversation: 40, title: 'Answer card redesign' },
  ])
  const build = { id: 'b2', generation: 3, history: [] } as never
  expect(buildNote(build, 'b1', landed)).toBe(
    `Build changed: b1 → b2 · generation 3 · landed: skills: chip (#60), hand edit (${landed[1].sha.slice(0, 7)}), Answer card redesign (#40)`,
  )
  // The divider names the first two and counts the rest; the build ids stay in the hover text.
  expect(text({ from: 'b1aaaaaaaa', to: 'b2bbbbbbbb', landed })).toBe(
    'Reloaded · skills: chip #60 · hand edit · +1 more',
  )
})

it('keeps the build ids when nothing landed', () => {
  expect(text({ from: 'b1aaaaaaaa', to: 'b2bbbbbbbb' })).toBe('Reloaded · build b1aaaaa → b2bbbbb')
})
