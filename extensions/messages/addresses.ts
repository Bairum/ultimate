/** Who a message is from and to: resolving addresses, naming senders, and a subagent's parent. */
import type { Context } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, Subagents, SubagentsApi } from '../subagents/api.ts'
import type { Remote } from './refs.ts'
import { Started } from './api.ts'
import { ConversationsApi } from '../conversations/api.ts'

/** The conversation that started branch `id`, which hears its final answers; undefined for anything else. */
export async function starterOf(host: ExtensionHost, id: number | 'user', ctx: Context) {
  if (typeof id !== 'number') return undefined
  return (await host.harness().snapshot(Started, id as ConversationId, ctx))?.by
}
/**
 * Inside `tx`, for the starter `to` reading branch `from`'s reply or report: whose request the branch serves, and that
 * concluding it sends the starter's final answer there. Empty for anything else.
 */
export async function servesLine(
  tx: Tx,
  from: number | 'user' | 'remote',
  to: number | 'user' | 'remote',
) {
  if (typeof from !== 'number') return ''
  const { by, serves } = await tx.doc(Started, from as ConversationId)
  if (!serves || by !== to) return ''
  const asker = serves.from === 'remote' ? remoteLabel(serves.remote!) : `#${serves.from}`
  return `\n#${from} works on ${asker}'s message ${serves.message}. Once #${from} is concluded, your final answer to it goes to ${asker} instead.`
}
/**
 * Inside `tx`, for @ultimate reading a reply or report of a branch it started that is not concluded: that `board.route`
 * sends its final answer back down to the branch, not to the user. Empty for anything else. Bridgestone #387494: twice
 * a receipt meant for the user, written as the final answer to a branch's reply (388574, 388844), reached only the
 * branch, while the one-way report text even said the answer was not sent to it.
 */
export async function routeLine(
  host: ExtensionHost,
  tx: Tx,
  from: number | 'user' | 'remote',
  to: number | 'user' | 'remote',
) {
  if (typeof from !== 'number' || typeof to !== 'number') return ''
  if ((await tx.doc(Started, from as ConversationId)).by !== to) return ''
  if ((await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate !== to) return ''
  if ((await host.need(ConversationsApi).concludedIn(tx)).has(from as ConversationId)) return ''
  return `If this run answers only branches' messages, your final answer goes back to #${from} (unless you message #${from} in this run). For the user, use message {to: 'user'}.`
}
/** Both lines for the starter `to` reading branch `from`'s reply, decided with the reply and kept in its checkpoint. */
export async function replyLines(
  host: ExtensionHost,
  tx: Tx,
  from: number | 'user' | 'remote',
  to: number | 'user' | 'remote',
) {
  const routing = await routeLine(host, tx, from, to)
  return (await servesLine(tx, from, to)) + (routing && `\n${routing}`)
}
/** The conversation that started `id` as a subagent, which is the only one it may message. */
export async function parentOf(host: ExtensionHost, id: number, ctx: Context) {
  const owner = (await host.harness().commit((tx) => tx.conversation(id as ConversationId), ctx))
    ?.owner?.conversationId
  if (owner === undefined) return undefined
  return (await host.harness().snapshot(Subagents, owner, ctx))?.agents[String(id)]
    ? owner
    : undefined
}
export async function senderName(host: ExtensionHost, id: number | 'user', ctx: Context) {
  if (id === 'user') return 'user'
  if (typeof id !== 'number') return 'another Ultimate'
  const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  const name = Object.keys(index ?? {}).find((candidate) => index?.[candidate] === id)
  return `#${id}${name ? ` (@${name})` : ''}`
}
export async function resolve(
  host: ExtensionHost,
  to: string,
  from: number | 'user',
  ctx: Context,
) {
  if (to === 'user') return to
  let id: number | undefined
  if (to.startsWith('@')) {
    const service = host.need(SubagentsApi)
    const valid = await service.residents(ctx)
    if (!valid.some((item) => `@${item.name}` === to))
      throw new Error(
        `Unknown address ${to}. Valid standing agents: ${valid.map((item) => `@${item.name}`).join(', ') || '(none)'}`,
      )
    id = await service.standing(to.slice(1), ctx)
  } else if (/^#?\d+$/.test(to)) id = Number(to.replace('#', ''))
  if (id === undefined) throw new Error(`No recipient for ${to}`)
  if (id === from) throw new Error('You cannot message yourself')
  await host.harness().commit(async (tx) => {
    if (!(await tx.conversation(id as ConversationId)))
      throw new Error(`Unknown conversation #${id}`)
    const roots = host.doc('lineage.roots')
    const tally = host.doc('lineage.tally')
    if (roots && tally) {
      const index = (await tx.doc(roots, ROOT_CONVERSATION_ID)) as {
        roots?: number[]
      }
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
/** How another project's Ultimate is named, as data.tsx names it in the browser. */
export const remoteLabel = (remote: Pick<Remote, 'project' | 'machine'>) =>
  `@ultimate@${remote.project} on ${remote.machine}`
