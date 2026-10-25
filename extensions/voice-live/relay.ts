/**
 * Pure transcript relay; the caller supplies the clock and ticks. GPT-Live talks with Daniel itself and hands a request
 * to Ultimate by delegating. The relay, not GPT-Live's words, decides what is passed on: a delegation forwards the
 * exchange since the last forward, and so does GPT-Live announcing a handoff it then fails to delegate.
 */
export const QUIET_MS = 1200
/** How long a spoken "passing that on" waits for its delegation before the relay forwards on its own. */
export const HANDOFF_MS = 2500
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
/** A finished line for the Voice transcript, a request to forward to @ultimate, or a handoff with nothing to send. */
export type RelayOut =
  | { log: { role: 'daniel' | 'live'; text: string } }
  | { forward: string; delegation?: string }
  | { notSent: string }

/** GPT-Live saying it hands over: "passing that on", "asking Ultimate now", "I'll send that to Ultimate". */
const HANDOFF =
  /\b(?:pass(?:ing)?|send(?:ing)?|forward(?:ing)?|hand(?:ing)?)\b.{0,20}\b(?:on|along|over|to ultimate)\b|\bask(?:ing)? ultimate\b/i

const clean = (text: string) => text.trim().replace(/\s+/g, ' ')

export class Relay {
  private input = ''
  private inputAt?: number
  private output = ''
  private outputAt?: number
  private activityAt: number
  /** The open exchange: what Daniel said, and GPT-Live's clarifying questions, since the last forward or answer. */
  private exchange: { role: 'daniel' | 'live'; text: string }[] = []
  /** GPT-Live announced a handoff at this time and no delegation has arrived yet. */
  private announcedAt?: number
  /** The relay forwarded an announced handoff itself: GPT-Live's late delegation for it is no new request. */
  private late = false
  /** Output after `speak()` is Ultimate's answer being read out, already in the transcript. */
  private speaking = false

  constructor(now: number) {
    this.activityAt = now
  }

  /** Ultimate's answer is about to be read out: its speech is not GPT-Live's own line. */
  spoke() {
    this.speaking = true
  }

  event(event: LiveEvent, now: number): RelayOut[] {
    const out = this.tick(now)
    if (event.type === 'session.input_transcript.delta' && event.delta) {
      out.push(...this.endOutput(now))
      this.input += event.delta
      this.inputAt = now
      this.activityAt = now
    } else if (event.type === 'session.output_transcript.delta' && event.delta) {
      out.push(...this.endInput())
      this.output += event.delta
      this.outputAt = now
      this.activityAt = now
    } else if (
      event.type === 'session.delegation.created' &&
      event.delegation?.target === 'client'
    ) {
      out.push(...this.endInput())
      if (this.late && !this.exchange.some((line) => line.role === 'daniel')) this.late = false
      else out.push(...this.forward(event.delegation.id))
    }
    return out
  }

  tick(now: number): RelayOut[] {
    const out: RelayOut[] = []
    if (this.inputAt !== undefined && now - this.inputAt >= QUIET_MS) out.push(...this.endInput())
    if (this.outputAt !== undefined && now - this.outputAt >= QUIET_MS)
      out.push(...this.endOutput(now))
    // GPT-Live said it passed it on but never delegated: the relay passes it on itself.
    if (this.announcedAt !== undefined && now - this.announcedAt >= HANDOFF_MS) {
      out.push(...this.forward())
      this.late = true
    }
    return out
  }

  idleFor(now: number): number {
    return Math.max(0, now - this.activityAt)
  }

  private endInput(): RelayOut[] {
    const text = clean(this.input)
    this.input = ''
    if (this.inputAt === undefined || !text) return []
    this.inputAt = undefined
    this.speaking = false
    this.late = false
    this.exchange.push({ role: 'daniel', text })
    return [{ log: { role: 'daniel', text } }]
  }

  private endOutput(now: number): RelayOut[] {
    const text = clean(this.output)
    this.output = ''
    if (this.outputAt === undefined || !text) return []
    this.outputAt = undefined
    if (this.speaking) return []
    if (HANDOFF.test(text)) this.announcedAt ??= now
    // A question keeps the exchange open; any other reply (small talk answered) closes it.
    else if (text.endsWith('?')) this.exchange.push({ role: 'live', text })
    else this.exchange = []
    return [{ log: { role: 'live', text } }]
  }

  private forward(delegation?: string): RelayOut[] {
    this.announcedAt = undefined
    const lines = this.exchange.slice(-8)
    this.exchange = []
    if (!lines.some((line) => line.role === 'daniel'))
      return [{ notSent: 'There was no request to pass on.' }]
    const text =
      lines.length === 1
        ? lines[0].text
        : lines.map((l) => `${l.role === 'daniel' ? 'Daniel' : 'Voice'}: ${l.text}`).join('\n')
    return [{ forward: text, ...(delegation ? { delegation } : {}) }]
  }
}
