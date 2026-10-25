/**
 * Pure transcript relay; the caller supplies the clock and ticks. GPT-Live talks with Daniel itself and hands a request
 * to Ultimate only by delegating: with confirmation on, after asking "Should I pass this to Ultimate: …?" and his yes.
 */
/** Ask "Should I pass this to Ultimate: …?" before forwarding; false forwards each clear request with "Passing that on". */
export const CONFIRM = true
export const QUIET_MS = 1200
export const IDLE_MS = 120_000
export type LiveEvent = {
  type: string
  delta?: string
  delegation?: { id: string; target?: string }
  session?: { expires_at?: number }
  usage?: { seconds: number }
  reason?: string
  [key: string]: unknown
}
/** A finished line for the Voice transcript, or a request to forward to @ultimate. */
export type RelayOut =
  | { log: { role: 'daniel' | 'live'; text: string } }
  | { forward: string; delegation?: string }

/** The request inside GPT-Live's confirmation question, as its instructions ask it to phrase it. */
const ASKS = /pass (?:this|that|it)(?: on)? to Ultimate\s*[:,-]\s*(.+?)[?.!]*\s*$/i
const YES =
  /^(?:yes|yeah|yep|yup|sure|please|go ahead|do it|pass it on|send it|ok(?:ay)?|ja|genau|correct|right)\b/i

const clean = (text: string) => text.trim().replace(/\s+/g, ' ')

export class Relay {
  private input = ''
  private inputAt?: number
  private output = ''
  private outputAt?: number
  private activityAt: number
  /** Daniel's lines since the last forward: what a delegation without a parsed question forwards. */
  private said: string[] = []
  /** The request GPT-Live last asked to pass on, until it is forwarded or Daniel moves on. */
  private asked?: string
  /** Daniel said yes to `asked`; forward it at `confirmedAt + QUIET_MS` if no delegation arrives first. */
  private confirmedAt?: number
  /** Output after `speak()` is Ultimate's answer being read out, already in the transcript. */
  private speaking = false

  constructor(
    now: number,
    /** Ask before forwarding (true), or forward whatever GPT-Live delegates. */
    private confirm = CONFIRM,
  ) {
    this.activityAt = now
  }

  /** Ultimate's answer is about to be read out: its speech is not GPT-Live's own line. */
  spoke() {
    this.speaking = true
  }

  event(event: LiveEvent, now: number): RelayOut[] {
    const out = this.tick(now)
    if (event.type === 'session.input_transcript.delta' && event.delta) {
      out.push(...this.endOutput())
      this.input += event.delta
      this.inputAt = now
      this.activityAt = now
    } else if (event.type === 'session.output_transcript.delta' && event.delta) {
      out.push(...this.endInput())
      this.output += event.delta
      this.outputAt = now
      this.activityAt = now
    } else if (event.type === 'session.delegation.created' && event.delegation?.target === 'client')
      out.push(...this.endInput(), ...this.forward(event.delegation.id))
    return out
  }

  tick(now: number): RelayOut[] {
    const out: RelayOut[] = []
    if (this.inputAt !== undefined && now - this.inputAt >= QUIET_MS) out.push(...this.endInput())
    if (this.outputAt !== undefined && now - this.outputAt >= QUIET_MS)
      out.push(...this.endOutput())
    // A confirmed request GPT-Live failed to delegate still goes: nothing unconfirmed ever does.
    if (this.confirmedAt !== undefined && now - this.confirmedAt >= QUIET_MS)
      out.push(...this.forward())
    return out
  }

  idleFor(now: number): number {
    return Math.max(0, now - this.activityAt)
  }

  private endInput(): RelayOut[] {
    const text = clean(this.input)
    this.input = ''
    if (this.inputAt === undefined || !text) return []
    const at = this.inputAt
    this.inputAt = undefined
    this.speaking = false
    if (this.asked !== undefined && YES.test(text)) this.confirmedAt = at
    else {
      this.said.push(text)
      // Anything but a yes after the question leaves it to GPT-Live to ask again.
      this.asked = undefined
      this.confirmedAt = undefined
    }
    return [{ log: { role: 'daniel', text } }]
  }

  private endOutput(): RelayOut[] {
    const text = clean(this.output)
    this.output = ''
    if (this.outputAt === undefined || !text) return []
    this.outputAt = undefined
    if (this.speaking) return []
    const asked = ASKS.exec(text)?.[1]
    if (asked) this.asked = clean(asked)
    return [{ log: { role: 'live', text } }]
  }

  private forward(delegation?: string): RelayOut[] {
    const text = this.asked ?? (this.confirm ? undefined : this.said.join(' '))
    this.asked = undefined
    this.confirmedAt = undefined
    if (!text) return []
    this.said = []
    return [{ forward: text, ...(delegation ? { delegation } : {}) }]
  }
}
