import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { StateDoc } from './refs.ts'
import type { CodexState } from './refs.ts'

const initial = (): CodexState => ({ acknowledged: false, grants: [], pending: [] })
export const State = defineDoc<CodexState>({
  kind: StateDoc.kind,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial,
})
export async function readState(host: ExtensionHost, conversation: number): Promise<CodexState> {
  return (
    (await host.harness().snapshot(State, conversation as ConversationId, context)) ?? initial()
  )
}
export async function updateState(
  host: ExtensionHost,
  conversation: number,
  change: (state: CodexState) => void,
) {
  await host
    .harness()
    .commit(async (tx) => change(await tx.doc(State, conversation as ConversationId)), context)
}
export const sameApp = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Atomically consume a once grant so two elicitations cannot use it. Local denies override project consent. */
export async function consent(host: ExtensionHost, conversation: number, app: string) {
  let decision: 'accept' | 'decline' | undefined
  await host.harness().commit(async (tx) => {
    const local = await tx.doc(State, conversation as ConversationId)
    const project = await tx.doc(State, 1 as ConversationId)
    const localGrant = local.grants.findLast((g) => sameApp(g.app, app) && g.scope !== 'project')
    const projectGrant = project.grants.findLast(
      (g) => sameApp(g.app, app) && g.scope === 'project',
    )
    const grant = localGrant ?? projectGrant
    if (!grant) return
    decision = grant.scope === 'deny' ? 'decline' : 'accept'
    if (grant.scope === 'once')
      local.grants = local.grants.filter((g) => !sameApp(g.app, app) || g.scope !== 'once')
  }, context)
  return decision
}
export async function wake(
  host: ExtensionHost,
  conversation: number,
  text: string,
  requestId: string,
) {
  const target = await host.harness().conversation(conversation as ConversationId, context)
  if (!target) throw new Error('Conversation not found; Continue remains pending')
  await target.submit(
    { type: 'input', content: text, requestId, entry: { kind: 'codex-computer.wake' } },
    context,
  )
}

export function validate<T>(
  args: T,
  app = false,
): asserts args is T &
  Exclude<T, string | number | boolean | unknown[] | null> & { conversation: number; app: string } {
  if (
    !args ||
    typeof args !== 'object' ||
    !('conversation' in args) ||
    !Number.isSafeInteger(args.conversation) ||
    (args.conversation as number) < 1
  )
    throw new Error('conversation must be a positive integer')
  if (app && (!('app' in args) || typeof args.app !== 'string' || !args.app.trim()))
    throw new Error('app must be nonempty')
}

/** Screen strings are data, never instructions; escaping prevents closing the boundary from screen text. */
export function untrusted(text: string) {
  return `<untrusted_screen_content>\n${text.replace(/<\/untrusted_screen_content>/gi, '&lt;/untrusted_screen_content&gt;')}\n</untrusted_screen_content>`
}
