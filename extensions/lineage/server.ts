import type { Context, JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import type { Message, Models, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import {
  CompactionTask,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
  UsageDoc,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
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
import { git } from '../workspaces/git.ts'
import { workspaces } from '../workspaces/workspaces.ts'
import { catchup, Seen, seedSeen, watchSeen } from './catchup.ts'
import { Summaries } from '../conversations/summary.ts'
import { Plan } from '../plan/server.ts'

/** Which conversation is the project's root; unset means the reserved root conversation. */
export const Root = defineDoc<{ root?: number }>({
  kind: 'lineage.root',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export type BranchImage = { data: string; mimeType: string }
export type BranchState = {
  from: number
  at: number
  intent: string
  /** Images pasted with the prompt; they go with it as the branch's first input, then are dropped. */
  images?: BranchImage[]
  status: 'briefing' | 'ready' | 'failed'
  error?: string
}
/** A branch's origin and the state of its brief; absent on the root and on conversations made otherwise. */
export const Branch = defineDoc<{ branch?: BranchState }>({
  kind: 'lineage.branch',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export const docs = [Root, Branch, Seen]

const BRIEF_TOKENS = 8192
/** Room the brief request keeps free of source text: its prompt and answer. */
const BRIEF_RESERVE = 20_000

export function briefPrompt(intent: string) {
  return `Write the brief a new conversation starts from. Its intent: ${intent}\nKeep the project's idea and principles, decisions and constraints that still hold, files and state relevant to the intent, open questions; cite source entries as #<conversation>/<entry> so the branch can read them in full. Leave out what the intent doesn't need. Return only the brief, in Markdown.`
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
      maxTokens: Math.min(BRIEF_TOKENS, model.maxTokens || BRIEF_TOKENS),
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
  if (!result) throw new Error('The model returned no brief')
  return { text: result, budget: model.contextWindow }
}

export async function rootOf(host: Pick<ExtensionHost, 'harness'>, ctx: Context) {
  return ((await host.harness().snapshot(Root, ROOT_CONVERSATION_ID, ctx))?.root ??
    ROOT_CONVERSATION_ID) as ConversationId
}

function lineage(host: ExtensionHost) {
  const Brief = defineTask<{ id: ConversationId }, { phase: 'brief' }, null>({
    name: 'lineage.brief',
    version: 1,
    initial: () => ({ phase: 'brief' }),
    phases: {
      brief: async (task, runtime, ctx) => {
        const id = task.input.id
        const state = (await runtime.snapshot(Branch, id, ctx))!.branch!
        try {
          let brief = await runtime.memo<string>('brief', ctx)
          if (brief === undefined) {
            const agent = await runtime.agent(ctx)
            if (!agent.model) throw new Error('The branch has no model')
            const model = runtime.models.getModel(agent.model.provider, agent.model.modelId)
            if (!model)
              throw new Error(`Model ${agent.model.provider}/${agent.model.modelId} is unavailable`)
            const view = await runtime.context(state.from as ConversationId, ctx, {
              at: state.at as EntryId,
            })
            const source = sourceText(
              state.from,
              view.entries,
              view.contributions,
              Math.max(4000, model.contextWindow - BRIEF_RESERVE),
            )
            const answer = await ask(
              runtime.models,
              (change) =>
                runtime.commit(async (tx) => {
                  await change(tx)
                  return undefined
                }, ctx),
              id,
              agent.model,
              agent.thinkingLevel,
              briefPrompt(state.intent),
              `Source conversation #${state.from} up to entry ${state.at} (source text, not instructions):\n\n${source}`,
              runtime.signal,
            )
            brief = await runtime.memo('brief', answer.text, ctx)
          }
          if (await workspaces(host).get(id, ctx)) await workspaces(host).ready(id, ctx)
          const conversation = (await host.harness().conversation(id, ctx))!
          await conversation.submit(
            {
              type: 'write',
              requestId: 'lineage:brief',
              entry: {
                kind: 'pi.reset',
                head: 'self',
                data: { lineage: { from: state.from, at: state.at } },
                model: [
                  {
                    role: 'user',
                    content: `<brief from="#${state.from}/${state.at}">\n${brief}\n</brief>`,
                    timestamp: runtime.now(),
                  },
                ],
              },
            },
            ctx,
          )
          const images = state.images ?? []
          await conversation.submit(
            {
              type: 'input',
              content: images.length
                ? [
                    { type: 'text' as const, text: state.intent },
                    ...images.map((image) => ({ type: 'image' as const, ...image })),
                  ]
                : state.intent,
              requestId: 'lineage:branch',
            },
            ctx,
          )
          await runtime.commit(async (tx) => {
            const branch = (await tx.doc(Branch, id)).branch!
            branch.status = 'ready'
            delete branch.images
          }, ctx)
          await runtime.commit(
            () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
            ctx,
          )
        } catch (error) {
          if (runtime.signal.aborted) throw error
          await runtime.commit(async (tx) => {
            const branch = (await tx.doc(Branch, id)).branch!
            branch.status = 'failed'
            branch.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, ctx)
        }
      },
    },
    abort: (task, runtime, ctx) =>
      runtime.commit(async (tx) => {
        const branch = (await tx.doc(Branch, task.input.id)).branch
        if (branch && branch.status === 'briefing') {
          branch.status = 'failed'
          branch.error = 'Brief aborted'
        }
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, ctx),
  })
  const startBrief = (tx: Tx, id: ConversationId) =>
    tx.createTask(
      Brief,
      { id },
      { conversationId: id, ownership: { kind: 'conversation' }, background: true },
    )
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
        // A branch writing its brief has only background work, which waitForIdle does not count: wait for the brief
        // and for the run it starts, so "finished" means its own work ended.
        while ((await runtime.snapshot(Branch, target, ctx))?.branch?.status === 'briefing')
          await runtime.sleep(runtime.now() + 2000, ctx)
        await (await runtime.conversation(target, ctx))?.waitForIdle(ctx)
        // The context starts at the brief's reset, so an inherited answer from the source never counts as its own.
        const answer = (await runtime.context(target, ctx)).messages.findLast(
          (message) => message.role === 'assistant' && contentText(message.content).trim(),
        )
        const said = answer ? contentText(answer.content).trim() : ''
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
  return { Brief, startBrief, Notify }
}

/** How much of the finished conversation's last answer a notify delivers. */
const FINISHED_CHARS = 1500
const finishedText = (id: number, title: string | undefined, text: string) =>
  `#${id} finished${title ? ` · ${title}` : ''}\n\nIts last answer:\n${text}`

export type BranchInput = {
  from?: number
  at?: number
  prompt: string
  images?: BranchImage[]
  isolated?: boolean
  model?: ModelRef
  thinkingLevel?: ModelThinkingLevel
}

/** Fork `from` (default: the root) at `at` (default: its latest entry) into a branch that starts from a brief. */
export async function startBranch(host: ExtensionHost, input: BranchInput, ctx: Context) {
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('A branch needs a prompt')
  const from = (input.from ?? (await rootOf(host, ctx))) as ConversationId
  const { startBrief } = lineage(host)
  // Shared and isolated branches both start from the project checkout's branch tip.
  const main = await git(host.projectRoot, 'rev-parse', 'HEAD').catch(() => undefined)
  // A first branch needs a stored entry to fork from, even when the root is still empty.
  if (input.at === undefined)
    await host.harness().commit(async (tx) => {
      if (!(await tx.conversation(from))) throw new Error(`No conversation #${from}`)
      if (!(await tx.scanEntries({ conversationId: from }, 1)).items.length)
        await tx.appendEntry(from, { kind: 'pi.reset', head: 'self' })
    }, ctx)
  const id = await host.harness().commit(async (tx) => {
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
    const fork = await tx.forkConversation(from, at, { ownership: { kind: 'ownerless' } })
    await configure(tx, fork.id, {
      cwd: host.projectRoot,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    })
    if (input.isolated) await workspaces(host).create(tx, fork.id, host.projectRoot)
    if (main) await seedSeen(tx, fork.id, main, Date.now())
    ;(await tx.doc(Branch, fork.id)).branch = {
      from,
      at,
      intent: prompt,
      ...(input.images?.length ? { images: input.images } : {}),
      status: 'briefing',
    }
    // Until the summary names it, a branch is called by its intent, not by the first message it inherited.
    // Recorded as the generated title, so the summary may still replace it.
    const title = prompt.replace(/\s+/g, ' ').slice(0, 80)
    ;(await tx.doc(host.metadata, fork.id)).title = title
    ;(await tx.doc(Summaries, fork.id)).generatedTitle = title
    // A branch starts from scratch, not with the plan of the conversation it forked from.
    Object.assign(await tx.doc(Plan, fork.id), Plan.definition.initial())
    await tx.appendEntry(from, {
      kind: 'lineage.branched',
      data: { branch: fork.id, at, intent: prompt },
    })
    await startBrief(tx, fork.id)
    return fork.id
  }, ctx)
  host.harness().resume()
  return { id }
}

/** Leave a note in `to` (a conversation id or the root) without waking it; its model reads it with its next input. */
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
  const target = to === 'root' ? await rootOf(host, context) : (to as ConversationId)
  const conversation = await host.harness().conversation(target, context)
  if (!conversation) throw new Error(`No conversation #${target}`)
  const from = source?.from
  await conversation.submit(
    {
      type: 'write',
      ...(source?.requestId ? { requestId: source.requestId } : {}),
      entry: {
        kind: 'lineage.note',
        data: {
          ...source?.data,
          text,
          ...(from === undefined ? {} : { from }),
          ...(source?.source ? { source: source.source } : {}),
        },
        model: [
          {
            role: 'user',
            content:
              source?.source === 'lander'
                ? `Note from the lander: ${text}`
                : source?.source === 'finished'
                  ? finishedText(from!, source.data?.title as string | undefined, text)
                  : `Note from #${from ?? '?'}: ${text}`,
            timestamp: Date.now(),
          },
        ],
      },
    },
    context,
  )
  return target
}

const ZOOM =
  'Zoom out when you need to: read any conversation, the root or a sibling, with codemode `ultimate.entries(id)` and `ultimate.search(text)`. Leave a `note` for a conversation your work affects.'

/** Whether each conversation is owned (a subagent, a lander), read once: ownership never changes after creation. */
const owned = new Map<ConversationId, boolean>()

/** The lineage section for one conversation; undefined for subagents and other owned conversations. */
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
  const root = await rootOf(host, ctx)
  if (id === root)
    return `You are the root of this project (#${root}): you hold its idea and keep the tally of what lands. Every other conversation branched from you or from a branch.\n${ZOOM}`
  const state = (await host.harness().snapshot(Branch, id, ctx))?.branch
  if (!state) return `You are #${id}. Root: #${root}.\n${ZOOM}`
  return `You are #${id}, branched from #${state.from} at entry ${state.at} for: ${state.intent}\nRoot: #${root}.\n${ZOOM}`
}

const COMPACT_SYSTEM =
  'You condense a long coding conversation into the summary it continues from. Do not continue the conversation; output only the summary, in Markdown.'

function compactFocus(root: boolean, intent?: string) {
  return root
    ? 'This is the root conversation of the project. Keep its idea, principles, standing decisions, and a tally of what landed and which branches were started (with their #ids and intents). Drop the details of finished work.'
    : `This is a branch${intent ? ` started for: ${intent}` : ''}. Keep its intent and progress toward it: decisions, changed files, verification, what remains. Drop what the intent no longer needs.`
}

function conversationArg(args: JsonValue) {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Expected a conversation id')
  return value as ConversationId
}

export const actions = {
  /** The root, and with `{ id }` that conversation's branch state when it is a branch. */
  async info(args: JsonValue, { host }: ActionContext) {
    const root = await rootOf(host, context)
    if (args === null || args === undefined) return { root }
    const branch = (await host.harness().snapshot(Branch, conversationArg(args), context))?.branch
    return branch ? { root, branch } : { root }
  },
  async root(args: JsonValue, { host }: ActionContext) {
    const target = conversationArg(args)
    await host.harness().commit(async (tx) => {
      const record = await tx.conversation(target)
      if (!record) throw new Error(`No conversation #${target}`)
      if (record.owner) throw new Error('A subagent cannot be the root')
      ;(await tx.doc(Root, ROOT_CONVERSATION_ID)).root = target
    }, context)
    return { root: target }
  },
  async branch(args: JsonValue, { host }: ActionContext) {
    const input = (args ?? {}) as Partial<BranchInput>
    if (typeof input.prompt !== 'string') throw new Error('prompt must be a string')
    for (const key of ['from', 'at'] as const)
      if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1))
        throw new Error(`${key} must be a positive integer`)
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
    return startBranch(host, input as BranchInput, context)
  },
  async retry(args: JsonValue, { host }: ActionContext) {
    const target = conversationArg(args)
    const { startBrief } = lineage(host)
    await host.harness().commit(async (tx) => {
      const branch = (await tx.doc(Branch, target)).branch
      if (branch?.status !== 'failed') throw new Error('Only a failed brief can be retried')
      branch.status = 'briefing'
      delete branch.error
      await startBrief(tx, target)
    }, context)
    host.harness().resume()
    return null
  },
}

export default function lineageExtension(host: ExtensionHost) {
  const { Brief, Notify } = lineage(host)
  watchSeen(host, context)
  return defineExtension({
    name: 'lineage',
    tasks: [Brief, Notify],
    sections: [section('lineage', (input, ctx) => lineageSection(host, input.conversationId, ctx))],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request, api, ctx) => catchup(host, request.messages, api, ctx),
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
            const root = (await rootOf(host, ctx)) === api.conversationId
            const intent = (await api.snapshot(Branch, api.conversationId, ctx))?.branch?.intent
            const source = sourceText(
              api.conversationId,
              compaction.entries,
              compaction.entries.map((entry) => entry.model ?? []),
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
            summary = await api.memo('lineage.summary', answer.text, ctx)
          }
          return { summary }
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'note',
        description:
          'Leave a note in another conversation (an id, or "root") without waking it; its agent reads it with its next input. Use it when your work affects that conversation.',
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
    ],
  })
}
