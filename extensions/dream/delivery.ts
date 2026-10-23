import { defineTask } from '@earendil-works/pi-durable'
import type { ConversationId, JsonObject, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

type Delivery = {
  to: number
  type: 'input' | 'write'
  session: number
  kind: 'dream.started' | 'dream.journal' | 'dream.chapter'
  data?: JsonObject
  content: string
}

/** Deliveries are created with their source state; submission request ids make retries harmless. */
export const deliverTask = (host: Pick<ExtensionHost, 'harness'>) =>
  defineTask<Delivery, { phase: 'submit' }, null>({
    name: 'dream.deliver',
    version: 1,
    initial: () => ({ phase: 'submit' }),
    phases: {
      submit: async (task, runtime, ctx) => {
        const { to, type, session, kind, content } = task.input
        const requestId = `${kind}:${session}`
        const data = task.input.data ?? { session }
        // The host handle, unlike the task runtime's, admits passive writes.
        const target = (await host.harness().conversation(to as ConversationId, ctx))!
        if (type === 'input')
          await target.submit(
            { type: 'input', requestId, content, entry: { kind, data }, whenBusy: 'followUp' },
            ctx,
          )
        else
          await target.submit(
            {
              type: 'write',
              requestId,
              entry: { kind, data, model: [{ role: 'user', content, timestamp: Date.now() }] },
            },
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

export const deliver = (
  host: Pick<ExtensionHost, 'harness'>,
  tx: Tx,
  to: number,
  delivery: Omit<Delivery, 'to'>,
) =>
  tx.createTask(
    deliverTask(host),
    { to, ...delivery },
    { conversationId: to as ConversationId, ownership: { kind: 'conversation' }, background: true },
  )
