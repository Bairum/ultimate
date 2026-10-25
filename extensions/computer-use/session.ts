import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { SessionDoc } from './refs.ts'
import type { Session } from './refs.ts'
export type { Session } from './refs.ts'

export const initialSession = (): Session => ({
  grants: [],
  confirmed: [],
  pending: [],
  journal: [],
  stopped: false,
  lastObservedAt: 0,
  takeovers: [],
  budget: { steps: 0, startedAt: 0 },
})
export const ComputerSession = defineDoc<Session>({
  kind: SessionDoc.kind,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  // Forks get fresh authority, tokens and budgets, not the parent's in-flight desktop actions.
  // Project grants remain available through conversation 1; conversation grants never silently spread.
  // Task intent and evidence belong to this operator too: a fork must start its own grounded task.
  fork: 'initial',
  checkpointWhen: () => false,
  initial: initialSession,
})
type Host = Pick<ExtensionHost, 'harness'>
export async function readSession(host: Host, conversation: number): Promise<Session> {
  return (
    (await host.harness().snapshot(ComputerSession, conversation as ConversationId, context)) ??
    initialSession()
  )
}
export async function updateSession(
  host: Host,
  conversation: number,
  change: (session: Session) => void,
) {
  await host.harness().commit(async (tx) => {
    const session = await tx.doc(ComputerSession, conversation as ConversationId)
    change(session)
    session.journal = session.journal.slice(-200)
  }, context)
}
export async function wake(host: Host, conversation: number, text: string) {
  const target = await host.harness().conversation(conversation as ConversationId, context)
  await target?.submit({ type: 'input', content: text, entry: { kind: 'computer.wake' } }, context)
}

export async function isStopped(
  host: Host,
  conversation: number,
  options: {
    session?: Session
    active?: { stopped: boolean }
    signal?: AbortSignal
  } = {},
) {
  if (options.active?.stopped || options.signal?.aborted) return true
  const session = options.session ?? (await readSession(host, conversation))
  return session.stopped || (conversation !== 1 && (await readSession(host, 1)).stopped)
}

export function hasConfirmation(session: Session, key: string, now = Date.now()) {
  return (
    !!session.task &&
    session.confirmed.some(
      (c) =>
        c.key === key && c.task === session.task!.spec.id && c.at <= now && now - c.at < 5 * 60_000,
    )
  )
}
