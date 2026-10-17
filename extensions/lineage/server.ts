import type { Context, JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import type { Message, Models, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import {
  AgentDoc,
  CompactionTask,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  section,
  UsageDoc,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryId,
  JsonObject,
  ModelRef,
  TaskId,
  Tx,
} from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../shared/protocol.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { WorkspaceService } from '../workspaces/server.ts'
import { catchup, Seen, seedSeen, watchSeen } from './catchup.ts'
import type { Tree } from './catchup.ts'

/** The project's roots, each the top of one conversation tree; a fresh project's first conversation is its first. */
export const Roots = defineDoc<{ roots: number[] }>({
  kind: 'lineage.roots',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ roots: [ROOT_CONVERSATION_ID] }),
})

export type BranchImage = { data: string; mimeType: string }
export type BranchState = { from: number; at: number; intent: string }
/** A branch's origin and prompt; absent on roots and on conversations made otherwise. */
export const Branch = defineDoc<{ branch?: BranchState }>({
  kind: 'lineage.branch',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** A conversation's liquid abstract: its `anchor` entry keeps its place in the tally and shows the latest text. */
export type OpenAbstract = {
  anchor: number
  at: number
  text: string
  title?: string
  feature?: string
}
export type TallyState = {
  /** Each conversation's open abstract, until a landing freezes it. */
  abstracts: Record<string, OpenAbstract>
  /** Estimated tokens of the root's model-visible context. */
  tokens: number
  /** The entry this root became a tally at; absent while a root is still an ordinary conversation. */
  since?: number
}
/**
 * A root's tally bookkeeping. Forks start from the initial value: a branch inherits the tally's entries, but it is no
 * tally itself, and copying the map would let its own abstracts omit entries of another conversation.
 */
export const Tally = defineDoc<TallyState>({
  kind: 'lineage.tally',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ abstracts: {}, tokens: 0 }),
})

