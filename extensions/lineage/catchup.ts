import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@earendil-works/chord'
import type { Message } from '@earendil-works/pi-ai'
import { defineDoc, LiveDoc } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, HookApi, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { git } from '../workspaces/git.ts'
import { workspaces } from '../workspaces/workspaces.ts'

/** The target tip a conversation last saw. A branch gets its own baseline, not its source's. */
export const Seen = defineDoc<{ main?: string; at?: number }>({
  kind: 'lineage.seen',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

type Main = { cwd: string; target: string; sha: string; workspace?: string }
async function mainOf(
  host: ExtensionHost,
  id: ConversationId,
  ctx: Context,
): Promise<Main | undefined> {
  const workspace = await workspaces(host).get(id, ctx)
  const cwd = workspace?.source ?? host.projectRoot
  // A shared conversation follows the branch the project checkout is on, like a workspace's target.
  const target =
    workspace?.target ??
    (await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''))
  if (!target) return undefined
  // Projects without a main branch have nothing to catch up on.
  const sha = await git(cwd, 'rev-parse', '--verify', `refs/heads/${target}`).catch(() => undefined)
  return sha ? { cwd, target, sha, ...(workspace ? { workspace: workspace.path } : {}) } : undefined
}

export async function seedSeen(tx: Tx, id: ConversationId, main: string, at: number) {
  const seen = await tx.doc(Seen, id)
  if (!seen.main) {
    seen.main = main
    seen.at = at
  }
}

/** Seed existing conversations on open and new ones on creation; commits never overwrite a saved baseline. */
export function watchSeen(host: ExtensionHost, ctx: Context) {
  let unsubscribe: (() => void) | undefined
  let pending = Promise.resolve()
  const seed = (id: ConversationId) => {
    pending = pending.then(async () => {
      if ((await host.harness().snapshot(Seen, id, ctx))?.main) return
      const main = await mainOf(host, id, ctx)
      if (!main) return
      await host.harness().commit((tx) => seedSeen(tx, id, main.sha, Date.now()), ctx)
    })
    return pending
  }
  host.onOpen(async () => {
    const harness = host.harness()
    unsubscribe = harness.subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (change.type === 'conversation' && !change.value.owner)
          void seed(change.value.id).catch((error: unknown) => {
            host.notice(`Could not record main for #${change.value.id}: ${String(error)}`)
          })
    })
    const records = await harness.commit(async (tx) => {
      const ids: ConversationId[] = []
      let cursor
      do {
        const page = await tx.scanConversations({}, 100, cursor)
        ids.push(...page.items.filter((record) => !record.owner).map((record) => record.id))
        cursor = page.next
      } while (cursor)
      return ids
    }, ctx)
    for (const id of records) await seed(id)
  })
  host.onClose(async () => {
    unsubscribe?.()
    await pending
  })
}

/** Files this conversation changed: its workspace diff, or its own edit/write calls in a shared checkout. */
async function changedFiles(host: ExtensionHost, id: ConversationId, main: Main, ctx: Context) {
  if (main.workspace) {
    const base = await git(main.workspace, 'merge-base', 'HEAD', main.sha)
    return new Set(
      (await git(main.workspace, 'diff', '--name-only', base)).split('\n').filter(Boolean),
    )
  }
  const conversation = (await host.harness().conversation(id, ctx))!
  const cwd = (await conversation.agent(ctx)).cwd ?? host.projectRoot
  const files = new Set<string>()
  let cursor
  do {
    const page = await conversation.entries({}, 100, cursor, ctx)
    for (const entry of page.items) {
      if (entry.conversationId !== id) continue
      for (const message of entry.model ?? []) {
        if (message.role !== 'assistant') continue
        for (const part of message.content) {
          if (part.type !== 'toolCall' || !['edit', 'write'].includes(part.name)) continue
          const path = part.arguments.path
          if (typeof path !== 'string') continue
          const absolute = isAbsolute(path) ? path : resolve(cwd, path)
          files.add(relative(main.cwd, absolute))
        }
      }
    }
    cursor = page.next
  } while (cursor)
  return files
}

