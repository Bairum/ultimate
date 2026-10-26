import { createHash, randomUUID } from 'node:crypto'
import type { Driver, Observation } from './types.ts'
import type { FrameMeta, Teach } from './refs.ts'
import { clock, normalizeLabel, parseRegions, visibleWindow } from './perception.ts'
import type { Clock, Region } from './perception.ts'
import { ObservationUnavailable } from './tool-helpers.ts'

export const teachLimits = { frames: 150, bytes: 300 * 1024 * 1024 }
const cue =
  /\b(password|passcode|pin|secret|token|one[- ]time|otp|(?:verification|security|auth(?:entication)?|access)\s+code|mfa|2fa|passwort|kennwort|mot de passe|contraseña|senha)\b|[•*●]{4,}/i
const loginCue = /\buser\s*name\b/i
export const credentialCue = (label: string) => cue.test(label)
const signin = /\b(sign in|log in|login|submit)\b/
const near = (a: Region, b: Region) =>
  Math.max(a.bounds.x - b.bounds.x - b.bounds.width, b.bounds.x - a.bounds.x - a.bounds.width, 0) <
    160 &&
  Math.max(
    a.bounds.y - b.bounds.y - b.bounds.height,
    b.bounds.y - a.bounds.y - a.bounds.height,
    0,
  ) < 80
export function teachingOcr(regions: Region[], redact: (value: string) => string) {
  const cues = regions.filter((region) => credentialCue(region.label))
  return {
    password: cues.length > 0,
    ocr: regions
      .filter((region) => region.kind === 'text' && !cues.some((c) => near(c, region)))
      .slice(0, 200)
      .map((region) => ({
        text: redact(region.label).slice(0, 80),
        bounds: region.bounds,
        confidence: region.confidence,
      })),
  }
}

export function frameDiff(
  previous: FrameMeta['ocr'],
  current: FrameMeta['ocr'],
): FrameMeta['diff'] {
  const labels = (items: FrameMeta['ocr']) => new Set(items.map((r) => r.text))
  const before = labels(previous),
    after = labels(current)
  const appeared = [...after].filter((s) => !before.has(s))
  const disappeared = [...before].filter((s) => !after.has(s))
  const changed = [...previous, ...current].filter(
    (r) => appeared.includes(r.text) || disappeared.includes(r.text),
  )
  return {
    appeared,
    disappeared,
    ...(changed.length
      ? {
          region: [
            Math.min(...changed.map((r) => r.bounds.x)),
            Math.min(...changed.map((r) => r.bounds.y)),
            Math.max(...changed.map((r) => r.bounds.x + r.bounds.width)),
            Math.max(...changed.map((r) => r.bounds.y + r.bounds.height)),
          ] as [number, number, number, number],
        }
      : {}),
  }
}
export function infer(diff: FrameMeta['diff']) {
  const show = (labels: string[]) =>
    labels
      .slice(0, 4)
      .map((s) => `'${s}'`)
      .join(', ')
  return diff.appeared.length || diff.disappeared.length
    ? `${diff.disappeared.length ? `${show(diff.disappeared)} disappeared; ` : ''}${diff.appeared.length ? `${show(diff.appeared)} appeared` : 'the screen changed'}.`
    : 'Screen pixels changed; no OCR label change.'
}

/**
 * Observation only. No input events, focus changes, or accessibility tree collection. Each poll reads every watched
 * window in order; one not visible (another Space, minimised) is skipped while another is readable.
 */
