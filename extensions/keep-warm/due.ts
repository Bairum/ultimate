/** When a keep-warm ping is due. Browser-safe: the chip reads the hour too. */

/** Claude's long prompt cache lives an hour from the last request that read or wrote it. */
export const TTL = 60 * 60_000
/** Ping this long after the last request: late enough to be rare, early enough to land before the hour ends. */
export const LEAD = 55 * 60_000
/** No ping once the user has been away this long. */
export const IDLE_STOP = 8 * 60 * 60_000
/**
 * No ping for a smaller cached context: a miss there costs little more than the ping's own read, and short contexts
 * (a fresh branch, a short @ultimate session) would add pings for nothing.
 */
export const MIN_TOKENS = 50_000

export type Target = {
  provider: string
  standing: boolean
  definition?: string
  running: boolean
  child: boolean
  submission: boolean
}

/** A ping failed and no request renewed the cache since: a newer cached answer supersedes the failure. */
export const failing = (failedAt: number | undefined, lastRequest: number | undefined) =>
  failedAt !== undefined && (lastRequest === undefined || failedAt >= lastRequest)

/** Only @ultimate or an idle coordinator waiting for delegated work. */
export const eligible = (target: Target) =>
  ['claude-code', 'anthropic'].includes(target.provider) &&
  !target.running &&
  (target.standing || (target.definition === 'coordinator' && (target.child || target.submission)))

export type Activity = Target & {
  now: number
  lastRequest?: number
  /** The context the cache holds: input plus cache tokens of the request that renewed it. */
  tokens?: number
  /** Latest user input to @ultimate, shared by all targets. */
  inputAt?: number
  failedAfter?: number
  /** Every attempt counts, even on another model or after a crash. */
  pingAt?: number
  paused?: boolean
}

/** Renew once near the end of each cache window; never rebuild or retry a failed ping. */
export function due(activity: Activity) {
  const { now, lastRequest, inputAt, failedAfter, pingAt, paused, tokens } = activity
  if (!eligible(activity) || paused) return false
  if (lastRequest === undefined || inputAt === undefined) return false
  if (tokens === undefined || tokens < MIN_TOKENS) return false
  if (failing(failedAfter, lastRequest)) return false
  if (pingAt !== undefined && now - pingAt < LEAD) return false
  const age = now - lastRequest
  return age >= LEAD && age < TTL && now - inputAt < IDLE_STOP
}
