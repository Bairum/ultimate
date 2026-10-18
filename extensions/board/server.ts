import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT, awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  configure,
  InboxDoc,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  GenerationResult,
  SubmissionId,
  TaskId,
  Tx,
} from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { QuestionsApi } from '../questions/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { isolatable } from '../../lib/git.ts'

import { Standing, Subagents, SubagentsApi } from '../subagents/api.ts'
import { primaryAgent } from '../../lib/machine.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { LineageApi, Roots } from '../lineage/api.ts'
import { Board, BoardApi } from './api.ts'
import type { BoardMessage } from './api.ts'
export const docs = [Board]
// The receipt commits with the message, closing the gap before api.memo records its id.
const Sent = defineDoc<{ ids: Record<string, number> }>({
  kind: 'board.sent-calls',
  version: 1,
  scope: 'task',
  initial: () => ({ ids: {} }),
})
// Pipeline requests outlive their calling task, so their receipts belong to the sender conversation.
const Requests = defineDoc<{ ids: Record<string, number> }>({
  kind: 'board.requests',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ ids: {} }),
})
/**
 * Who started a branch through `branch`, so its later final answers reach that conversation. `yielded` is the newest
 * generation observed, so a replayed hook creates no second observer.
 */
const Started = defineDoc<{ by?: number; yielded?: number }>({
  kind: 'board.started',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
/** An answer that asks for a decision wakes the starter: it ends with a question or numbered options. */
function needsDecision(text: string) {
  const last = text
    .trim()
    .split('\n')
    .at(-1)!
    .trim()
    .replace(/[*_`]+$/, '')
  return last.endsWith('?') || /^\d+[.)]\s/.test(last)
}
/** A reply-enabled message to the user that the user has not answered yet. */
const openQuestion = (m: BoardMessage) => m.to === 'user' && m.reply && m.state === 'delivered'
/** Typing in a conversation answers the questions it asked the user before that input. */
async function answerByInput(host: ExtensionHost, from: number, at: number) {
  const asked = (m: BoardMessage) => openQuestion(m) && m.from === from && m.at < at
  const log = await host.harness().snapshot(Board, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
  if (!log?.messages.some(asked)) return
  await host.harness().commit(async (tx) => {
    for (const m of (await tx.doc(Board, ROOT_CONVERSATION_ID)).messages)
      if (asked(m)) m.state = 'answered'
  }, BACKGROUND_CONTEXT)
}
async function append(tx: Tx, input: Omit<BoardMessage, 'id' | 'at'>) {
  const log = await tx.doc(Board, ROOT_CONVERSATION_ID)
  const message = { ...input, id: log.next++, at: Date.now() }
  log.messages.push(message)
  if (log.messages.length > 300) log.messages.splice(0, log.messages.length - 300)
  return message
}
function delivery(host: ExtensionHost) {
  const refresh = async (id: number, ctx: Context) => {
    const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
    const name = Object.keys(index ?? {}).find((candidate) => index![candidate] === id)
    if (name !== undefined) await host.want(SubagentsApi)?.standing(name, ctx)
  }
  return defineTask<
    { message: BoardMessage; steer: boolean; note: boolean; fromLabel: string; toLabel: string },
    { phase: 'deliver' } | { phase: 'reply'; message: BoardMessage; failed: boolean },
    null
  >({
    name: 'board.delivery',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const m = task.input.message
        if (m.to === 'user') throw new Error('Messages to the user need no delivery task')
        await refresh(m.to, ctx)
        const recipient = await host.harness().conversation(m.to as ConversationId, ctx)
        if (!recipient) throw new Error(`Unknown conversation #${m.to}`)
        const entry = {
          kind: 'board.message',
          data: {
            id: m.id,
            from: m.from,
            text: m.text,
            reply: m.reply,
            delivery: task.input.note ? 'note' : task.input.steer ? 'steer' : 'followUp',
          },
        }
        const content = task.input.note
          ? `Note from ${task.input.fromLabel} (one-way update, no answer goes back):\n${m.text}`
          : `Message from ${task.input.fromLabel}:\n${m.text}${m.reply ? `\nAnswer here; your answer is sent to ${task.input.fromLabel} automatically. Do not use message to reply.` : `\nOne-way message: ${task.input.fromLabel} expects no answer, and your answer here is not sent to it. If it needs to hear from you, message it.`}`
        const requestId = `board:${m.id}`
        const receipt = task.input.note
          ? await recipient.submit(
              {
                type: 'write',
                requestId,
                entry: { ...entry, model: [{ role: 'user', content, timestamp: Date.now() }] },
              },
              ctx,
            )
          : await recipient.submit(
              {
                type: 'input',
                requestId,
                whenBusy: task.input.steer ? 'steer' : 'followUp',
                entry,
                content,
              },
              ctx,
            )
        {
          // Admission can precede placement while a recipient is busy. Watch its durable queue,
          // not a timer, so messages become delivered only after leaving the queue.
          const inbox = await runtime.watchDoc(InboxDoc, recipient.id, ctx)
          if (inbox) {
            let wake!: () => void
            const placed = new Promise<void>((done) => {
              wake = done
            })
            const inspect = (value: typeof inbox.value) => {
              if (!value?.items.some((item) => item.id === receipt.id)) wake()
            }
            inbox.start(async (value) => {
              inspect(value)
            })
            try {
              inspect(inbox.value)
              await awaitWithContext(placed, ctx)
            } finally {
              await inbox.stop()
            }
          }
          const placement = await receipt.status(ctx)
          await runtime.commit(async (tx) => {
            const stored = (await tx.doc(Board, ROOT_CONVERSATION_ID)).messages.find(
              (item) => item.id === m.id,
            )
            if (stored) {
              stored.state = placement.status === 'unanswered' ? 'failed' : 'delivered'
              if ('entry' in placement && placement.entry !== undefined)
                stored.entry = placement.entry
            }
            if (task.input.note)
              return { status: 'terminal', outcome: { status: 'completed', result: null } }
            return undefined
          }, ctx)
          if (task.input.note) return
        }
        const settled = await receipt.wait(ctx)
        await runtime.commit(async (tx) => {
          const answer =
            settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined
          if (!m.reply) {
            const original = (await tx.doc(Board, ROOT_CONVERSATION_ID)).messages.find(
              (item) => item.id === m.id,
            )
            if (original && answer !== undefined) original.answer = answer
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }
          const model =
            answer === undefined ? undefined : (await tx.entry(AssistantEntry, answer))?.model?.[0]
          const text =
            model?.role === 'assistant'
              ? model.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
              : ''
          const failed =
            !text.trim() ||
            model?.role !== 'assistant' ||
            model.stopReason === 'error' ||
            model.stopReason === 'aborted'
          const error = failed
            ? `ended its turn without an answer (${settled.status === 'unanswered' ? settled.reason : settled.status})`
            : undefined
          const original = (await tx.doc(Board, ROOT_CONVERSATION_ID)).messages.find(
            (item) => item.id === m.id,
          )
          if (original) {
            original.state = failed ? 'failed' : 'answered'
            if (answer !== undefined) original.answer = answer
            if (error !== undefined) original.error = error
            if ('entry' in settled && settled.entry !== undefined) original.entry = settled.entry
          }
          const response = await append(tx, {
            from: m.to,
            to: m.from,
            text: error ?? text,
            reply: false,
            re: m.id,
            state: failed ? 'failed' : 'sent',
            ...(answer ? { answer } : {}),
            ...(error ? { error } : {}),
          })
          return { status: 'running', checkpoint: { phase: 'reply', message: response, failed } }
        }, ctx)
      },
      reply: async (task, runtime, ctx) => {
        const { message: m, failed } = task.state.checkpoint
        if (m.to !== 'user') {
          await refresh(m.to, ctx)
          const sender = await runtime.conversation(m.to as ConversationId, ctx)
          if (sender)
            await sender.submit(
              {
                type: 'input',
                requestId: `board-reply:${m.id}`,
                whenBusy: 'steer',
                entry: {
                  kind: 'board.reply',
                  data: { id: m.id, re: m.re!, from: m.from, text: m.text, failed },
                },
                content: `Reply from ${task.input.toLabel} to your message ${m.re}${failed ? ' (failed)' : ''}:\n${m.text}`,
              },
              ctx,
            )
        }
        await runtime.commit(async (tx) => {
          const stored = (await tx.doc(Board, ROOT_CONVERSATION_ID)).messages.find(
            (item) => item.id === m.id,
          )
          if (stored && !failed) stored.state = 'delivered'
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
const terminal = { status: 'terminal', outcome: { status: 'completed', result: null } } as const
/**
 * After a branch's run, its final answer reaches the conversation that started it, unless that answer already does:
 * as the answer to the starter's reply-enabled message, or because the run messaged the starter itself. Routing only
 * goes from a branch to its starter, which existed first, and a routed message is one-way: it cannot ping-pong.
 */
function route(host: ExtensionHost) {
  return defineTask<
    { generation: TaskId<GenerationResult>; inputs: SubmissionId[]; by: number },
    { phase: 'observe' },
    null
  >({
    name: 'board.route',
    version: 1,
    initial: () => ({ phase: 'observe' }),
    phases: {
      observe: async (task, runtime, ctx) => {
        const settled = await runtime.waitForTask(task.input.generation, ctx)
        if (settled.state.outcome.status !== 'completed') {
          await runtime.commit(() => terminal, ctx)
          return
        }
        const answer = settled.state.outcome.result.entryId
        const inputs = await Promise.all(
          task.input.inputs.map(async (id) =>
            (await host.harness().submission(id, ctx))?.status(ctx),
          ),
        )
        const { by } = task.input
        const id = runtime.conversationId
        const text = await host.harness().commit(async (tx) => {
          // A continued generation's answer is no run's final answer: only inputs it settled make one.
          const answered = inputs.flatMap((input) =>
            input?.type === 'input' && input.status === 'done' && input.answer === answer
              ? [input.entry]
              : [],
          )
          let since = Number.POSITIVE_INFINITY
          for (const entryId of answered) {
            const entry = await tx.entry(entryId)
            // board.delivery returns the answer to the starter's reply-enabled message; a one-way one gets none.
            const data = entry?.data as { from?: unknown; reply?: unknown } | undefined
            if (entry?.kind === 'board.message' && data?.from === by && data.reply === true)
              return undefined
            since = Math.min(since, entry?.model?.[0]?.timestamp ?? since)
          }
          if (!answered.length) return undefined
          const message = (await tx.entry(answer))?.model?.[0]
          if (
            message?.role !== 'assistant' ||
            message.stopReason === 'error' ||
            message.stopReason === 'aborted'
          )
            return undefined
          const until = message.timestamp
          // Only tool calls count: an earlier run's routed answer can land after this run's input.
          const messaged = (await tx.doc(Board, ROOT_CONVERSATION_ID)).messages.some(
            (m) =>
              m.from === id &&
              m.to === by &&
              m.call !== undefined &&
              m.at >= since &&
              m.at <= until,
          )
          if (messaged) return undefined
          return message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
        }, ctx)
        if (text?.trim())
          await send(
            host,
            id,
            { to: `#${by}`, text, reply: false },
            ctx,
            undefined,
            undefined,
            `route:${answer}`,
            undefined,
            !needsDecision(text),
          )
        await runtime.commit(() => terminal, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
/** The conversation that started `id` as a subagent, which is the only one it may message. */
async function parentOf(host: ExtensionHost, id: number, ctx: Context) {
  const owner = (await host.harness().commit((tx) => tx.conversation(id as ConversationId), ctx))
    ?.owner?.conversationId
  if (owner === undefined) return undefined
  return (await host.harness().snapshot(Subagents, owner, ctx))?.agents[String(id)]
    ? owner
    : undefined
}
async function lander(host: ExtensionHost, ctx: Context) {
  const service = host.want(WorkspacesApi)
  if (!service) return undefined
  const checkout = await isolatable(host.projectRoot)
  if ('reason' in checkout) return undefined
  return (await host.harness().snapshot(service.doc, ROOT_CONVERSATION_ID, ctx))
    ?.landerConversations[checkout.source]
}
async function senderName(host: ExtensionHost, id: number | 'user', ctx: Context) {
  if (id === 'user') return 'user'
  const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  const name = Object.keys(index ?? {}).find((candidate) => index?.[candidate] === id)
  const workspaces = host.want(WorkspacesApi)
  const workspace = workspaces
    ? await host.harness().snapshot(workspaces.doc, ROOT_CONVERSATION_ID, ctx)
    : undefined
  const label =
    name ??
    (Object.values(workspace?.landerConversations ?? {}).includes(id) ? 'lander' : undefined)
  return `#${id}${label ? ` (@${label})` : ''}`
}
async function resolve(host: ExtensionHost, to: string, from: number | 'user', ctx: Context) {
  if (to === 'user') return to
  let id: number | undefined
  if (to === '@lander') id = await lander(host, ctx)
  else if (to.startsWith('@')) {
    const service = host.want(SubagentsApi)
    const valid = (await service?.residents(ctx)) ?? []
    if (!valid.some((item) => `@${item.name}` === to))
      throw new Error(
        `Unknown address ${to}. Valid standing agents: ${valid.map((item) => `@${item.name}`).join(', ') || '(none)'}`,
      )
    id = await service!.standing(to.slice(1), ctx)
  } else if (/^#?\d+$/.test(to)) id = Number(to.replace('#', ''))
  if (id === undefined) throw new Error(`No recipient for ${to}`)
  if (id === from) throw new Error('You cannot message yourself')
  await host.harness().commit(async (tx) => {
    if (!(await tx.conversation(id as ConversationId)))
      throw new Error(`Unknown conversation #${id}`)
    const roots = host.doc('lineage.roots')
    const tally = host.doc('lineage.tally')
    if (roots && tally) {
      const index = (await tx.doc(roots, ROOT_CONVERSATION_ID)) as { roots?: number[] }
      const state = (await tx.doc(tally, id as ConversationId)) as {
        since?: number
        converting?: unknown
      }
      if (index.roots?.includes(id) && (state.since !== undefined || state.converting))
        throw new Error(`#${id} is a tally and takes no inputs; use note instead`)
    }
  }, ctx)
  return id
}
async function send(
  host: ExtensionHost,
  from: number | 'user',
  input: { to: string; text: string; reply?: boolean; steer?: boolean; re?: number },
  ctx: Context,
  taskId?: TaskId,
  callId?: string,
  requestId?: string,
  answerId?: number,
  note?: boolean,
) {
  if (requestId !== undefined && from !== 'user') {
    const sent = await host.harness().snapshot(Requests, from as ConversationId, ctx)
    if (sent?.ids[requestId] !== undefined) return sent.ids[requestId]
  }
  if (taskId !== undefined) {
    const sent = await host.harness().snapshot(Sent, taskId, ctx)
    if (callId !== undefined && sent?.ids[callId] !== undefined) return sent.ids[callId]
  }
  const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  const primary = primaryAgent(host.projectRoot, host.userHome)
  // The primary agent's messages to a busy conversation almost always steer it: new scope, a decision, a stop.
  const steer = input.steer ?? (from !== 'user' && from === standing?.[primary])
  if (input.to === 'user') {
    if (from !== standing?.[primary])
      throw new Error(
        `Only @${primary} messages the user; send this to @${primary} (reply: false) and it relays it.`,
      )
  }
  if (!input.text.trim()) throw new Error('Message text must not be empty')
  // Checked before resolving, which may create a standing agent's conversation.
  const parent = from === 'user' ? undefined : await parentOf(host, from, ctx)
  if (parent !== undefined && input.to.replace(/^#/, '') !== String(parent))
    throw new Error(
      `Subagents report to the conversation that started them: message only #${parent}. Your final answer reaches it anyway.`,
    )
  const to = await resolve(host, input.to, from, ctx)
  const fromLabel = await senderName(host, from, ctx)
  const toLabel = await senderName(host, to, ctx)
  return host.harness().commit(async (tx) => {
    const receipt = taskId === undefined ? undefined : await tx.doc(Sent, taskId)
    const requests =
      requestId === undefined || from === 'user'
        ? undefined
        : await tx.doc(Requests, from as ConversationId)
    if (requestId !== undefined && requests?.ids[requestId] !== undefined)
      return requests.ids[requestId]
    if (callId !== undefined && receipt?.ids[callId] !== undefined) return receipt.ids[callId]
    if (answerId !== undefined) {
      const original = (await tx.doc(Board, ROOT_CONVERSATION_ID)).messages.find(
        (m) => m.id === answerId,
      )
      if (!original || !openQuestion(original))
        throw new Error('These questions are no longer open')
    }
    // Writing to a conversation, as a Reply or a new post, answers the questions it asked the user.
    if (from === 'user' && to !== 'user')
      for (const m of (await tx.doc(Board, ROOT_CONVERSATION_ID)).messages)
        if (openQuestion(m) && (m.from === to || m.id === input.re)) m.state = 'answered'
    if (from !== 'user' && input.reply !== false) {
      const log = await tx.doc(Board, ROOT_CONVERSATION_ID)
      const pending = log.messages.find(
        (m) =>
          m.to === from &&
          m.from === to &&
          m.reply &&
          (m.state === 'sent' || m.state === 'delivered'),
      )
      if (pending)
        throw new Error(
          `Your answer to ${toLabel}'s message ${pending.id} is sent back automatically. Answer instead of messaging.`,
        )
    }
    const message = await append(tx, {
      from,
      to,
      text: input.text,
      reply: input.reply ?? true,
      state: to === 'user' ? 'delivered' : 'sent',
      ...(input.re === undefined ? {} : { re: input.re }),
      ...(callId === undefined ? {} : { call: callId }),
    })
    if (to === 'user' && message.reply && from !== 'user')
      await host.want(QuestionsApi)?.request(tx, message)
    if (to !== 'user')
      await tx.createTask(
        delivery(host),
        {
          message,
          steer,
          note: note ?? (parent === to && input.reply === false),
          fromLabel,
          toLabel,
        },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
    if (receipt && callId !== undefined) receipt.ids[callId] = message.id
    if (requests && requestId !== undefined) requests.ids[requestId] = message.id
    return message.id
  }, ctx)
}
export const actions = {
  async addresses(_args: unknown, { host }: ActionContext) {
    const agents = (await host.want(SubagentsApi)?.residents(BACKGROUND_CONTEXT)) ?? []
    const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
    const conversations = host
      .conversations()
      .filter((c) => !c.parentConversationId)
      .toSorted((a, b) => (b.inputAt ?? b.id) - (a.inputAt ?? a.id))
      .slice(0, 50)
    return {
      agents: agents.map((a) => ({
        ...a,
        ...(index?.[a.name] === undefined ? {} : { id: index[a.name] }),
      })),
      lander: await lander(host, BACKGROUND_CONTEXT),
      conversations,
    }
  },
}
export default function board(host: ExtensionHost) {
  // Optional services, resolved where they are called; declared here so the catalogue lists them.
  host.want(LineageApi)
  host.want(QuestionsApi)
  host.want(SubagentsApi)
  host.want(WorkspacesApi)
  host.implement(BoardApi, {
    answer: async (messageId, text, ctx) => {
      const log = await host.harness().snapshot(Board, ROOT_CONVERSATION_ID, ctx)
      const message = log?.messages.find((m) => m.id === messageId)
      if (!message || !openQuestion(message)) throw new Error('These questions are no longer open')
      return send(
        host,
        'user',
        { to: `#${message.from}`, text, re: messageId },
        ctx,
        undefined,
        undefined,
        undefined,
        messageId,
      )
    },
    send: (from, input, requestId, ctx) =>
      send(host, from, input, ctx, undefined, undefined, requestId),
  })
  let stop: (() => void) | undefined
  const answering = new Set<Promise<void>>()
  host.onOpen(async () => {
    stop = host.harness().subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (change.type === 'entry' && change.value.kind === 'pi.user') {
          const done: Promise<void> = answerByInput(
            host,
            change.value.conversationId,
            change.value.model?.[0]?.timestamp ?? Date.now(),
          )
            .catch((error: unknown) => host.notice(`Board: ${String(error)}`))
            .finally(() => answering.delete(done))
          answering.add(done)
        }
    })
  })
  host.onClose(async () => {
    stop?.()
    stop = undefined
    await Promise.all(answering)
  })
  return defineExtension({
    name: 'board',
    tasks: [delivery(host), route(host)],
    hooks: [
      hook(GenerationTask, {
        onYield: async (_answer, api, ctx) => {
          const by = (await api.snapshot(Started, api.conversationId, ctx))?.by
          if (by === undefined) return undefined
          await host.harness().commit(async (tx) => {
            // One observer per generation, decided in the commit that creates it.
            const started = await tx.doc(Started, api.conversationId)
            if (started.yielded !== undefined && started.yielded >= api.taskId) return
            started.yielded = api.taskId
            await tx.createTask(
              route(host),
              {
                generation: api.taskId as TaskId<GenerationResult>,
                inputs: [...((await tx.doc(LiveDoc, api.conversationId)).run?.inputs ?? [])],
                by,
              },
              {
                ownership: { kind: 'conversation' },
                conversationId: api.conversationId,
                background: true,
              },
            )
          }, ctx)
          return undefined
        },
      }),
    ],
    sections: [
      section('board', async (input, ctx) => {
        if (!input.agent.tools.some((tool) => tool.name === 'message')) return undefined
        const parent = await parentOf(host, input.conversationId, ctx)
        if (parent !== undefined)
          return `Use message only to update #${parent}, the conversation that started you, while you work; your final answer reaches it anyway. One-way updates (reply: false) reach #${parent} as notes it reads with its next input; ask with reply: true when you need its answer to continue.`
        const agents = (await host.want(SubagentsApi)?.residents(ctx)) ?? []
        const primary = primaryAgent(host.projectRoot, host.userHome)
        return `Use message to contact #id or @name. Only @${primary} messages user; send it updates with reply: false to relay. Messages wake their recipient; its answer returns as a reply and wakes you. End your turn instead of waiting. A one-way message (reply: false) gets no answer; use reply: true when you need one. Inputs identify their sender; answer here and your answer is sent to the sender automatically; do not use message to reply.\n${agents.map((a) => `@${a.name} — ${a.description}`).join('\n')}`
      }),
    ],
    tools: [
      defineTool({
        name: 'branch',
        deferred: true,
        description: 'Start a lineage branch. Its answer returns to you as a board reply.',
        parameters: Type.Object({
          prompt: Type.String({ minLength: 1 }),
          root: Type.Optional(Type.Number()),
          isolated: Type.Optional(Type.Boolean()),
        }),
        // Lineage atomically deduplicates the fork; Sent deduplicates its first message.
        replay: 'safe',
        async execute(input, api, ctx) {
          let id = await api.memo<number>('branch-id', ctx)
          if (id === undefined) {
            const lineage = host.want(LineageApi)
            if (!lineage) throw new Error('Branches require lineage')
            const roots =
              (await host.harness().snapshot(Roots, ROOT_CONVERSATION_ID, ctx))?.roots ?? []
            const root =
              input.root ??
              (await lineage.rootOf(api.conversationId, ctx)) ??
              (roots.length === 1 ? roots[0] : undefined)
            if (root === undefined || !roots.includes(root))
              throw new Error(
                `Choose a root. Roots: ${roots.map((candidate) => `#${candidate}`).join(', ') || '(none)'}`,
              )
            const { definitions } = await discoverAgents(
              host.ultimateRoot,
              host.projectRoot,
              host.userHome,
              host.modelRuntime,
            )
            const coordinator = definitions.find((definition) => definition.name === 'coordinator')
            if (!coordinator) throw new Error('Missing coordinator definition')
            const branch = await lineage.branch(
              {
                from: root,
                prompt: input.prompt,
                isolated: input.isolated ?? true,
                deliver: false,
                by: api.conversationId,
                receipt: { taskId: api.taskId, callId: api.callId },
              },
              ctx,
            )
            // The fork has no input yet. Only instructions change: its model and tools stay inherited.
            await host.harness().commit(async (tx) => {
              await configure(tx, branch.id, { instructions: coordinator.instructions })
              ;(await tx.doc(host.metadata, branch.id)).label = 'coordinator'
              ;(await tx.doc(Started, branch.id)).by = api.conversationId
            }, ctx)
            id = await api.memo('branch-id', branch.id, ctx)
          }
          const message = await send(
            host,
            api.conversationId,
            { to: `#${id}`, text: input.prompt, reply: true },
            ctx,
            api.taskId,
            api.callId,
          )
          return {
            output: [{ type: 'text', text: `Branch #${id} started; message ${message} sent.` }],
          }
        },
      }),
      defineTool({
        name: 'message',
        description:
          'Send a message to #id or @name (only @ultimate may send to user). Returns immediately; the answer comes back as a reply. A busy recipient gets it after its current run, or during it with steer: true (the default for @ultimate).',
        parameters: Type.Object({
          to: Type.String(),
          text: Type.String({ minLength: 1 }),
          reply: Type.Optional(Type.Boolean()),
          steer: Type.Optional(Type.Boolean()),
        }),
        // The task-scoped receipt deduplicates admission; the memo returns the same id on replay.
        replay: 'safe',
        async execute(input, api, ctx) {
          const id =
            (await api.memo<number>('message-id', ctx)) ??
            (await api.memo(
              'message-id',
              await send(host, api.conversationId, input, ctx, api.taskId, api.callId),
              ctx,
            ))
          return { output: [{ type: 'text', text: `Message ${id} sent.` }] }
        },
      }),
    ],
  })
}
