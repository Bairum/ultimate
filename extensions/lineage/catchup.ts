import { execFile } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@earendil-works/chord'
import { AgentDoc, defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { WorkspaceService } from '../workspaces/server.ts'

/** The target tip a conversation last saw. A branch gets its own baseline, not its source's. */
export const Seen = defineDoc<{ main?: string; at?: number }>({
  kind: 'lineage.seen',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

const exec = promisify(execFile)
async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec('git', args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}

type Main = { cwd: string; target: string; sha: string; workspace?: string }
async function mainOf(
  host: ExtensionHost,
  id: ConversationId,
  ctx: Context,
  tx?: Tx,
): Promise<Main | undefined> {
  const service = host.use<WorkspaceService>('workspaces')
  const workspace = service
    ? tx
      ? (await tx.doc(service.doc, ROOT_CONVERSATION_ID)).items[String(id)]
      : await service.get(id, ctx)
    : undefined
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
async function changedFiles(host: ExtensionHost, id: ConversationId, main: Main, tx: Tx) {
  if (main.workspace) {
    const base = await git(main.workspace, 'merge-base', 'HEAD', main.sha)
    return new Set(
      (await git(main.workspace, 'diff', '--name-only', base)).split('\n').filter(Boolean),
    )
  }
  const cwd = (await tx.doc(AgentDoc, id)).cwd ?? host.projectRoot
  const files = new Set<string>()
  let cursor
  do {
    const page = await tx.scanEntries({ conversationId: id }, 100, cursor)
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
  tx: Tx,
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
    changedFiles(host, id, main, tx),
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

// Pi upstream: @earendil-works/pi-durable@1.2.0 — patched transactional beforeInput hook. Drop when Pi ships input-placement hooks.
/** The note, baseline and first input commit together, before any request can see them. */
export async function catchup(
  host: ExtensionHost,
  _input: EntryDraft,
  api: { conversationId: ConversationId; tx: Tx },
  ctx: Context,
) {
  const { tx, conversationId } = api
  const record = await tx.conversation(conversationId)
  if (!record || record.owner) return undefined
  const main = await mainOf(host, conversationId, ctx, tx)
  if (!main) return undefined
  const seen = await tx.doc(Seen, conversationId)
  const text =
    seen.main && seen.main !== main.sha
      ? await catchupText(host, conversationId, main, { main: seen.main, at: seen.at }, tx)
      : undefined
  seen.main = main.sha
  if (!seen.at || text) seen.at = Date.now()
  if (!text) return undefined
  return {
    entries: [
      {
        kind: 'lineage.note',
        data: { source: 'main', text },
        model: [{ role: 'user' as const, content: text, timestamp: Date.now() }],
      },
    ],
  }
}
