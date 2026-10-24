/** Which dream session the status line keeps in view, and where it stands. Browser-safe and pure. */
import type { Session } from './refs.ts'

/**
 * The session the status line keeps in view: the open one, or the newest once every proposal settled while its Fall
 * asleep is still to come (a granted sleep under way included). A session the user ended early, or one a compaction's
 * dream settled to stay, is done.
 */
export function pinnedOf(sessions: readonly Session[] = []): Session | undefined {
  const open = sessions.find((item) => item.endedAt === undefined)
  if (open) return open
  const newest = sessions.at(-1)
  if (!newest?.journal || newest.sleep?.phase === 'asleep') return undefined
  if (newest.proposals.some((item) => item.status === 'open' || item.status === 'approved'))
    return undefined
  if (newest.beforeCompaction?.outcome?.result === 'stay') return undefined
  return newest
}

const settled = (session: Session) =>
  session.proposals.filter((item) => item.status !== 'open' && item.status !== 'approved').length

/** Where the session stands, in a few words: dreaming, deciding, waiting on branches, or ready to fall asleep. */
export function progress(session: Session): { long: string; short?: string; moons?: true } {
  if (session.sleep)
    return { long: session.sleep.phase === 'failed' ? 'falling asleep failed' : 'falling asleep' }
  if (!session.journal) return { long: 'dreaming', moons: true }
  const total = session.proposals.length
  const done = settled(session)
  if (session.endedAt !== undefined || done === total) return { long: 'ready to fall asleep' }
  const open = session.proposals.filter((item) => item.status === 'open').length
  const approved = total - done - open
  const rest = [open > 0 && `${open} to decide`, approved > 0 && `${approved} on branches`]
  return {
    long: [`${done} of ${total} settled`, ...rest].filter(Boolean).join(' · '),
    short: `${done}/${total}`,
  }
}