export async function recordTeaching(options: {
  driver: Driver
  /** Capture window `index` of the segment's windows. */
  capture(index: number, maxDimension: number): Promise<Observation>
  read(): Promise<Teach>
  update(change: (doc: Teach) => void): Promise<void>
  save(png: Buffer): Promise<string>
  bytes(): Promise<number>
  stopped(): Promise<boolean>
  redact(text: string): string
  signal: AbortSignal
  pollMs?: number
  time?: Clock
}) {
  const time = options.time ?? clock
  let priorLogin: string[] = []
  const initial = (await options.read()).segment!
  const windows = Array.from({ length: initial.windows?.length ?? 1 }, () => ({
    previousHash: undefined as string | undefined,
    storedHash: undefined as string | undefined,
    held: 0,
  }))
  // A restart loses transient credential context. Skip two settled changes conservatively.
  let skip = initial.dropped.some((d) => d.reason === 'password_cue') ? 2 : 0
  let bytes = await options.bytes()
  const drop = (reason: string) =>
    options.update((doc) => {
      if (doc.segment?.status === 'recording') doc.segment.dropped.push({ reason, at: time.now() })
    })
  let unavailableReads = 0
  let unavailable = new Set<string>()
  const capture = async (index: number, dimension: number) => {
    try {
      const observation = await options.capture(index, dimension)
      // Without an AX tree, every app needs explicit visibility and usable pixels.
      const refusal = visibleWindow({ ...observation, degraded: true })
      if (refusal) throw new ObservationUnavailable(refusal.refuse, refusal.message)
      return observation
    } catch (error) {
      if (
        !(error instanceof ObservationUnavailable) ||
        !['window_not_visible', 'observation_unavailable'].includes(error.status)
      )
        throw error
      unavailable.add(error.status)
      return undefined
    }
  }
  poll: while (!options.signal.aborted) {
    const segment = (await options.read()).segment
    if (!segment || !['recording', 'paused'].includes(segment.status)) return
    if (
      time.now() >= segment.endsAt ||
      segment.frames.length >= teachLimits.frames ||
      bytes >= teachLimits.bytes ||
      (await options.stopped())
    )
      break
    if (segment.status === 'paused') {
      await time.sleep(Math.min(options.pollMs ?? 500, segment.endsAt - time.now()), options.signal)
      continue
    }
    let readable = false
    let added = 0
    unavailable = new Set()
    for (const [index, state] of windows.entries()) {
      const small = await capture(index, 800)
      if (time.now() >= segment.endsAt || options.signal.aborted) break poll
      if (!small) {
        state.previousHash = undefined
        state.held = 0
        continue
      }
      readable = true
      if (!small.image) throw new Error('Teaching requires a screenshot')
      const hash = createHash('sha256').update(small.image.data).digest('hex')
      state.held = hash === state.previousHash ? state.held + 1 : 0
      state.previousHash = hash
      if (hash === state.storedHash || state.held < 2) continue
      const full = await capture(index, 1568)
      if (!full) continue
      if (!full.capture || !full.image || full.image.mimeType !== 'image/png')
        throw new Error('Teaching requires a PNG capture')
      const { regions } = await parseRegions(
        options.driver,
        full.capture.id,
        { kinds: ['text', 'icon'] },
        options.signal,
      )
      if (options.signal.aborted || (await options.read()).segment?.status !== 'recording') return
      if (time.now() >= segment.endsAt || (await options.stopped())) break poll
      const cues = regions.filter((r) => credentialCue(r.label))
      state.storedHash = hash
      const logins = regions
        .filter((r) => signin.test(normalizeLabel(r.label)))
        .map((r) => normalizeLabel(r.label))
      const signedIn = priorLogin.some((label) => !logins.includes(label))
      const loginCues = regions.filter((r) => credentialCue(r.label) || loginCue.test(r.label))
      priorLogin = loginCues.length
        ? regions
            .filter(
              (r) => signin.test(normalizeLabel(r.label)) && loginCues.some((c) => near(c, r)),
            )
            .map((r) => normalizeLabel(r.label))
        : []
      // Do not persist cue text or neighbouring field contents, even as OCR or diff metadata.
      const { ocr } = teachingOcr(regions, (value) => options.redact(value))
      if (skip > 0) {
        skip--
        await drop('post_signin')
      } else {
        if (segment.frames.length + added >= teachLimits.frames) break poll
        const diff = frameDiff(
          segment.frames.findLast((f) => (f.window ?? 0) === index)?.ocr ?? [],
          ocr,
        )
        const frame: FrameMeta = {
          id: randomUUID(),
          at: time.now(),
          width: full.capture.width,
          height: full.capture.height,
          ...(index ? { window: index } : {}),
          ocr,
          diff,
          inferred: infer(diff),
        }
        const png = Buffer.from(full.image.data, 'base64')
        if (cues.length) await drop('password_cue')
        else if (bytes + png.length > teachLimits.bytes) break poll
        else {
          frame.file = await options.save(png)
          bytes += png.length
        }
        await options.update((doc) => {
          if (doc.segment?.status === 'recording') doc.segment.frames.push(frame)
        })
        added++
      }
      if (signedIn) skip = 2
    }
    if (readable) unavailableReads = 0
    else {
      // Only a poll with no readable window counts toward ending the segment.
      for (const reason of unavailable) await drop(reason)
      if (++unavailableReads >= 20) {
        await options.update((doc) => {
          if (doc.segment) doc.segment.endedBy = 'unavailable'
        })
        break
      }
    }
    await time.sleep(options.pollMs ?? 500, options.signal)
  }
  if (!options.signal.aborted)
    await options.update((doc) => {
      if (doc.segment && ['recording', 'paused'].includes(doc.segment.status))
        doc.segment.status = 'drafting'
    })
}
