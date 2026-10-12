import { useEffect, useRef, useState } from 'react'

export type Size = { width: number; height: number }
export type Point = { x: number; y: number }

/** Sizes on the map, in flow units (pixels at zoom 1). */
export const PANEL: Size = { width: 360, height: 248 }
/** A settled top-level conversation, folded with everything it owns. */
export const CARD: Size = { width: 320, height: 132 }
/** A folded tree with its conclusion: headline, summary, thumbnail and chips. */
export const CONCLUDED: Size = { width: 380, height: 264 }
/** A folded tree whose conclusion is only words: no screenshot, nothing it produced. */
export const ANSWERED: Size = { width: 380, height: 204 }
/** A finished subagent. */
export const PILL: Size = { width: 236, height: 60 }
export const HUB: Size = { width: 440, height: 168 }
const GAP = 48
/** The first ring clears the hub with room for its edges. */
const MIN_RING = 560
/** A branch never fans wider than this, so a lone conversation still reads as a branch. */
const MAX_WEDGE = 1.2

/** A box's extent along the direction (cos, sin). */
const extent = (size: Size, cos: number, sin: number) =>
  Math.abs(cos) * size.width + Math.abs(sin) * size.height

/** Where the first ring's rays point: a power of two of slots, each conversation keeping its own. */
export type Ring = { count: number; slots: ReadonlyMap<number, number> }

/** Slot `index` of the bit-reversed order: top, bottom, right, left, then halfway between, so any number balances. */
const reversed = (index: number, count: number) => {
  let slot = 0
  for (let bit = count >> 1, rest = index; bit; bit >>= 1, rest >>= 1) if (rest & 1) slot |= bit
  return slot
}

/**
 * Give each top-level conversation a slot on the ring. Kept ones keep theirs (scaled when the ring doubles, which keeps
 * their angle), new ones take the first free slot in bit-reversed order, by id; a conversation that leaves frees its
 * slot. So a new conversation never moves another.
 */
export function assignRing(previous: Ring, tops: readonly number[]): Ring {
  let count = Math.max(8, previous.count)
  while (count < tops.length) count *= 2
  const scale = count / Math.max(8, previous.count)
  const slots = new Map<number, number>()
  for (const id of tops) {
    const slot = previous.slots.get(id)
    if (slot !== undefined) slots.set(id, slot * scale)
  }
  const taken = new Set(slots.values())
  let next = 0
  for (const id of tops.toSorted((a, b) => a - b)) {
    if (slots.has(id)) continue
    while (taken.has(reversed(next, count))) next++
    slots.set(id, reversed(next, count))
    taken.add(reversed(next, count))
  }
  return { count, slots }
}

/**
 * A radial tree around the hub at the origin. Each top-level conversation is a ray from its ring slot; everything it
 * owns packs outward along that ray in rows, in creation order, fanning no wider than its free neighbouring slots
 * allow. The first ring depends only on the slots, and a branch only on its own members and its neighbours' slots, so
 * a new or folding subagent never moves another branch. Points are box centres.
 */
export function radial(
  { count, slots }: Ring,
  branches: ReadonlyMap<number, readonly number[]>,
  size: (id: number) => Size,
): Map<number, Point> {
  const points = new Map<number, Point>()
  if (!slots.size) return points
  const step = (2 * Math.PI) / count
  const ring = Math.max(MIN_RING, (count * (PANEL.width + GAP)) / (2 * Math.PI))
  const used = [...slots.values()].toSorted((a, b) => a - b)
  for (const [id, slot] of slots) {
    const index = used.indexOf(slot)
    const before = (slot - used.at(index - 1)! + count) % count || count
    const after = (used[(index + 1) % used.length] - slot + count) % count || count
    const wedge = Math.min(MAX_WEDGE, Math.min(before, after) * step)
    const angle = -Math.PI / 2 + slot * step
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    points.set(id, { x: ring * cos, y: ring * sin })
    const members = branches.get(id) ?? []
    // The outer edge of what is placed so far, along the ray.
    let reach = ring + extent(size(id), cos, sin) / 2
    let placed = 0
    while (placed < members.length) {
      // Fill a row while it fits the wedge at the radius its deepest box needs.
      const row: number[] = []
      let depth = 0
      let width = 0
      for (const member of members.slice(placed)) {
        const box = size(member)
        const across = extent(box, sin, cos) + GAP
        const nextDepth = Math.max(depth, extent(box, cos, sin))
        if (row.length && width + across > (reach + GAP + nextDepth / 2) * wedge) break
        row.push(member)
        depth = nextDepth
        width += across
      }
      const radius = reach + GAP + depth / 2
      let offset = -width / 2
      for (const member of row) {
        const across = extent(size(member), sin, cos) + GAP
        const turn = (offset + across / 2) / radius
        points.set(member, {
          x: radius * Math.cos(angle + turn),
          y: radius * Math.sin(angle + turn),
        })
        offset += across
      }
      reach = radius + depth / 2
      placed += row.length
    }
  }
  return points
}

/** Ease out with a little overshoot: a panel springs into place. */
const spring = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2
const DURATION = 650

/**
 * Animated positions toward `targets`: a point that moves glides there, a new one springs out of its `origin` (its
 * parent's current point, else the hub), and while nothing moves nothing renders. Pass memoized targets.
 */
export function useGlide(
  targets: ReadonlyMap<number, Point>,
  origin: (id: number) => number | undefined,
  animate: boolean,
) {
  const [shown, setShown] = useState<ReadonlyMap<number, Point>>(targets)
  const current = useRef<ReadonlyMap<number, Point>>(targets)
  const originOf = useRef(origin)
  originOf.current = origin
  useEffect(() => {
    const from = new Map<number, Point>()
    let moving = false
    for (const [id, target] of targets) {
      let start = current.current.get(id)
      if (!start && animate) {
        const parent = originOf.current(id)
        start = (parent !== undefined && current.current.get(parent)) || { x: 0, y: 0 }
      }
      start ??= target
      from.set(id, start)
      if (start.x !== target.x || start.y !== target.y) moving = true
    }
    if (!moving) {
      current.current = targets
      setShown(targets)
      return undefined
    }
    const began = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - began) / DURATION)
      const k = spring(t)
      const next = new Map<number, Point>()
      for (const [id, target] of targets) {
        const start = from.get(id)!
        next.set(id, {
          x: start.x + (target.x - start.x) * k,
          y: start.y + (target.y - start.y) * k,
        })
      }
      current.current = next
      setShown(next)
      if (t < 1) frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [targets, animate])
  return shown
}
