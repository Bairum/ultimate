import { createHash } from 'node:crypto'
import type { Driver, Observation } from './types.ts'
import { ObservationUnavailable } from './tool-helpers.ts'

export type Region = {
  id: string
  kind: 'text' | 'icon'
  label: string
  confidence: number
  bounds: { x: number; y: number; width: number; height: number }
  interactive: boolean
}
export type ParseOptions = {
  kinds?: ('text' | 'icon')[]
  min_confidence?: number
  max_regions?: number
}
export const pixelDefaults = {
  requireLabel: true,
  labelRadius: 12,
  minConfidence: 0.5,
  settleMs: 3000,
  maxWaitSeconds: 120,
  foregroundForDegraded: 'takeover' as 'takeover' | 'background',
  clipboard: false,
  fileTransfer: false,
}
export type PixelSettings = typeof pixelDefaults

/** Driver 0.37 + cua-perception 0.2.1: bounds are screenshot pixels, not AX points. */
export async function parseRegions(
  driver: Driver,
  captureId: string,
  options: ParseOptions = {},
  signal?: AbortSignal,
) {
  const reply = await driver.call(
    'parse_visual_regions',
    { capture_id: captureId, options },
    signal,
  )
  if (
    !reply.ok ||
    reply.structured?.schema !== 'cua.visual_regions_v1' ||
    !Array.isArray(reply.structured.regions)
  )
    throw new ObservationUnavailable('perception_unavailable', 'Could not parse this capture.')
  const regions: Region[] = reply.structured.regions.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid visual region')
    const b = value.bounds
    if (
      !b ||
      typeof b !== 'object' ||
      Array.isArray(b) ||
      !['x', 'y', 'width', 'height'].every(
        (k) => typeof b[k] === 'number' && Number.isFinite(b[k]),
      ) ||
      Number(b.width) <= 0 ||
      Number(b.height) <= 0 ||
      typeof value.id !== 'string' ||
      (value.kind !== 'text' && value.kind !== 'icon') ||
      typeof value.confidence !== 'number' ||
      !Number.isFinite(value.confidence) ||
      typeof value.interactive !== 'boolean' ||
      (value.kind === 'text' && typeof value.text !== 'string')
    )
      throw new Error('Invalid visual region')
    return {
      id: value.id,
      kind: value.kind,
      label: typeof value.text === 'string' ? value.text : '',
      confidence: value.confidence,
      bounds: { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) },
      interactive: value.interactive,
    }
  })
  const capture = reply.structured.capture
  const metadata =
    capture && typeof capture === 'object' && !Array.isArray(capture) ? capture : undefined
  return {
    regions,
    coordinateSpace:
      metadata?.capture_id === captureId ? metadata.action_coordinate_space : undefined,
  }
}
/**
 * The screenshot pixel a pixel action names, once the capture's Driver metadata is usable. Click x/y and OCR regions
 * are both screenshot pixels of the capture (the Driver maps them to the window itself), so the point is compared as
 * given: inverting `action_coordinate_space` here put every click on a scaled capture (Citrix: 1920-point window,
 * 1568-pixel capture) on the wrong label.
 */
export function screenshotPoint(space: unknown, point: { x: number; y: number }) {
  if (!space || typeof space !== 'object' || Array.isArray(space)) return undefined
  const s = space as Record<string, unknown>
  if (s.kind === 'screenshot_pixels') return point
  if (
    s.kind !== 'affine' ||
    !['m11', 'm12', 'm21', 'm22', 'tx', 'ty'].every(
      (k) => typeof s[k] === 'number' && Number.isFinite(s[k]),
    )
  )
    return undefined
  const { m11, m12, m21, m22 } = s as Record<string, number>
  // The live Driver reports axis-aligned affine maps; unmeasured rotations/shears are no hit.
  if (!m11 || !m22 || m12 !== 0 || m21 !== 0) return undefined
  return point
}
export const normalizeLabel = (label: string) =>
  label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200e\u200f\u2066-\u2069]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
/** Whole normalized token sequences, negated or not: what absence checks (`disappears`, wait `gone`) must use. */
export function presentLabel(text: string, label: string) {
  const expected = normalizeLabel(label)
  return Boolean(expected) && ` ${normalizeLabel(text)} `.includes(` ${expected} `)
}
/** Tokens that turn "Installed" into its opposite; a partial heuristic, documented in the README. */
const negations = ['not', 'failed', 'failure', 'isn', 'aren', 'wasn', 'didn', 'cannot', 'unable']
/**
 * A positive match (expect_label, `appears`, wait `text`): the label's tokens, in a region that does not also negate
 * it. Absence checks use `presentLabel`, so a negated region still counts as the label being on screen.
 */
export function containsLabel(text: string, label: string) {
  const expected = normalizeLabel(label).split(' ')
  return (
    presentLabel(text, label) &&
    !normalizeLabel(text)
      .split(' ')
      .some((token) => negations.includes(token) && !expected.includes(token))
  )
}
/** Edit distance, for OCR-garbled words. */
function edits(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}
/**
 * One OCR word standing for one expected word: equal, or with the same first letter and at most a quarter of the
 * longer one's letters off. The first letter keeps a negating prefix ("Uninstalled" for "installed") from passing.
 */
