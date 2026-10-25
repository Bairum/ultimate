/** Pure transcript/quiet-time relay; the caller supplies the clock and ticks. */
export const QUIET_MS = 1200
export const IDLE_MS = 120_000
export type RelaySay = { say: string; delegation?: string }
export type LiveEvent = {
  type: string
  delta?: string
  delegation?: { id: string; target?: string }
  session?: { expires_at?: number }
  usage?: { seconds: number }
  reason?: string
  [key: string]: unknown
}

export class Relay {
  private fragments = ''
  private delegation?: string
  private inputAt?: number
  private activityAt: number
  private emitted = new Set<string>()

  constructor(now: number) {
    this.activityAt = now
  }

  /** No echo filtering: an interruption is still Daniel's speech. */
  event(event: LiveEvent, now: number): RelaySay[] {
    // Flush the previous utterance before accepting a fragment after a quiet gap.
    const ready = event.type === 'session.input_transcript.delta' ? this.tick(now) : []
    if (event.type === 'session.input_transcript.delta' && event.delta) {
      this.fragments += event.delta
      this.inputAt = now
      this.activityAt = now
    } else if (event.type === 'session.output_transcript.delta' && event.delta) {
      this.activityAt = now
    } else if (
      event.type === 'session.delegation.created' &&
      event.delegation?.target === 'client' &&
      this.fragments
    ) {
      this.delegation = event.delegation.id
    }
    return ready
  }

  tick(now: number): RelaySay[] {
    if (this.inputAt === undefined || now - this.inputAt < QUIET_MS) return []
    const text = this.fragments.trim().replace(/\s+/g, ' ')
    const delegation = this.delegation
    this.fragments = ''
    this.delegation = undefined
    this.inputAt = undefined
    if (!text || this.emitted.has(text) || (!delegation && text.split(' ').length < 3)) return []
    this.emitted.add(text)
    return [{ say: text, ...(delegation ? { delegation } : {}) }]
  }

  idleFor(now: number): number {
    return Math.max(0, now - this.activityAt)
  }
}
