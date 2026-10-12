import { useInternalNode } from '@xyflow/react'
import type { Edge, EdgeProps, InternalNode } from '@xyflow/react'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/sdk'
import type { Status } from './model.tsx'
import { STATUS } from './model.tsx'

export type HubEdgeData = { archived: boolean }
export type FlowEdgeData = {
  /** The child's state. */
  status: Status
  /** The parent waits on the working child (a foreground start, message, or wait). */
  flowing: boolean
  /** When the parent's last wait on it ended (ms), else 0. */
  answered: number
}
export type HubEdge = Edge<HubEdgeData, 'hub'>
export type FlowEdge = Edge<FlowEdgeData, 'flow'>

const STROKE = 'fill-none [vector-effect:non-scaling-stroke]'
/** How long the answer's dot runs back (ms). */
const ANSWER = 1200

function box(node: InternalNode) {
  const width = node.measured.width ?? node.width ?? 0
  const height = node.measured.height ?? node.height ?? 0
  const { x, y } = node.internals.positionAbsolute
  return { x: x + width / 2, y: y + height / 2, width, height }
}
/** Where the line from `from`'s centre toward `to` leaves `from`'s box, a little outside it. */
function exit(from: ReturnType<typeof box>, to: { x: number; y: number }) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const scale = Math.max(
    Math.abs(dx) / (from.width / 2 + 6),
    Math.abs(dy) / (from.height / 2 + 6),
    1,
  )
  return { x: from.x + dx / scale, y: from.y + dy / scale }
}
/** The straight line between two boxes' borders, or nothing while either is unmeasured. */
function useLine(source: string, target: string) {
  const a = useInternalNode(source)
  const b = useInternalNode(target)
  if (!a || !b) return undefined
  const from = box(a)
  const to = box(b)
  const start = exit(from, to)
  const end = exit(to, from)
  return {
    forward: `M${start.x},${start.y}L${end.x},${end.y}`,
    back: `M${end.x},${end.y}L${start.x},${start.y}`,
  }
}

/** Hub to a top-level conversation: quiet. */
export const HubLine = memo(function HubLine({ source, target, data }: EdgeProps<HubEdge>) {
  const line = useLine(source, target)
  if (!line) return null
  return (
    <path
      className={cn(
        STROKE,
        'stroke-muted-foreground/30',
        data?.archived && 'stroke-muted-foreground/20 [stroke-dasharray:4_6]',
      )}
      d={line.forward}
      strokeWidth={1}
    />
  )
})

/**
 * Parent to subagent. While the parent waits on a working child, a few dots flow calmly toward the child (SMIL motion
 * along the path: a transform per dot, nothing re-laid out); when the wait ends, one dot runs back to the parent.
 */
export const FlowLine = memo(function FlowLine({ source, target, data }: EdgeProps<FlowEdge>) {
  const line = useLine(source, target)
  const status = data?.status ?? 'idle'
  const flowing = data?.flowing === true
  const answered = data?.answered ?? 0
  // The answer runs back for a moment after the wait ended; the map keeps the time, so a remount keeps it too.
  const [, expire] = useState(0)
  const fresh = answered > 0 && Date.now() - answered < ANSWER
  useEffect(() => {
    if (!fresh) return undefined
    const timer = setTimeout(() => expire(Date.now()), answered + ANSWER - Date.now())
    return () => clearTimeout(timer)
  }, [answered, fresh])
  if (!line) return null
  return (
    <g data-edge-flow={flowing ? 'waiting' : status}>
      {flowing && (
        <path
          className={cn(STROKE, 'stroke-sky-500/20 dark:stroke-sky-400/20')}
          d={line.forward}
          strokeWidth={6}
        />
      )}
      <path
        className={cn(STROKE, flowing ? STATUS.waiting.stroke : STATUS[status].stroke)}
        d={line.forward}
        strokeWidth={flowing ? 1.5 : 1.25}
      />
      {flowing &&
        [0, 1, 2].map((index) => (
          <circle className="fill-sky-600 dark:fill-sky-300" key={index} r={4}>
            <animateMotion
              begin={`${-index * 0.9}s`}
              dur="2.7s"
              path={line.forward}
              repeatCount="indefinite"
            />
          </circle>
        ))}
      {fresh && <Answer key={answered} path={line.back} />}
    </g>
  )
})

/** One dot back along the line, once, fading as it arrives. */
function Answer({ path }: { path: string }) {
  const motion = useRef<SVGAnimateMotionElement>(null)
  const fade = useRef<SVGAnimateElement>(null)
  useLayoutEffect(() => {
    motion.current?.beginElement()
    fade.current?.beginElement()
  }, [])
  return (
    <circle className="fill-success" data-edge-answer opacity={0} r={5}>
      <animateMotion begin="indefinite" dur="0.9s" fill="freeze" path={path} ref={motion} />
      <animate
        attributeName="opacity"
        begin="indefinite"
        dur="0.9s"
        fill="freeze"
        ref={fade}
        values="1;1;0"
      />
    </circle>
  )
}
