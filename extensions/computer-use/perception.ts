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
/** Convert action coordinates back to the screenshot pixels used by OCR, using only Driver metadata. */
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
  const { m11, m12, m21, m22, tx, ty } = s as Record<string, number>
  // The live Driver reports axis-aligned affine maps; unmeasured rotations/shears are no hit.
  if (!m11 || !m22 || m12 !== 0 || m21 !== 0) return undefined
  return { x: (point.x - tx) / m11, y: (point.y - ty) / m22 }
}
export const normalizeLabel = (label: string) =>
  label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200e\u200f\u2066-\u2069]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
/** Whole normalized token sequences; a negated state is not a positive label match. */
export function containsLabel(text: string, label: string) {
  const actual = normalizeLabel(text)
  const expected = normalizeLabel(label)
  return (
    Boolean(expected) &&
    ` ${actual} `.includes(` ${expected} `) &&
    !(actual.split(' ').includes('not') && !expected.split(' ').includes('not'))
  )
}
const distance = (r: Region, p: { x: number; y: number }) =>
  Math.hypot(
    Math.max(r.bounds.x - p.x, 0, p.x - r.bounds.x - r.bounds.width),
    Math.max(r.bounds.y - p.y, 0, p.y - r.bounds.y - r.bounds.height),
  )
export function matchLabel(
  regions: Region[],
  label: string,
  point?: { x: number; y: number },
  radius = 12,
  minConfidence = 0.5,
) {
  const candidates = regions
    .filter((r) => r.kind === 'text' && r.confidence >= minConfidence)
    .toSorted((a, b) =>
      point ? distance(a, point) - distance(b, point) : b.confidence - a.confidence,
    )
  const expected = normalizeLabel(label)
  const matches = candidates.filter(
    (r) => expected && containsLabel(r.label, label) && (!point || distance(r, point) <= radius),
  )
  return {
    match: matches.length === 1 ? matches[0] : undefined,
    candidates: candidates.slice(0, 8),
    ambiguous: matches.length > 1,
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
