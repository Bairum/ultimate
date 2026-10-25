/** Pure transcript joiner; the caller supplies the clock and ticks. All finished input goes to Voice. */
/** Quiet after a line that ends a sentence. */
export const QUIET_MS = 1200
/** Quiet after a line that trails off mid-sentence ("…a coordinator that doesn't"): a breath, not the end. */
export const TRAILING_MS = 2800
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
/** GPT-Live's transcriber marks words it missed as `[unintelligible]` or `[inaudible]`: a gap, not words. */
const heard = (text: string) =>
  clean(text.replace(/\[(?:unintelligible|inaudible|indistinct)[^\]]*\]/gi, '…'))
    .replace(/(?:\s*(?:…|\.{2,}))+/g, ' …')
    .replace(/^[\s.…]+$/, '')
    .trim()
const finished = (text: string) => /[.?!。？！]["')\]]*$/.test(text.trim())

export class Relay {
  private input = ''
  private inputAt?: number
  private output = ''
  private outputAt?: number
  private activityAt: number
  private speaking = false
  /** What GPT-Live has said aloud of the commentary it is speaking now. */
  private said = ''

  constructor(now: number) {
    this.activityAt = now
  }

  /** Commentary is already logged by Voice's say tool; do not log it a second time. */
  spoke() {
    this.speaking = true
    this.said = ''
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
      if (this.speaking) this.said += event.delta
      else this.output += event.delta
      this.outputAt = now
      this.activityAt = now
    }
    // GPT-Live's delegation events have no meaning: Voice makes all handoff decisions.
    return out
  }

  tick(now: number): RelayOut[] {
    const out: RelayOut[] = []
    const quiet = finished(this.input) ? QUIET_MS : TRAILING_MS
    if (this.inputAt !== undefined && now - this.inputAt >= quiet) {
      const text = heard(this.input)
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

  /** The words of the line the user is saying now, before it is finished; empty when none. */
  partial(): string {
    return this.inputAt === undefined ? '' : heard(this.input)
  }

  /** Words of the current commentary spoken so far: how far its line has been read out. */
  spokenWords(): number {
    return this.said.split(/\s+/).filter(Boolean).length
  }

  /** The user is mid-sentence: words came in that are not a finished line yet. */
  hearing(): boolean {
    return this.inputAt !== undefined
  }

  /** GPT-Live is talking: its words, spoken commentary included, came in the last quiet window. */
  talking(): boolean {
    return this.outputAt !== undefined
  }

  idleFor(now: number): number {
    return Math.max(0, now - this.activityAt)
  }
}