/** Kept only so old side chats stay read-only, including their question cards. */
export const Side = defineDoc<{
  side?: {
    root: number
    at: number
    ended?: 'note' | 'branch' | 'discard'
    ending?: 'note' | 'branch'
  }
}>({
  kind: 'lineage.side',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export const docs = [Roots, Branch, Tally, Seen, Side]

/**
 * `lineage:branched` (a new branch) and `lineage:rooted` carry it: subscribers enlist their own document
 * writes in the new conversation's creation transaction.
 */
export type BranchedEvent = {
  tx: Tx
  id: ConversationId
  intent: string
  waitUntil: (write: Promise<void>) => void
}

const ASK_TOKENS = 8192

/** A first input: the prompt, with the images pasted with it. */
function promptContent(prompt: string, images: readonly BranchImage[] = []) {
  return images.length
    ? [
        { type: 'text' as const, text: prompt },
        ...images.map((image) => ({ type: 'image' as const, ...image })),
      ]
    : prompt
}

function contentText(content: Message['content']) {
  return typeof content === 'string'
    ? content
    : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}
/** One message as transcript text; tool results are capped, thinking is left out. */
function line(message: Message) {
  if (message.role === 'user') return `[User]: ${contentText(message.content)}`
  if (message.role === 'toolResult')
    return `[Tool result]: ${contentText(message.content).slice(0, 2000)}`
  if (message.role !== 'assistant') return ''
  const said = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
  const calls = message.content.flatMap((part) =>
    part.type === 'toolCall' ? [`${part.name}(${JSON.stringify(part.arguments)})`] : [],
  )
  return [
    ...(said.length ? [`[Assistant]: ${said.join('\n')}`] : []),
    ...(calls.length ? [`[Assistant tool calls]: ${calls.join('; ')}`] : []),
  ].join('\n\n')
}
/**
 * The source context as text tagged with its entry ids, oldest entries dropped until it fits `budget` tokens. Each
 * block is `#<conversation>/<entry>` followed by that entry's messages.
 */
export function sourceText(
  conversation: number,
  entries: readonly { id: number }[],
  contributions: readonly (readonly Message[])[],
  budget: number,
) {
  const blocks = entries
    .map((entry, index) => {
      const body = contributions[index].map(line).filter(Boolean).join('\n\n')
      return body ? `#${conversation}/${entry.id}\n${body}` : ''
    })
    .filter(Boolean)
  let total = blocks.reduce((sum, block) => sum + estimateTextTokens(block), 0)
  while (blocks.length > 1 && total > budget) total -= estimateTextTokens(blocks.shift()!)
  return blocks.join('\n\n')
}

/** Ask `model` once with a system prompt and one user message; returns the text, or throws on a failed answer. */
async function ask(
  models: Models,
  tx: (change: (tx: Tx) => Promise<void>) => Promise<void>,
  usageConversation: ConversationId,
  ref: ModelRef,
  thinking: ModelThinkingLevel | undefined,
  systemPrompt: string,
  input: string,
  signal: AbortSignal,
) {
  const model = models.getModel(ref.provider, ref.modelId)
  if (!model) throw new Error(`Model ${ref.provider}/${ref.modelId} is unavailable`)
  const answer = await models.completeSimple(
    model,
    { systemPrompt, messages: [{ role: 'user', content: input, timestamp: Date.now() }] },
    {
      ...(thinking && thinking !== 'off' ? { reasoning: thinking } : {}),
      maxTokens: Math.min(ASK_TOKENS, model.maxTokens || ASK_TOKENS),
      signal,
    },
  )
  await tx(async (draft) => {
    const usage = (await draft.doc(UsageDoc, usageConversation)).models
    const key = `${answer.provider}/${answer.model}`
    const total = Object.hasOwn(usage, key) ? usage[key] : undefined
    if (!total) usage[key] = answer.usage
    else
      for (const counter of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
        total[counter] += answer.usage[counter]
  })
  const result = contentText(answer.content).trim()
  if (answer.stopReason !== 'stop' && answer.stopReason !== 'length')
    throw new Error(answer.errorMessage ?? `The model stopped: ${answer.stopReason}`)
  if (!result) throw new Error('The model returned no answer')
  return result
}

export async function rootsOf(host: Pick<ExtensionHost, 'harness'>, ctx: Context) {
  return ((await host.harness().snapshot(Roots, ROOT_CONVERSATION_ID, ctx))?.roots ?? [
    ROOT_CONVERSATION_ID,
  ]) as ConversationId[]
}

/** Up from `record` through owners (subagents) and fork sources (branches) to the first of `roots`. */
async function climb(tx: Tx, record: ConversationRecord | undefined, roots: readonly number[]) {
  while (record && !roots.includes(record.id)) {
    const up = record.owner?.conversationId ?? record.parent?.conversationId
    record = up === undefined ? undefined : await tx.conversation(up)
  }
  return record?.id
}

/** The root of `id`'s tree: up through owners (subagents) and fork sources (branches); undefined outside any tree. */
export async function rootOf(host: Pick<ExtensionHost, 'harness'>, id: number, ctx: Context) {
  const roots = await rootsOf(host, ctx)
  return host
    .harness()
    .commit(async (tx) => climb(tx, await tx.conversation(id as ConversationId), roots), ctx)
}

/** The root a top-level conversation's tally lives in; undefined for roots, owned conversations and outside trees. */
async function tallyRoot(tx: Tx, id: ConversationId, roots: readonly number[]) {
  const record = await tx.conversation(id)
  if (!record || record.owner || roots.includes(id)) return undefined
  return climb(tx, record, roots)
}

/** The root and intent of a branch that writes abstracts into its tree's tally; undefined where none is written. */
export async function branchOf(host: Pick<ExtensionHost, 'harness'>, id: number, ctx: Context) {
  const roots = await rootsOf(host, ctx)
  const root = await host.harness().commit((tx) => tallyRoot(tx, id as ConversationId, roots), ctx)
  if (root === undefined) return undefined
  const intent = (await host.harness().snapshot(Branch, id as ConversationId, ctx))?.branch?.intent
  return { root: root as number, ...(intent ? { intent } : {}) }
}

export type AbstractInput = { text: string; at: number; title?: string; feature?: string }
/**
 * Write `id`'s abstract into its tree's root in the caller's transaction, before that transaction's first table write
 * (it reads conversation records). An abstract is liquid until its conversation lands: while one is open, a carrier
 * entry without model messages replaces the open anchor's text in place, so the tally never reorders. Otherwise it
 * appends a model-visible abstract that becomes the anchor. A no-op where `branchOf` is undefined.
 */
export async function abstract(tx: Tx, id: number, input: AbstractInput) {
  const roots = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots
  const root = await tallyRoot(tx, id as ConversationId, roots)
  if (root === undefined) return
  const tally = await tx.doc(Tally, root)
  const open = tally.abstracts[String(id)] as OpenAbstract | undefined
  // An anchor a compaction or genesis replaced is out of the context: an edit of it would change nothing.
  const marker = open && (await tx.latestHeadMarker(root))
  // A running compaction may replace the anchor too, after this commit: the update opens a new anchor below its range
  // and omits the old one, which then either went into the summary or stays and is hidden.
  const compacting = !!open && (await liveTask(tx, root, CompactionTask.definition.name))
  const anchor =
    open && !compacting && (!marker || open.anchor >= marker.head) ? open.anchor : undefined
  const { text, at, title, feature } = input
  const state = { at, text, ...(title ? { title } : {}), ...(feature ? { feature } : {}) }
  const data = { conversation: id, ...state }
  const model = [
    {
      role: 'user' as const,
      content: `Abstract of #${id}${title ? ` ${title}` : ''} as of #${id}/${at}:\n${text}`,
      timestamp: Date.now(),
    },
  ]
  const entry = await tx.appendEntry(
    root,
    anchor === undefined
      ? {
          kind: 'lineage.abstract',
          data,
          model,
          ...(compacting
            ? { edits: [{ target: open.anchor as EntryId, action: 'omit' as const }] }
            : {}),
        }
      : {
          kind: 'lineage.abstract',
          data: { ...data, anchor },
          edits: [{ target: anchor as EntryId, action: 'replace', messages: model }],
        },
  )
  tally.abstracts[String(id)] = { anchor: anchor ?? entry.id, ...state }
}

/**
 * The last tally entry a fork of `from` at `at` has in its context: the newest root entry it inherits, or the position
 * the newest catch-up it inherits advanced to. Undefined when it inherits neither.
 */
async function inheritedTally(tx: Tx, from: ConversationId, at: EntryId, root: ConversationId) {
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries({ conversationId: from, maxEntryId: at }, 100, cursor)
    for (const entry of page.items) {
      if (entry.conversationId === root) return entry.id as number
      const data = entry.data as { source?: string; tally?: number } | undefined
      if (entry.kind === 'lineage.note' && data?.source === 'main' && data.tally !== undefined)
        return data.tally
    }
    cursor = page.next
  } while (cursor)
  return undefined
}

/** Whether a task of `kind` is live in conversation `id`. */
async function liveTask(tx: Tx, id: ConversationId, kind: string) {
  for (const status of ['pending', 'running', 'waiting', 'completing'] as const)
    if ((await tx.scanTasks({ conversationId: id, kind, status }, 1)).items.length) return true
  return false
}

/**
 * Keep each tally's token count at its model-visible context. Every entry a tally gets (prompt nodes, abstracts, notes,
 * a compaction, a reset) changes it, so it is recounted from the context after each commit that appends one.
 */
function watchTally(host: ExtensionHost, ctx: Context) {
  let roots = new Set<number>()
  const dirty = new Set<ConversationId>()
  let pending = Promise.resolve()
  let unsubscribe: (() => void) | undefined
  const recount = () => {
    pending = pending
      .then(async () => {
        for (const id of dirty) {
          dirty.delete(id)
          if ((await host.harness().snapshot(Tally, id, ctx))?.since === undefined) continue
          const { messages } = await (await host.harness().conversation(id, ctx))!.context(ctx)
          const tokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
          await host.harness().commit(async (tx) => {
            const tally = await tx.doc(Tally, id)
            if (tally.tokens !== tokens) tally.tokens = tokens
          }, ctx)
        }
      })
      .catch((error: unknown) => {
        host.notice(`Could not count a tally's tokens: ${String(error)}`)
      })
  }
  host.onOpen(async () => {
    roots = new Set(await rootsOf(host, ctx))
    unsubscribe = host.harness().subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (change.type === 'document' && change.record.kind === Roots.definition.kind)
          roots = new Set((change.value as { roots?: number[] } | null)?.roots ?? [])
      const before = dirty.size
      for (const change of publication.changes)
        if (change.type === 'entry' && roots.has(change.value.conversationId))
          dirty.add(change.value.conversationId)
      if (dirty.size > before) recount()
    })
    for (const id of roots) dirty.add(id as ConversationId)
    recount()
  })
  host.onClose(async () => {
    unsubscribe?.()
    await pending
  })
}