async function catchupText(
  host: ExtensionHost,
  id: ConversationId,
  main: Main,
  since: { main: string; at?: number },
  ctx: Context,
) {
  const range = `${since.main}..${main.sha}`
  const [count, records, changed] = await Promise.all([
    git(main.cwd, 'rev-list', '--count', range).then(Number),
    git(
      main.cwd,
      'log',
      '--name-only',
      '--no-renames',
      '--diff-merges=first-parent',
      '--format=%x1e%H%x00%s%x00%(trailers:key=Ultimate-Conversation,valueonly)%x00',
      range,
    ),
    changedFiles(host, id, main, ctx),
  ])
  if (!count) return undefined
  const commits = records
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, trailer, paths] = record.split('\0')
      const overlap = paths
        .trim()
        .split('\n')
        .filter((path) => changed.has(path))
      const conversation = Number(trailer.trim())
      const title = host.conversations().find((summary) => summary.id === conversation)?.title
      return {
        overlap,
        row: `- ${overlap.length ? '**Overlap** ' : ''}\`${sha.slice(0, 7)}\` ${subject}${conversation ? ` · #${conversation}${title ? ` ${title}` : ''}` : ''}${overlap.length ? ` — ${overlap.map((path) => `\`${path}\``).join(', ')}` : ''}`,
      }
    })
    .toSorted((a, b) => Number(b.overlap.length > 0) - Number(a.overlap.length > 0))
    .slice(0, 30)
  const behind = main.workspace
    ? Number(await git(main.workspace, 'rev-list', '--count', `HEAD..${main.sha}`))
    : 0
  return [
    `Since you last worked (${new Date(since.at ?? Date.now()).toISOString()}), ${count} commits landed on ${main.target}:`,
    ...commits.map((commit) => commit.row),
    ...(count > commits.length
      ? [`and ${count - commits.length} more (\`git log ${range}\`).`]
      : []),
    ...(behind
      ? [`Your workspace is ${behind} commits behind ${main.target}; merge it before continuing.`]
      : []),
    'Check whether any of this already covers or changes what you are about to do.',
  ].join('\n\n')
}

type Check = { input: EntryId; text?: string }
/** Only a run's first request gets a catch-up; retries reuse the memo and an atomic note/baseline commit. */
export async function catchup(
  host: ExtensionHost,
  messages: readonly Message[],
  api: HookApi,
  ctx: Context,
) {
  const harness = host.harness()
  const record = await harness.commit((tx) => tx.conversation(api.conversationId), ctx)
  if (!record || record.owner) return undefined
  const live = await api.snapshot(LiveDoc, api.conversationId, ctx)
  const first = live?.run?.inputs[0]
  if (!first) return undefined
  const submission = await harness.submission(first, ctx)
  const input = (await submission?.status(ctx))?.entry
  if (!input) return undefined
  const conversation = (await harness.conversation(api.conversationId, ctx))!
  let check = await api.memo<Check>('lineage.catchup', ctx)
  if (!check) {
    const view = await conversation.context(ctx)
    // A generation after tools or steering still owns the original inputs, but has already answered once.
    if (view.entries.some((entry) => entry.id > input && entry.kind === 'pi.assistant'))
      return undefined
    const existing = view.entries.find(
      (entry) =>
        entry.kind === 'lineage.note' &&
        (entry.data as { source?: string; input?: number })?.source === 'main' &&
        (entry.data as { input?: number }).input === input,
    )
    if (existing) check = { input, text: (existing.data as { text: string }).text }
    else {
      const main = await mainOf(host, api.conversationId, ctx)
      if (!main) return undefined
      const seen = await api.snapshot(Seen, api.conversationId, ctx)
      const text =
        seen?.main && seen.main !== main.sha
          ? await catchupText(host, api.conversationId, main, { main: seen.main, at: seen.at }, ctx)
          : undefined
      await harness.commit(async (tx) => {
        const state = await tx.doc(Seen, api.conversationId)
        if (text) {
          const original = await tx.entry(input)
          if (!original?.model) throw new Error('The resumed input has no model message')
          const note: Message = { role: 'user', content: text, timestamp: Date.now() }
          await tx.appendEntry(api.conversationId, {
            kind: 'lineage.note',
            data: { source: 'main', text, input },
            // Keep the catch-up before its input in all future model contexts too.
            edits: [{ target: input, action: 'replace', messages: [note, ...original.model] }],
          })
        }
        state.main = main.sha
        if (!state.at || text) state.at = Date.now()
      }, ctx)
      check = { input, ...(text ? { text } : {}) }
    }
    check = await api.memo('lineage.catchup', check, ctx)
  }
  if (!check.text) return undefined
  // Later requests already contain the durable context edit; the current cutoff predates the appended note.
  if (messages.some((message) => message.role === 'user' && message.content === check.text))
    return undefined
  const original = await harness.commit((tx) => tx.entry(check.input), ctx)
  const index = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      message.timestamp === original?.model?.[0]?.timestamp &&
      JSON.stringify(message.content) === JSON.stringify(original?.model?.[0]?.content),
  )
  if (index < 0) throw new Error('Cannot locate the resumed input in the request')
  return {
    messages: [
      ...messages.slice(0, index),
      { role: 'user' as const, content: check.text, timestamp: Date.now() },
      ...messages.slice(index),
    ],
  }
}