const closeWord = (seen: string, wanted: string) =>
  seen === wanted ||
  (Math.min(seen.length, wanted.length) >= 3 &&
    seen[0] === wanted[0] &&
    edits(seen, wanted) <= Math.floor(Math.max(seen.length, wanted.length) / 4))
/**
 * `containsLabel`, or OCR's garbled or cut-off reading of it: the region's words (two letters or more) stand, in
 * order, for words of the label starting with its first, at most a quarter of each word's letters off, with four
 * letters at least ("Decibe ." for "Describe your problem or question"). A region that negates the label never
 * matches. Only for checking a pixel click's target, never for verifying a criterion; it also passes "Sent" for
 * "Send", so a click whose only match is fuzzy needs the user's confirmation (`matchLabel`'s `fuzzy`).
 */
export function fuzzyLabel(text: string, label: string) {
  if (containsLabel(text, label)) return true
  const wanted = normalizeLabel(label).split(' ').filter(Boolean)
  const seen = normalizeLabel(text)
    .split(' ')
    .filter((word) => word.length >= 2)
  if (!wanted.length || !seen.length || seen.join('').length < 4) return false
  if (seen.some((word) => negations.includes(word) && !wanted.includes(word))) return false
  if (!closeWord(seen[0], wanted[0])) return false
  let next = 0
  for (const word of seen) {
    while (next < wanted.length && !closeWord(word, wanted[next])) next++
    if (next === wanted.length) return false
    next++
  }
  return true
}
const distance = (r: Region, p: { x: number; y: number }) =>
  Math.hypot(
    Math.max(r.bounds.x - p.x, 0, p.x - r.bounds.x - r.bounds.width),
    Math.max(r.bounds.y - p.y, 0, p.y - r.bounds.y - r.bounds.height),
  )
/**
 * The one text region near `point` (or anywhere) matching `label`. With `fuzzy`, OCR misreadings count towards
 * uniqueness too, and `fuzzy` in the result says the match is only such a misreading, not the label itself.
 */
export function matchLabel(
  regions: Region[],
  label: string,
  point?: { x: number; y: number },
  radius = 12,
  minConfidence = 0.5,
  fuzzy = false,
) {
  const candidates = regions
    .filter((r) => r.kind === 'text' && r.confidence >= minConfidence)
    .toSorted((a, b) =>
      point ? distance(a, point) - distance(b, point) : b.confidence - a.confidence,
    )
  const expected = normalizeLabel(label)
  const matches = candidates.filter(
    (r) =>
      expected &&
      (fuzzy ? fuzzyLabel(r.label, label) : containsLabel(r.label, label)) &&
      (!point || distance(r, point) <= radius),
  )
  const match = matches.length === 1 ? matches[0] : undefined
  return {
    match,
    candidates: candidates.slice(0, 8),
    ambiguous: matches.length > 1,
    fuzzy: !!match && !containsLabel(match.label, label),
  }
}
export function visibleWindow(observation: Observation) {
  const root = observation.elements.find((e) => e.role === 'AXWindow')?.frame
  const b = observation.bounds
  if (
    observation.isOnScreen === false ||
    // Degraded captures have no AX root to compare. Require explicit visibility and usable pixels instead.
    (observation.degraded &&
      (observation.isOnScreen !== true ||
        !observation.capture ||
        observation.capture.width < 300 ||
        observation.capture.height < 200)) ||
    (root && b && (b.w < root.w * 0.5 || b.h < root.h * 0.5)) ||
    (root && observation.capture && observation.capture.width < 300 && root.w > 300)
  )
    return {
      refuse: 'window_not_visible',
      message:
        'Show the window (turn Stage Manager off or bring it to the front with a foreground takeover) and observe again.',
    }
  return undefined
}
export function requireVisible(observation: Observation) {
  const refusal = visibleWindow(observation)
  if (refusal) throw new ObservationUnavailable(refusal.refuse, refusal.message)
}
export type Clock = { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }
export const clock: Clock = {
  now: Date.now,
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal.addEventListener('abort', done, { once: true })
    }),
}
/** Two consecutive equal small captures, bounded by a real deadline (injected in tests). */
export async function screenStable(
  capture: (maxDimension: number) => Promise<Observation>,
  signal: AbortSignal,
  timeoutMs = 3000,
  time: Clock = clock,
) {
  const deadline = time.now() + timeoutMs
  let previous: string | undefined
  do {
    signal.throwIfAborted()
    const observed = await capture(800)
    requireVisible(observed)
    if (!observed.image)
      throw new ObservationUnavailable('capture_required', 'Stability requires a screenshot.')
    const hash = createHash('sha256').update(observed.image.data).digest('hex')
    if (hash === previous) return true
    previous = hash
    if (time.now() >= deadline) return false
    await time.sleep(Math.min(250, deadline - time.now()), signal)
  } while (!signal.aborted)
  signal.throwIfAborted()
  return false
}