function lineage(host: ExtensionHost) {
  /**
   * Delivers a new branch's prompt as its first input; created with the branch, so a crash cannot leave it without
   * one. It is no background task, so waiting for the branch to go idle waits for its prompt and the run it starts.
   */
  const Prompt = defineTask<
    { id: ConversationId; prompt: string; images?: BranchImage[] },
    { phase: 'deliver' },
    null
  >({
    name: 'lineage.prompt',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const { id, prompt, images } = task.input
        // The stable request id makes a rerun after a crash find the input it already submitted.
        await (await host.harness().conversation(id, ctx))!.submit(
          { type: 'input', content: promptContent(prompt, images), requestId: 'lineage:prompt' },
          ctx,
        )
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  const Notify = defineTask<
    { target: ConversationId; wake: boolean },
    { phase: 'wait' } | { phase: 'deliver'; title?: string; text: string },
    null
  >({
    name: 'lineage.notify',
    version: 1,
    initial: () => ({ phase: 'wait' }),
    phases: {
      wait: async (task, runtime, ctx) => {
        const { target } = task.input
        await (await runtime.conversation(target, ctx))?.waitForIdle(ctx)
        // A fork inherits its source's entries; only an answer written in the target itself counts as its own.
        const view = await runtime.context(target, ctx)
        let said = ''
        for (let index = view.entries.length - 1; index >= 0 && !said; index--) {
          if (view.entries[index].conversationId !== target) continue
          const answer = view.contributions[index].findLast(
            (message) => message.role === 'assistant' && contentText(message.content).trim(),
          )
          if (answer) said = contentText(answer.content).trim()
        }
        const title = host.conversations().find((summary) => summary.id === target)?.title
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: {
              phase: 'deliver',
              ...(title ? { title } : {}),
              text: said
                ? said.length > FINISHED_CHARS
                  ? `${said.slice(0, FINISHED_CHARS)}…`
                  : said
                : 'It gave no answer.',
            },
          }),
          ctx,
        )
      },
      deliver: async (task, runtime, ctx) => {
        const { target, wake } = task.input
        const { title, text } = task.state.checkpoint as { title?: string; text: string }
        const requestId = `lineage:notify:${target}:${task.id}`
        if (wake)
          await (await runtime.conversation(runtime.conversationId, ctx))!.submit(
            {
              type: 'input',
              content: finishedText(target, title, text),
              whenBusy: 'followUp',
              requestId,
              entry: {
                kind: 'lineage.finished',
                data: { from: target, text, ...(title ? { title } : {}) },
              },
            },
            ctx,
          )
        else
          await leaveNote(host, runtime.conversationId, text, {
            from: target,
            source: 'finished',
            ...(title ? { data: { title } } : {}),
            requestId,
          })
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  return { Notify, Prompt }
}

/** How much of the finished conversation's last answer a notify delivers. */
const FINISHED_CHARS = 1500
const finishedText = (id: number, title: string | undefined, text: string) =>
  `#${id} finished${title ? ` · ${title}` : ''}\n\nIts last answer:\n${text}`

type PromptInput = {
  prompt: string
  images?: BranchImage[]
  isolated?: boolean
  model?: ModelRef
  thinkingLevel?: ModelThinkingLevel
}
export type BranchInput = PromptInput & {
  from: number
  at?: number
  deliver?: false
  by?: number
  receipt?: { taskId: TaskId; callId: string }
}

// Commits with creation, closing the gap before the tool records its memo.
const RootReceipts = defineDoc<{ roots: Record<string, number> }>({
  kind: 'lineage.root-receipts',
  version: 1,
  scope: 'task',
  initial: () => ({ roots: {} }),
})

export const BranchReceipts = defineDoc<{ branches: Record<string, number> }>({
  kind: 'lineage.branch-receipts',
  version: 1,
  scope: 'task',
  initial: () => ({ branches: {} }),
})

/** The project checkout's tip, where new branches start, shared or isolated. */
function head(host: ExtensionHost) {
  return host
    .use<WorkspaceService>('workspaces')
    ?.git(host.projectRoot, 'rev-parse', 'HEAD')
    .catch(
      // A project without a Git HEAD can start conversations without a commit baseline.
      () => undefined,
    )
}

/** What the tree root's model reads about a new branch: where it started and the prompt it started with. */
function branchedText(
  branch: number,
  from: number,
  root: number,
  at: number,
  input: BranchInput,
  caller?: string,
) {
  const images = input.images?.length ?? 0
  return [
    `#${branch} was started from ${from === root ? `the tally (#${root}/${at})` : `#${from}/${at}`}${caller ? `, started by ${caller},` : ''} with the prompt:`,
    input.prompt.trim(),
    ...(images ? [`(${images} image${images === 1 ? '' : 's'}, in #${branch})`] : []),
  ].join('\n')
}

/**
 * Fork `from` at `at` (default: its latest entry) into a branch whose first input is the prompt. The tree's root gets
 * the prompt node after the fork point, so the branch reads its prompt once, as its own input.
 */
export async function startBranch(host: ExtensionHost, input: BranchInput, ctx: Context) {
  if (!input.prompt.trim()) throw new Error('A branch needs a prompt')
  const from = input.from as ConversationId
  const main = await head(host)
  const roots = await rootsOf(host, ctx)
  // A first branch needs a stored entry to fork from. An empty root has none until it got familiar with the project.
  if (input.at === undefined)
    await host.harness().commit(async (tx) => {
      if (!(await tx.conversation(from))) throw new Error(`No conversation #${from}`)
      if ((await tx.scanEntries({ conversationId: from }, 1)).items.length) return
      if (roots.includes(from))
        throw new Error(
          `#${from} is an empty root: let it get familiar with the project first, then branch from what it learned`,
        )
      await tx.appendEntry(from, { kind: 'pi.reset', head: 'self' })
    }, ctx)
  const id = await host.harness().commit((tx) => forkBranch(host, tx, input, main, roots), ctx)
  host.harness().resume()
  return { id }
}

/** `startBranch` inside the caller's transaction, before its first table write; `main` is the checkout's tip. */
async function forkBranch(
  host: ExtensionHost,
  tx: Tx,
  input: BranchInput,
  main: string | undefined,
  roots: readonly number[],
) {
  const receipts = input.receipt ? await tx.doc(BranchReceipts, input.receipt.taskId) : undefined
  if (input.receipt && receipts?.branches[input.receipt.callId] !== undefined)
    return receipts.branches[input.receipt.callId] as ConversationId
  const prompt = input.prompt.trim()
  const from = input.from as ConversationId
  const { Prompt } = lineage(host)
  if (!(await tx.conversation(from))) throw new Error(`No conversation #${from}`)
  let at = input.at as EntryId | undefined
  if (at === undefined) {
    at = (await tx.scanEntries({ conversationId: from }, 1)).items[0]?.id
    if (at === undefined) throw new Error(`Conversation #${from} has no entries to branch from`)
  } else if (
    !(await tx.scanEntries({ conversationId: from, maxEntryId: at, minEntryId: at }, 1)).items
      .length
  )
    throw new Error(`Entry ${at} is not in conversation #${from}`)
  // Table reads precede the transaction's first table write, the fork.
  const root = await climb(tx, await tx.conversation(from), roots)
  const tally = root === undefined ? undefined : await inheritedTally(tx, from, at, root)
  let caller: string | undefined
  if (input.by !== undefined) {
    const standing = host.doc('ultimate.standing-agents')
    const index = standing
      ? ((await tx.doc(standing, ROOT_CONVERSATION_ID)) as Record<string, number>)
      : {}
    const name = Object.keys(index).find((candidate) => index[candidate] === input.by)
    caller = `#${input.by}${name ? ` (@${name})` : ''}`
  }
  const fork = await tx.forkConversation(from, at, { ownership: { kind: 'ownerless' } })
  await configure(tx, fork.id, {
    cwd: host.projectRoot,
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
  })
  // A branch gets ordinary tools whatever its source ran with.
  const agent = await tx.doc(AgentDoc, fork.id)
  delete agent.tools
  delete agent.modelTools
  if (input.isolated) {
    const workspaces = host.use<WorkspaceService>('workspaces')
    if (!workspaces) throw new Error('Isolated branches require workspaces')
    await workspaces.create(tx, fork.id, host.projectRoot)
  }
  if (main) await seedSeen(tx, fork.id, main, Date.now())
  // The branch knows its tally as far as its context reaches; its own prompt node, appended below, is no news to it.
  if (tally !== undefined) (await tx.doc(Seen, fork.id)).tally = tally
  ;(await tx.doc(Branch, fork.id)).branch = { from, at, intent: prompt }
  // Until the summary names it, a branch is called by its intent, not by the first message it inherited.
  const title = prompt.replace(/\s+/g, ' ').slice(0, 80)
  const metadata = await tx.doc(host.metadata, fork.id)
  metadata.title = title
  // The prompt is its first input, placed right after this commit: it sorts as asked for now.
  metadata.inputAt = Date.now()
  const writes: Promise<void>[] = []
  host.events.emit('lineage:branched', {
    tx,
    id: fork.id,
    intent: prompt,
    waitUntil: (write) => writes.push(write),
  } satisfies BranchedEvent)
  await Promise.all(writes)
  const images = input.images?.length ?? 0
  const marker = { branch: fork.id, at, intent: prompt, ...(images ? { images } : {}) }
  if (root !== undefined)
    await tx.appendEntry(root, {
      kind: 'lineage.branched',
      data: {
        ...marker,
        ...(root === from ? {} : { from }),
      },
      model: [
        {
          role: 'user',
          content: branchedText(fork.id, from, root, at, input, caller),
          timestamp: Date.now(),
        },
      ],
    })
  // A source inside the tree keeps a display-only marker; its model never sees it.
  if (root !== from) await tx.appendEntry(from, { kind: 'lineage.branched', data: marker })
  if (input.deliver !== false)
    await tx.createTask(
      Prompt,
      { id: fork.id, prompt, ...(images ? { images: input.images } : {}) },
      { conversationId: fork.id, ownership: { kind: 'conversation' }, background: false },
    )
  if (receipts && input.receipt) receipts.branches[input.receipt.callId] = fork.id
  return fork.id
}

/**
 * Leave a note in `to` (a conversation id, or the root of `source.from`'s tree) without waking it. A landing in a tally
 * freezes its submitter's open abstract: the note carries that state, and the anchor leaves the context with it.
 */
export async function leaveNote(
  host: Pick<ExtensionHost, 'harness'>,
  to: number | 'root',
  text: string,
  source?: {
    from?: number
    source?: 'lander' | 'finished'
    data?: JsonObject
    requestId?: string
  },
) {
  let target = to as ConversationId
  if (to === 'root') {
    if (source?.from === undefined) throw new Error('A note to the root needs its source')
    const root = await rootOf(host, source.from, context)
    if (root === undefined) throw new Error(`#${source.from} has no root`)
    target = root
  }
  const conversation = await host.harness().conversation(target, context)
  if (!conversation) throw new Error(`No conversation #${target}`)
  const from = source?.from
  const requestId = source?.requestId
  const data = {
    ...source?.data,
    text,
    ...(from === undefined ? {} : { from }),
    ...(source?.source ? { source: source.source } : {}),
  }
  const content =
    source?.source === 'lander'
      ? `Note from the lander: ${text}`
      : source?.source === 'finished'
        ? finishedText(from!, source.data?.title as string | undefined, text)
        : `Note from #${from ?? '?'}: ${text}`
  // A landing in a tally is placed with the check for an open abstract in one transaction: none can open in between.
  if (
    source?.source === 'lander' &&
    from !== undefined &&
    (await host.harness().commit(async (tx) => {
      const tally = await tx.doc(Tally, target)
      if (tally.since === undefined) return false
      // A rerun after a crash finds the landing it wrote; a newer anchor stays open.
      if (requestId && (await tx.submissionByRequest(target, requestId))) return true
      // A tally runs no turns, so the write is placed at once, as an idle conversation's would be.
      const open = tally.abstracts[String(from)] as OpenAbstract | undefined
      const model = { role: 'user' as const, content, timestamp: Date.now() }
      let entry
      if (open) {
        const { anchor, ...state } = open
        entry = await tx.appendEntry(target, {
          kind: 'lineage.note',
          data: { ...data, abstract: state },
          model: [
            {
              ...model,
              content: `${content}\n\nState at landing (abstract as of #${from}/${state.at}):\n${state.text}`,
            },
          ],
          edits: [{ target: anchor as EntryId, action: 'omit' }],
        })
        delete tally.abstracts[String(from)]
      } else entry = await tx.appendEntry(target, { kind: 'lineage.note', data, model: [model] })
      await tx.createSubmission({
        conversationId: target,
        ...(requestId ? { requestId } : {}),
        type: 'write',
        status: 'done',
        entry: entry.id,
      })
      return true
    }, context))
  )
    return target
  await conversation.submit(
    {
      type: 'write',
      ...(requestId ? { requestId } : {}),
      entry: {
        kind: 'lineage.note',
        data,
        model: [{ role: 'user', content, timestamp: Date.now() }],
      },
    },
    context,
  )
  return target
}

const ZOOM =
  'Zoom out when you need to: read any conversation, a root or a sibling, with codemode `ultimate.entries(id)` and `ultimate.search(text)`. Leave a `note` for a conversation your work affects.'

/** Whether each conversation is owned (a subagent, a lander), read once: ownership never changes after creation. */
const owned = new Map<ConversationId, boolean>()

/** The lineage section for one conversation; undefined for roots, which never request, and owned conversations. */
export async function lineageSection(
  host: Pick<ExtensionHost, 'harness'>,
  id: ConversationId,
  ctx: Context,
) {
  if (!owned.has(id)) {
    const record = await host.harness().commit((tx) => tx.conversation(id), ctx)
    if (!record) return undefined
    owned.set(id, !!record.owner)
  }
  if (owned.get(id)) return undefined
  const root = await rootOf(host, id, ctx)
  if (id === root) return undefined
  const rooted = root === undefined ? '' : `\nRoot: #${root}.`
  const state = (await host.harness().snapshot(Branch, id, ctx))?.branch
  if (!state) return `You are #${id}.${rooted}\n${ZOOM}`
  return `You are #${id}, branched from #${state.from} at entry ${state.at} for: ${state.intent}${rooted}\nYour context starts with the tally of your tree, kept in its root: the prompt each conversation was started with, the latest abstract of each, and every landing, with #<conversation>/<entry> breadcrumbs to read in full with codemode \`ultimate.entries(id)\`.\n${ZOOM}`
}

const COMPACT_SYSTEM =
  'You condense a long coding conversation into the summary it continues from. Do not continue the conversation; output only the summary, in Markdown.'

function compactFocus(root: boolean, intent?: string) {
  return root
    ? 'This is the tally of one line of work: the prompts its conversations were started with, their latest abstracts, and its landings. Keep the idea, principles and standing decisions, and for every conversation its #id, prompt, outcome, divergence from the prompt and landed commits, with their #<conversation>/<entry> breadcrumbs. Merge superseded detail into the current state.'
    : `This is a branch${intent ? ` started for: ${intent}` : ''}. Keep its intent and progress toward it: decisions, changed files, verification, what remains. Drop what the intent no longer needs.`
}

function conversationArg(args: JsonValue) {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Expected a conversation id')
  return value as ConversationId
}

/** Validates a new branch's prompt and configuration. */
function rootInput(args: JsonValue) {
  const input = (args ?? {}) as Partial<BranchInput>
  if (typeof input.prompt !== 'string') throw new Error('prompt must be a string')
  if (
    input.model !== undefined &&
    (typeof input.model?.provider !== 'string' || typeof input.model.modelId !== 'string')
  )
    throw new Error('model must be { provider, modelId }')
  if (input.images !== undefined) {
    if (!Array.isArray(input.images) || input.images.length > maxImages)
      throw new Error(`images must be an array of at most ${maxImages}`)
    for (const image of input.images)
      if (
        !imageMimeTypes.includes(image?.mimeType) ||
        typeof image.data !== 'string' ||
        !image.data ||
        Buffer.byteLength(image.data, 'base64') > maxImageBytes
      )
        throw new Error('Expected supported image MIME type and base64 data of at most 2 MiB')
  }
  return input
}

export const actions = {
  /** The roots, and with `{ id }` that conversation's tree root and its branch state when it is a branch. */
  async info(args: JsonValue, { host }: ActionContext) {
    const roots = await rootsOf(host, context)
    if (args === null || args === undefined) return { roots }
    const id = conversationArg(args)
    const root = await rootOf(host, id, context)
    const branch = (await host.harness().snapshot(Branch, id, context))?.branch
    return { roots, ...(root === undefined ? {} : { root }), ...(branch ? { branch } : {}) }
  },
  async branch(args: JsonValue, { host }: ActionContext) {
    const input = rootInput(args)
    for (const key of ['from', 'at'] as const)
      if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1))
        throw new Error(`${key} must be a positive integer`)
    if (input.from === undefined) throw new Error('from must be a positive integer')
    return startBranch(host, input as BranchInput, context)
  },
}

/** The tally `id` catches up on: its tree root's, once that root is a tally. */
async function treeOf(tx: Tx, id: ConversationId): Promise<Tree | undefined> {
  const root = await tallyRoot(tx, id, (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots)
  if (root === undefined) return undefined
  const { since, abstracts } = await tx.doc(Tally, root)
  return since === undefined ? undefined : { root, since, abstracts }
}

/** A tally runs no turns: an input placed in one is refused with its transaction. */
async function refuseTally(tx: Tx, id: ConversationId) {
  if (!(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.includes(id)) return
  const tally = await tx.doc(Tally, id)
  if (tally.since !== undefined)
    throw new Error(`#${id} is a tally and runs no turns; ask @ultimate to start a branch`)
}

/** Stored side chats are read-only once ended or ending. */
async function refuseEndedSide(tx: Tx, id: ConversationId) {
  const side = (await tx.doc(Side, id)).side
  if (side?.ending || side?.ended)
    throw new Error(`Side chat #${id} ${side.ended ? 'has ended' : 'is ending'} and takes no input`)
}

export type LineageService = {
  branch: (input: BranchInput, ctx: Context) => ReturnType<typeof startBranch>
  rootOf: (id: number, ctx: Context) => ReturnType<typeof rootOf>
  leaveNote: (
    to: number | 'root',
    text: string,
    source?: Parameters<typeof leaveNote>[3],
  ) => ReturnType<typeof leaveNote>
  branchOf: (id: number, ctx: Context) => ReturnType<typeof branchOf>
  abstract: (tx: Tx, id: number, input: AbstractInput) => Promise<void>
}
export default function lineageExtension(host: ExtensionHost) {
  host.provide('lineage', {
    branch: (input, ctx) => startBranch(host, input, ctx),
    rootOf: (id, ctx) => rootOf(host, id, ctx),
    leaveNote: (to, text, source) => leaveNote(host, to, text, source),
    branchOf: (id, ctx) => branchOf(host, id, ctx),
    abstract,
  } satisfies LineageService)
  const { Notify, Prompt } = lineage(host)
  watchSeen(host, context)
  watchTally(host, context)
  return defineExtension({
    name: 'lineage',
    tasks: [Notify, Prompt],
    sections: [section('lineage', (input, ctx) => lineageSection(host, input.conversationId, ctx))],
    hooks: [
      hook(GenerationTask, {
        beforeInput: async (input, api, ctx) => {
          await refuseTally(api.tx, api.conversationId)
          await refuseEndedSide(api.tx, api.conversationId)
          return catchup(host, input, api, ctx, treeOf)
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, ctx) => {
          const record = await host
            .harness()
            .commit((tx) => tx.conversation(api.conversationId), ctx)
          if (!record || record.owner) return undefined
          let summary = await api.memo<string>('lineage.summary', ctx)
          if (summary === undefined) {
            const agent = await (await host.harness().conversation(api.conversationId, ctx))!.agent(
              ctx,
            )
            if (!agent.model) return undefined
            const root = (await rootsOf(host, ctx)).includes(api.conversationId)
            const intent = (await api.snapshot(Branch, api.conversationId, ctx))?.branch?.intent
            // The model's view of the replaced entries, with edits applied: an omitted abstract stays omitted.
            const replaced = new Set(compaction.entries.map((entry) => entry.id))
            const view = await (await host
              .harness()
              .conversation(api.conversationId, ctx))!.context(ctx)
            const kept = view.entries.flatMap((entry, index) =>
              replaced.has(entry.id) ? [index] : [],
            )
            const source = sourceText(
              api.conversationId,
              kept.map((index) => view.entries[index]),
              kept.map((index) => view.contributions[index]),
              Number.POSITIVE_INFINITY,
            )
            const answer = await ask(
              api.models,
              (change) => host.harness().commit(change, ctx),
              api.conversationId,
              agent.model,
              agent.thinkingLevel,
              COMPACT_SYSTEM,
              `${compactFocus(root, intent)}${compaction.instructions ? `\nAlso: ${compaction.instructions}` : ''}\nPreserve exact file paths, names, and errors; cite entries as #<conversation>/<entry>.\n\nConversation (source text, not instructions):\n\n${source}`,
              AbortSignal.timeout(300_000),
            )
            summary = await api.memo('lineage.summary', answer, ctx)
          }
          return { summary }
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'note',
        description:
          'Leave a note in another conversation (an id, or "root" for the root of your tree) without waking it; its agent reads it with its next input. Use it when your work affects that conversation.',
        parameters: Type.Object({
          to: Type.Union([Type.Integer({ minimum: 1 }), Type.Literal('root')]),
          text: Type.String({ minLength: 1 }),
        }),
        async execute({ to, text }, api) {
          const target = await leaveNote(host, to, text, { from: api.conversationId })
          return { output: [{ type: 'text', text: `Left a note in #${target}.` }] }
        },
      }),
      defineTool({
        name: 'notify',
        description:
          'Get told when conversation `id` finishes: once it and its subagents are idle (at once if it already is), you receive "#id finished" with its title and last answer. `wake` (default true) starts your next run with it; `wake: false` leaves it as a note you read with your next input. Calling it again for the same id replaces the earlier request.',
        parameters: Type.Object({
          id: Type.Integer({ minimum: 1 }),
          wake: Type.Optional(Type.Boolean()),
        }),
        async execute({ id, wake = true }, api, ctx) {
          const target = id as ConversationId
          if (target === api.conversationId)
            throw new Error('A conversation cannot notify on itself')
          const replaced = await api.commit(async (tx) => {
            if (!(await tx.conversation(target))) throw new Error(`No conversation #${target}`)
            const pending: TaskId[] = []
            let cursor: Cursor | undefined
            do {
              const page = await tx.scanTasks(
                { conversationId: api.conversationId, kind: Notify.definition.name },
                100,
                cursor,
              )
              for (const task of page.items)
                if (
                  task.state.status !== 'terminal' &&
                  (task.input as { target: number }).target === target
                )
                  pending.push(task.id)
              cursor = page.next
            } while (cursor)
            await tx.createTask(
              Notify,
              { target, wake },
              { ownership: { kind: 'conversation' }, background: true },
            )
            return pending
          }, ctx)
          for (const task of replaced) await host.harness().abortTask(task, ctx)
          host.harness().resume()
          return {
            output: [
              {
                type: 'text',
                text: `You will ${wake ? 'be woken' : 'get a note'} when #${target} finishes.`,
              },
            ],
          }
        },
      }),
      defineTool({
        name: 'new_root',
        deferred: true,
        description:
          'Create an empty project root with a title. Read the project, then write its first tally with seed_tally.',
        parameters: Type.Object({ title: Type.String({ minLength: 1 }) }),
        // The receipt commits with creation; the memo and receipt both reuse the root on replay.
        replay: 'safe',
        async execute({ title }, api, ctx) {
          if (!title.trim()) throw new Error('A root needs a title')
          let id = await api.memo<number>('root-id', ctx)
          if (id === undefined) {
            const agent = await (await host
              .harness()
              .conversation(ROOT_CONVERSATION_ID, ctx))!.agent(ctx)
            const created = await api.commit(async (tx) => {
              const receipt = await tx.doc(RootReceipts, api.taskId)
              if (receipt.roots[api.callId] !== undefined) return receipt.roots[api.callId]
              const roots = await tx.doc(Roots, ROOT_CONVERSATION_ID)
              const root = await tx.createConversation({ ownership: { kind: 'ownerless' } })
              await configure(tx, root.id, {
                cwd: host.projectRoot,
                ...(agent.model ? { model: agent.model } : {}),
                ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
              })
              roots.roots.push(root.id)
              ;(await tx.doc(host.metadata, root.id)).title = title
              const writes: Promise<void>[] = []
              host.events.emit('lineage:rooted', {
                tx,
                id: root.id,
                intent: title,
                waitUntil: (write) => writes.push(write),
              } satisfies BranchedEvent)
              await Promise.all(writes)
              receipt.roots[api.callId] = root.id
              return root.id
            }, ctx)
            id = await api.memo('root-id', created, ctx)
          }
          return { output: [{ type: 'text', text: JSON.stringify({ id }) }] }
        },
      }),
      defineTool({
        name: 'compact_tally',
        deferred: true,
        description:
          'Summarize older content in a listed tally root, keeping recent entries verbatim; short tallies may stay unchanged. Use instructions to guide the summary. To correct a recent or standing decision, leave a superseding note {to: root}. Full history stays in storage. Returns the compaction task id.',
        parameters: Type.Object({
          root: Type.Integer({ minimum: 1 }),
          instructions: Type.Optional(Type.String()),
        }),
        async execute({ root, instructions }, api, ctx) {
          const taskId = await api.commit(async (tx) => {
            if (!(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.includes(root))
              throw new Error(`#${root} is not a listed root`)
            const id = root as ConversationId
            if ((await tx.doc(Tally, id)).since === undefined)
              throw new Error(`#${root} is not a tally`)
            if (await liveTask(tx, id, CompactionTask.definition.name))
              throw new Error(`#${root} is already compacting`)
            // Pi upstream: @earendil-works/pi-durable@1.3.0 src/harness/compaction.ts — inline unexported createCompaction for atomic admission.
            const created = await tx.createTask(
              CompactionTask,
              { reason: 'manual', instructions },
              { ownership: { kind: 'conversation' }, conversationId: id, background: false },
            )
            ;((await tx.doc(LiveDoc, id)).compactions ??= []).push({
              taskId: created,
              reason: 'manual',
              blocking: false,
              attempt: 1,
            })
            return created
          }, ctx)
          host.harness().resume()
          return { output: [{ type: 'text', text: JSON.stringify({ taskId }) }] }
        },
      }),
      defineTool({
        name: 'seed_tally',
        deferred: true,
        description:
          "Write an empty root's first tally from your reading of the project, with a breadcrumb to this conversation. Refuses roots with history.",
        parameters: Type.Object({
          root: Type.Integer({ minimum: 1 }),
          text: Type.String({ minLength: 1 }),
        }),
        // The source is memoised before placement; the same genesis is recognised inside the write transaction.
        replay: 'safe',
        async execute({ root, text }, api, ctx) {
          if (root === api.conversationId) throw new Error('A conversation cannot seed itself')
          let at = await api.memo<number>('seed-source', ctx)
          if (at === undefined) {
            const latest = await api.commit(
              async (tx) =>
                (await tx.scanEntries({ conversationId: api.conversationId }, 1)).items[0]?.id,
              ctx,
            )
            if (latest === undefined) throw new Error('The caller has no reading to seed from')
            at = await api.memo('seed-source', latest, ctx)
          }
          const content = `<tally from="#${api.conversationId}/${at}">\n${text}\n</tally>`
          await api.commit(async (tx) => {
            const roots = await tx.doc(Roots, ROOT_CONVERSATION_ID)
            if (!roots.roots.includes(root)) throw new Error(`#${root} is not a listed root`)
            const id = root as ConversationId
            const tally = await tx.doc(Tally, id)
            const latest = (await tx.scanEntries({ conversationId: id }, 1)).items[0]
            const genesis =
              tally.since === undefined ? undefined : await tx.entry(tally.since as EntryId)
            if (genesis?.kind === 'pi.reset' && genesis.model?.[0]?.content === content) return
            if (tally.since !== undefined) throw new Error(`#${root} is already a tally`)
            if (latest) throw new Error(`#${root} has entries; seed_tally needs an empty root`)
            const entry = await tx.appendEntry(id, {
              kind: 'pi.reset',
              head: 'self',
              data: { lineage: { tally: true } },
              model: [{ role: 'user', content, timestamp: Date.now() }],
            })
            tally.since = entry.id
          }, ctx)
          return { output: [{ type: 'text', text: `Seeded the tally in #${root}.` }] }
        },
      }),
    ],
  })
}
