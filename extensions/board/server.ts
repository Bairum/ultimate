import type { Context } from '@earendil-works/chord'
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  awaitWithContext,
} from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  InboxDoc,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, TaskId, Tx } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { WorkspaceService } from '../workspaces/server.ts'
import { isolatable } from '../workspaces/git.ts'

import type { SubagentsService } from '../subagents/server.ts'
import { Standing } from '../subagents/server.ts'
export type BoardMessage = {
  id: number
  from: number | 'user'
  to: number | 'user'
  text: string
  at: number
  reply: boolean
  re?: number
  kind?: string
  state: 'sent' | 'delivered' | 'answered' | 'failed'
  entry?: EntryId
  answer?: EntryId
  error?: string
}
export const Board = defineDoc<{ messages: BoardMessage[]; next: number; readUpTo: number }>({
  kind: 'board',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ messages: [], next: 1, readUpTo: 0 }),
})
export const docs = [Board]
// The receipt commits with the message, closing the gap before api.memo records its id.
const Sent = defineDoc<{ id?: number }>({
  kind: 'board.sent',
  version: 1,
  scope: 'task',
  initial: () => ({}),
})
async function append(tx: Tx, input: Omit<BoardMessage, 'id' | 'at'>) {
  const log = await tx.doc(Board, ROOT_CONVERSATION_ID)
  const message = { ...input, id: log.next++, at: Date.now() }
  log.messages.push(message)
  if (log.messages.length > 300) log.messages.splice(0, log.messages.length - 300)
  return message
}
export type BoardService = {
  record(
    tx: Tx,
    input: Pick<BoardMessage, 'from' | 'to' | 'text' | 'kind' | 'entry'>,
  ): Promise<number>
}
const Delivery = defineTask<
  { message: BoardMessage; steer: boolean },
  { phase: 'deliver' } | { phase: 'reply'; message: BoardMessage; failed: boolean },
  null
>({
  name: 'board.delivery',
  version: 1,
  initial: () => ({ phase: 'deliver' }),
  phases: {
    deliver: async (task, runtime, ctx) => {
      const m = task.input.message
      if (m.to === 'user') throw new Error('Inbox items need no delivery task')
      const recipient = await runtime.conversation(m.to as ConversationId, ctx)
      if (!recipient) throw new Error(`Unknown conversation #${m.to}`)
      const receipt = await recipient.submit(
        {
          type: 'input',
          requestId: `board:${m.id}`,
          whenBusy: task.input.steer ? 'steer' : 'followUp',
          entry: {
            kind: 'board.message',
            data: { id: m.id, from: m.from, text: m.text, reply: m.reply },
          },
          content: `Message from ${m.from === 'user' ? 'user' : `#${m.from}`}:\n${m.text}${m.reply ? '\nYour answer to this message goes back to its sender.' : ''}`,
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
          if (!m.reply)
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          return undefined
        }, ctx)
        if (!m.reply) return
      }
      const settled = await receipt.wait(ctx)
      await runtime.commit(async (tx) => {
        const answer =
          settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined
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
              content: `Reply from #${m.from} to message ${m.re}${failed ? ' (failed)' : ''}:\n${m.text}`,
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
async function lander(host: ExtensionHost, ctx: Context) {
  const service = host.use<WorkspaceService>('workspaces')
  if (!service) return undefined
  const checkout = await isolatable(host.projectRoot)
  if ('reason' in checkout) return undefined
  return (await host.harness().snapshot(service.doc, ROOT_CONVERSATION_ID, ctx))
    ?.landerConversations[checkout.source]
}
async function resolve(host: ExtensionHost, to: string, from: number | 'user', ctx: Context) {
  if (to === 'user') return to
  let id: number | undefined
  if (to === '@lander') id = await lander(host, ctx)
  else if (to.startsWith('@')) {
    const service = host.use<SubagentsService>('subagents')
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
) {
  if (taskId !== undefined) {
    const sent = await host.harness().snapshot(Sent, taskId, ctx)
    if (sent?.id !== undefined) return sent.id
  }
  if (!input.text.trim()) throw new Error('Message text must not be empty')
  const to = await resolve(host, input.to, from, ctx)
  return host.harness().commit(async (tx) => {
    const receipt = taskId === undefined ? undefined : await tx.doc(Sent, taskId)
    if (receipt?.id !== undefined) return receipt.id
    const message = await append(tx, {
      from,
      to,
      text: input.text,
      reply: input.reply ?? true,
      state: to === 'user' ? 'delivered' : 'sent',
      ...(input.re === undefined ? {} : { re: input.re }),
    })
    if (to !== 'user')
      await tx.createTask(
        Delivery,
        { message, steer: input.steer ?? false },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
    if (receipt) receipt.id = message.id
    return message.id
  }, ctx)
}
export const userActions = ['post', 'read']
export const actions = {
  async post(args: { to: string; text: string; re?: number }, { host, signal }: ActionContext) {
    return { id: await send(host, 'user', args, withAbortSignal(signal, BACKGROUND_CONTEXT)) }
  },
  async read(args: { upTo: number }, { host }: ActionContext) {
    if (!Number.isSafeInteger(args.upTo) || args.upTo < 0)
      throw new Error('upTo must be a non-negative integer')
    await host.harness().commit(async (tx) => {
      const log = await tx.doc(Board, ROOT_CONVERSATION_ID)
      log.readUpTo = Math.max(log.readUpTo, Math.min(args.upTo, log.next - 1))
    }, BACKGROUND_CONTEXT)
    return {}
  },
  async addresses(_args: unknown, { host }: ActionContext) {
    const agents =
      (await host.use<SubagentsService>('subagents')?.residents(BACKGROUND_CONTEXT)) ?? []
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
  host.provide('board', {
    record: async (tx, input) =>
      (await append(tx, { ...input, reply: false, state: 'delivered' })).id,
  } satisfies BoardService)
  return defineExtension({
    name: 'board',
    tasks: [Delivery],
    sections: [
      section('board', async (input, ctx) => {
        if (!input.agent.tools.some((tool) => tool.name === 'message')) return undefined
        const agents = (await host.use<SubagentsService>('subagents')?.residents(ctx)) ?? []
        return `Use message to contact #id, @name or user. Messages wake their recipient; its answer returns as a reply and wakes you. End your turn instead of waiting. Use reply: false for one-way updates. Inputs identify their sender; your answer to a message is delivered back to its sender.\n${agents.map((a) => `@${a.name} — ${a.description}`).join('\n')}`
      }),
    ],
    tools: [
      defineTool({
        name: 'message',
        description:
          'Send a message to #id, @name or user. Returns immediately; the answer comes back as a reply.',
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
              await send(host, api.conversationId, input, ctx, api.taskId),
              ctx,
            ))
          return { output: [{ type: 'text', text: `Message ${id} sent.` }] }
        },
      }),
    ],
  })
}
