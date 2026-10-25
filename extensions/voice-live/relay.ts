/** Pure transcript joiner; the caller supplies the clock and ticks. All finished input goes to Voice. */
export const QUIET_MS = 1200
export const IDLE_MS = 120_000
export type LiveEvent = {
  type: string
  delta?: string
  session?: { expires_at?: number }
  usage?: { seconds: number }
  reason?: string
  [key: string]: unknown
}
export type RelayOut = { heard: string } | { log: { role: 'live'; text: string } }
const clean = (text: string) => text.trim().replace(/\s+/g, ' ')

export class Relay {
  private input = ''
  private inputAt?: number
  private output = ''
  private outputAt?: number
  private activityAt: number
  private speaking = false

  constructor(now: number) {
    this.activityAt = now
  }

  /** Commentary is already logged by Voice's say tool; do not log it a second time. */
  spoke() {
    this.speaking = true
    this.output = ''
    this.outputAt = undefined
  }

  event(event: LiveEvent, now: number): RelayOut[] {
    const out = this.tick(now)
    if (event.type === 'session.input_transcript.delta' && event.delta) {
      this.input += event.delta
      this.inputAt = now
      this.activityAt = now
    } else if (event.type === 'session.output_transcript.delta' && event.delta) {
      if (!this.speaking) this.output += event.delta
      this.outputAt = now
      this.activityAt = now
    }
    // GPT-Live's delegation events have no meaning: Voice makes all handoff decisions.
    return out
  }

  tick(now: number): RelayOut[] {
    const out: RelayOut[] = []
    if (this.inputAt !== undefined && now - this.inputAt >= QUIET_MS) {
      const text = clean(this.input)
      this.input = ''
      this.inputAt = undefined
      this.speaking = false
      if (text) out.push({ heard: text })
    }
    if (this.outputAt !== undefined && now - this.outputAt >= QUIET_MS) {
      const text = clean(this.output)
      this.output = ''
      this.outputAt = undefined
      if (text) out.push({ log: { role: 'live', text } })
    }
    return out
  }

  idleFor(now: number): number {
    return Math.max(0, now - this.activityAt)
  }
}
