/** When a keep-warm ping is due. Browser-safe: the chip reads the hour too. */
export const TTL = 60 * 60_000
export const LEAD = 55 * 60_000
export const IDLE_STOP = 8 * 60 * 60_000

export type Target = {
  provider: string
  standing: boolean
  definition?: string
  running: boolean
  child: boolean
  submission: boolean
}

/** Only @ultimate or an idle coordinator waiting for delegated work. */
export const eligible = (target: Target) =>
  ['claude-code', 'anthropic'].includes(target.provider) &&
  !target.running &&
  (target.standing || (target.definition === 'coordinator' && (target.child || target.submission)))

export type Activity = Target & {
  now: number
  lastRequest?: number
  /** Latest user input to @ultimate, shared by all targets. */
  inputAt?: number
  failedAfter?: number
  /** Every attempt counts, even on another model or after a crash. */
  pingAt?: number
  paused?: boolean
}

/** Renew once near the end of each cache window; never rebuild or retry a failed ping. */
export function due(activity: Activity) {
  const { now, lastRequest, inputAt, failedAfter, pingAt, paused } = activity
  if (!eligible(activity) || paused) return false
  if (lastRequest === undefined || inputAt === undefined) return false
  if (failedAfter !== undefined && failedAfter >= lastRequest) return false
  if (pingAt !== undefined && now - pingAt < LEAD) return false
  const age = now - lastRequest
  return age >= LEAD && age < TTL && now - inputAt < IDLE_STOP
}
