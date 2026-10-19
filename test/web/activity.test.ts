import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Feed } from '../../extensions/activity/feed.tsx'
import type { ActivityEvent } from '../../extensions/activity/feed.tsx'

vi.mock('@/sdk', () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  definePoint: (name: string) => ({ name }),
  events: { emit: () => {} },
  useUltimate: () => ({ showSurface: () => {}, switchConversation: () => {} }),
  useDocOf: () => ({ conversations: { '12': { feature: 'Activity Feed' } } }),
  useConversations: () => [{ id: 12, title: 'Build the Activity feed' }],
  useWorkspaceIndex: () => ({ queue: [], results: {} }),
}))
vi.mock('../../extensions/workspaces/landing.tsx', () => ({
  useGithubRepo: () => 'https://github.com/HazAT/ultimate',
  CommitCount: ({ count, href }: { count: number; href?: string }) =>
    createElement('a', { href }, `${count} commits`),
}))

const now = Date.parse('2026-10-19T08:00:00Z')
const minutes = (n: number) => new Date(now - n * 60_000).toISOString()
const event = (id: number, name: string, at: string, data: unknown, context?: object) =>
  ({
    id,
    name,
    kind: `event.${name}`,
    v: 1,
    at,
    data,
    ...(context && { context }),
  }) as ActivityEvent

/** Each row as its kind, the text a person reads, its links and whether its notice is amber. */
function rows(list: ActivityEvent[]) {
  const html = renderToStaticMarkup(createElement(Feed, { events: list, now }))
  return [...html.matchAll(/<li[^>]*data-activity="([^"]+)"[^>]*>(.*?)<\/li>/g)].map(
    ([, kind, row]) => ({
      kind,
      text: row
        .replaceAll(/<[^>]+>/g, ' ')
        .replaceAll(/\s+/g, ' ')
        .trim(),
      opens: /title="[^"]*open (#[\d/]+)"/.exec(row)?.[1],
      href: /href="([^"]+)"/.exec(row)?.[1],
      amber: row.includes('text-warning'),
    }),
  )
}

it('shows one row per event of its kinds, newest first as given, with what happened, where it leads and its age', () => {
  const feed = [
    event(9, 'sync.moved', minutes(1), { to: 'rog' }),
    event(8, 'ultimate.notice', minutes(3), {
      extension: 'tailscale',
      message: 'tailscale serve failed',
      level: 'warning',
    }),
    event(
      7,
      'workspaces.landed',
      minutes(5),
      {
        conversationId: 12,
        at: 40,
        sha: '45a315f0',
        base: '9057c43',
        target: 'main',
        title: 'Show recent events',
        feature: 'Activity Feed',
        commitCount: 3,
      },
      { conversationId: 30 },
    ),
    event(6, 'lineage.branched', minutes(90), { id: 12, from: 1, at: 7, intent: 'Build it' }),
    event(5, 'lineage.rooted', minutes(60 * 30), { id: 1, intent: 'Project context' }),
  ]
  // An event of another kind gets no row.
  expect(rows(feed)).toEqual([
    {
      kind: 'ultimate.notice',
      text: 'tailscale tailscale serve failed 3m',
      opens: undefined,
      href: undefined,
      amber: true,
    },
    {
      kind: 'workspaces.landed',
      text: 'Activity Feed Show recent events 3 commits 5m',
      opens: '#12/40',
      href: 'https://github.com/HazAT/ultimate/compare/9057c43...45a315f0',
      amber: false,
    },
    {
      kind: 'lineage.branched',
      text: 'Activity Feed #12 from #1 1h',
      opens: '#12',
      href: undefined,
      amber: false,
    },
    {
      kind: 'lineage.rooted',
      text: 'new root Project context #1 1d',
      opens: '#1',
      href: undefined,
      amber: false,
    },
  ])
})

it('opens the conversation a notice happened in, and names the sha when a landing has no title', () => {
  const [notice, landing] = rows([
    event(
      2,
      'ultimate.notice',
      minutes(0),
      { extension: 'cloud', message: 'paused', level: 'info' },
      {
        conversationId: 44,
      },
    ),
    event(1, 'workspaces.landed', minutes(2), {
      conversationId: 12,
      at: 3,
      sha: 'abcdef1234',
      base: '0123456',
      target: 'main',
      title: '',
      commitCount: 2,
    }),
  ])
  expect(notice).toMatchObject({ text: 'cloud paused now', opens: '#44', amber: false })
  expect(landing).toMatchObject({ text: 'abcdef1 2 commits 2m', opens: '#12/3' })
})

it('stays quiet when nothing has happened', () => {
  const html = renderToStaticMarkup(createElement(Feed, { events: [], now }))
  expect(html).not.toContain('<li')
  expect(html).toContain('nothing has happened yet')
})
