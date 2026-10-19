import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { git, isolatable } from '../../lib/git.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { SubmissionLanded, WorkspacesApi } from '../workspaces/api.ts'
import { reviewDiff } from './diff.ts'
import { DiffAction, RangesAction } from './refs.ts'
import type { ReviewRange } from './refs.ts'

const index = (host: ExtensionHost, ctx: Context) =>
  host.harness().snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, ctx)

/** Conversation `id`'s worktree while it is ready, else the project's checkout (also once it was released). */
async function where(host: ExtensionHost, id: unknown) {
  if (id === undefined) return host.projectRoot
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new Error('conversation must be a conversation id')
  const workspace = (await index(host, context))?.items[String(id)]
  return workspace?.state === 'ready' ? workspace.path : host.projectRoot
}

/** The branch `branch` lands on: its worktree's target, else the project checkout's branch. */
async function target(host: ExtensionHost, branch: string) {
  const items = Object.values((await index(host, context))?.items ?? {})
  const owned = items.find((item) => item.branch === branch)
  if (owned) return owned.target
  const checkout = await isolatable(host.projectRoot)
  if ('reason' in checkout) throw new Error(checkout.reason)
  return checkout.target
}

const ago = (seconds: number) => {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 60 / 24)}d`
}

async function ranges(host: ExtensionHost): Promise<ReviewRange[]> {
  const cwd = host.projectRoot
  const items = Object.entries((await index(host, context))?.items ?? {})
  const titles = new Map(host.conversations().map((item) => [item.id, item.title]))
  const owner = new Map(
    items
      .filter(([, item]) => item.state !== 'removed')
      .map(([id, item]) => [item.branch, Number(id)]),
  )
  const [branches, commits, landings] = await Promise.all([
    git(
      cwd,
      'for-each-ref',
      '--sort=-committerdate',
      '--count=20',
      '--format=%(refname:short)%09%(committerdate:unix)',
      'refs/heads/ultimate/',
    ).catch(
      // No repository: the selector offers free entry only.
      () => '',
    ),
    git(cwd, 'log', '-n', '15', '--format=%H%x09%ct%x09%s').catch(
      // No commit yet: nothing to list.
      () => '',
    ),
    host.eventLog.recent({ events: [SubmissionLanded], limit: 10 }),
  ])
  const list: ReviewRange[] = [
    { spec: 'uncommitted', group: 'Working tree', label: 'Uncommitted changes' },
  ]
  for (const line of branches.split('\n').filter(Boolean)) {
    const [branch, at] = line.split('\t') as [string, string]
    const id = owner.get(branch)
    // Only branches of a live worktree: a landed and removed one has nothing left to review.
    if (id === undefined) continue
    list.push({
      spec: `branch:${branch}`,
      group: 'Branches',
      label: titles.get(id) ?? `#${id}`,
      detail: `#${id} · ${ago(Number(at))}`,
    })
  }
  for (const { data, at } of landings)
    list.push({
      spec: `${data.base}...${data.sha}`,
      group: 'Landings',
      label: data.feature ? `${data.feature} · ${data.title}` : data.title || data.sha.slice(0, 7),
      detail: `${data.sha.slice(0, 7)} · ${data.commitCount} commit${data.commitCount === 1 ? '' : 's'} · ${ago(Date.parse(at) / 1000)}`,
    })
  for (const line of commits.split('\n').filter(Boolean)) {
    const [sha, at, subject] = line.split('\t') as [string, string, string]
    list.push({
      spec: sha,
      group: 'Commits',
      label: subject,
      detail: `${sha.slice(0, 7)} · ${ago(Number(at))}`,
    })
  }
  return list
}

export const actions = {
  diff: implementAction(DiffAction, async (args, { host, signal }) => {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof input.spec !== 'string') throw new Error('Expected { spec }')
    return reviewDiff(await where(host, input.conversation), input.spec, {
      target: (branch) => target(host, branch),
      signal,
    })
  }),
  ranges: implementAction(RangesAction, (_args, { host }) => ranges(host)),
}

export default { name: 'review' }
