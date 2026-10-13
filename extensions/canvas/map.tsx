import '@xyflow/react/dist/base.css'
import {
  Background,
  BackgroundVariant,
  Panel as Corner,
  ReactFlow,
  useReactFlow,
  useStore as useFlow,
} from '@xyflow/react'
import type { Viewport } from '@xyflow/react'
import { ArchiveIcon, HouseIcon, MinusIcon, PlusIcon, ScanIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  cn,
  formatKeys,
  getConversation,
  getState,
  useConversations,
  useExtensionUiState,
  useStore,
  useSystem,
  useTasks,
  useUiState,
  useUltimate,
} from '@/sdk'
import { useFeed, useFeedDocuments } from './data.tsx'
import type { FlowEdge, HubEdge } from './edges.tsx'
import { FlowLine, HubLine } from './edges.tsx'
import type { HubData, HubNode } from './hub.tsx'
import { HUB_INPUT, Hub } from './hub.tsx'
import type { Point, Ring, Size } from './layout.tsx'
import {
  ANSWERED,
  CARD,
  CONCLUDED,
  HUB,
  PANEL,
  PILL,
  assignRing,
  radial,
  useGlide,
} from './layout.tsx'
import type { Agent, Shape } from './model.tsx'
import { agentsOf } from './model.tsx'
import type { CanvasActions, PanelData, PanelNode } from './panel.tsx'
import { AgentPanel, CanvasContext } from './panel.tsx'

const VIEWPORT = 'ultimate.canvas.viewport'
const ARCHIVED = 'ext.conversations.archived'
/** Room around a panel zoomed to fill the view. */
const MARGIN = 20
const nodeTypes = { agent: AgentPanel, hub: Hub }
const edgeTypes = { flow: FlowLine, hub: HubLine }
/** How much room an agent takes: its shape, and a card grows to hold a conclusion and what it produced. */
type Box = Shape | 'concluded' | 'answered'
const sizes: Record<Box, Size> = {
  panel: PANEL,
  card: CARD,
  pill: PILL,
  concluded: CONCLUDED,
  answered: ANSWERED,
}
function boxOf({ shape, conclusion }: Agent): Box {
  if (shape !== 'card' || !conclusion) return shape
  const { screenshot, landed, commits, pushed, subagents, files } = conclusion
  return screenshot || landed.length || commits || pushed || subagents || files
    ? 'concluded'
    : 'answered'
}
/** After the user moves the map, it is theirs this long (ms): the camera does not follow spawns. */
const HANDS_OFF = 4000

export type Direction = 'left' | 'right' | 'up' | 'down'
/** What the commands drive; set while the map is mounted. */
export type Controller = {
  zoom: (direction: 1 | -1) => void
  fit: () => void
  fitTree: () => void
  move: (direction: Direction) => void
  open: () => void
  back: () => void
  hub: (compose: boolean) => void
  focused: () => boolean
  /** The shown conversation, when it has a panel on the map. */
  selected: () => Agent | undefined
  rename: () => void
  archive: () => void
  archivedShown: () => boolean
  toggleArchived: () => void
  workspace: () => void
}
let controller: Controller | undefined
export const getController = () => controller

/** The map has the keyboard: nothing else is focused, or the map itself is. */
const mapHasKeys = () => {
  const active = document.activeElement
  return !active || active === document.body || active.matches('[data-canvas-map]')
}
/** Plain keys drive the map only while it has the keyboard; the palette lists the commands either way. */
export const onMap = () => getState().ui.paletteOpen || mapHasKeys()

function storedViewport(): Viewport | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(VIEWPORT) ?? 'null') as Viewport | null
    return value && [value.x, value.y, value.zoom].every(Number.isFinite) ? value : undefined
  } catch {
    return undefined
  }
}

/** The smallest rectangle around these boxes, by their centres and sizes. */
function bounds(boxes: { point: Point; size: Size }[]) {
  const left = Math.min(...boxes.map(({ point, size }) => point.x - size.width / 2))
  const top = Math.min(...boxes.map(({ point, size }) => point.y - size.height / 2))
  const right = Math.max(...boxes.map(({ point, size }) => point.x + size.width / 2))
  const bottom = Math.max(...boxes.map(({ point, size }) => point.y + size.height / 2))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** What an agent's edge shows: its state, and whether its parent waits on it. */
type Line = Pick<Agent, 'id' | 'parent' | 'archived' | 'status'> & { flowing: boolean }

/** What the camera, the commands and callbacks read: this render's state, without re-subscribing. */
type Latest = {
  byId: ReadonlyMap<number, Agent>
  agents: readonly Agent[]
  shown: number | undefined
  targets: ReadonlyMap<number, Point>
  focus: boolean
  showArchived: boolean
  setShowArchived: (value: boolean) => void
  width: number
  height: number
  open: (id: number) => void
  back: () => void
  archive: (id: number, archive: boolean) => void
}

const sameAgent = (a: Agent, b: Agent) =>
  a.status === b.status &&
  a.shape === b.shape &&
  a.archived === b.archived &&
  a.folded === b.folded &&
  a.parent === b.parent &&
  a.row === b.row &&
  a.workspace === b.workspace &&
  a.conclusion === b.conclusion &&
  JSON.stringify(a.reasons) === JSON.stringify(b.reasons) &&
  a.members.join() === b.members.join() &&
  JSON.stringify(a.summary) === JSON.stringify(b.summary)

function Control({
  label,
  keys,
  onClick,
  pressed,
  children,
}: {
  label: string
  keys?: string
  onClick: () => void
  pressed?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            'h-7 min-w-7 cursor-pointer px-1.5 text-muted-foreground hover:text-foreground',
            pressed && 'bg-accent text-foreground',
          )}
          onClick={onClick}
          size="sm"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        {keys && (
          <KbdGroup>
            {formatKeys(keys)[0]?.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** The zoom level, in the corner. */
function Zoom() {
  const zoom = useFlow((state) => state.transform[2])
  return (
    <span className="w-10 text-center font-mono text-[11px] text-muted-foreground tabular-nums">
      {Math.round(zoom * 100)}%
    </span>
  )
}

/**
 * Every agent around the hub: React Flow keeps the viewport (pan, zoom, animated moves) and renders only what is
 * visible; the layout, the panels and the edges are ours.
 */
export function CanvasMap() {
  const flow = useReactFlow()
  // The shell's actions are stable functions; the object around them is not.
  const { switchConversation, openPanel, runCommand } = useUltimate()
  const system = useSystem()
  const enabled = (name: string) =>
    system?.extensions.some((extension) => extension.name === name && extension.enabled) === true
  const conversationsOn = enabled('conversations')
  const isolation = enabled('workspaces')
  useFeedDocuments(conversationsOn, isolation)
  const feed = useFeed()
  const conversations = useConversations()
  const tasks = useTasks()
  const [archived, setArchived] = useUiState<number[]>(ARCHIVED, [])
  const [showArchived, setShowArchived] = useExtensionUiState('showArchived', false)
  const shown = useStore((state) => state.view?.conversation.id ?? state.requested)
  const agents = useMemo(
    () =>
      agentsOf({
        conversations,
        tasks,
        agents: feed.agents,
        rows: feed.rows,
        workspaces: feed.workspaces,
        trees: feed.trees,
        archived,
        showArchived,
        shown,
      }),
    [conversations, tasks, feed, archived, showArchived, shown],
  )
  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])

  // Lay out only when the tree or a shape changes, not on every feed update.
  const structure = JSON.stringify(
    agents.map((agent) => [agent.id, agent.parent ?? 0, boxOf(agent)]),
  )
  const ring = useRef<Ring>({ count: 8, slots: new Map() })
  const targets = useMemo(() => {
    const list = JSON.parse(structure) as [number, number, Box][]
    const top = new Map<number, number>()
    const branches = new Map<number, number[]>()
    for (const [id, parent] of list) {
      const root = parent ? top.get(parent)! : id
      top.set(id, root)
      if (parent)
        branches.set(
          root,
          [...(branches.get(root) ?? []), id].toSorted((a, b) => a - b),
        )
    }
    const shapes = new Map(list.map(([id, , shape]) => [id, shape]))
    ring.current = assignRing(
      ring.current,
      list.filter(([, parent]) => !parent).map(([id]) => id),
    )
    return radial(ring.current, branches, (id) => sizes[shapes.get(id)!])
  }, [structure])

  // Nothing animates until the documents and the list arrived: a reload shows the map as it is.
  const loaded = feed.loaded && conversations.length > 0
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (loaded && !settled) setSettled(true)
  }, [loaded, settled])
  const latest = useRef<Latest>(undefined as never)
  latest.current = { ...latest.current, byId, agents, shown, targets }
  // The camera's functions run from callbacks and commands: they read the view's size through `latest`.
  const points = useGlide(targets, (id) => latest.current.byId.get(id)?.parent, settled)
  const births = useRef({ seen: new Set<number>(), born: new Map<number, number>() })
  const born = useMemo(() => {
    const record = births.current
    for (const [id] of targets) if (!record.seen.has(id) && settled) record.born.set(id, Date.now())
    record.seen = new Set(targets.keys())
    return new Map(record.born)
  }, [targets, settled])

  const [focus, setFocus] = useState(false)
  const [hovered, setHovered] = useState<number>()
  const [renaming, setRenaming] = useState<number>()
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const saved = useRef<Viewport>(undefined)
  const width = useFlow((state) => state.width)
  const height = useFlow((state) => state.height)
  Object.assign(latest.current, { width, height })
  const focused = focus && shown !== undefined && byId.has(shown) ? shown : undefined
  const focusSize = useMemo(
    () => ({
      width: Math.max(360, width - 2 * MARGIN),
      height: Math.max(260, height - 2 * MARGIN),
    }),
    [width, height],
  )

  const reveal = useRef<number>(undefined)
  const revealed = useRef<number>(undefined)
  const hubData = useMemo<HubData>(
    () => ({
      started: (id) => {
        reveal.current = id
        switchConversation(id)
      },
    }),
    [switchConversation],
  )

  const cache = useRef(new Map<number, PanelData>())
  const nodes = useMemo(() => {
    const list: (PanelNode | HubNode)[] = [
      {
        id: 'hub',
        type: 'hub',
        position: { x: 0, y: 0 },
        width: HUB.width,
        height: HUB.height,
        zIndex: 0,
        className: cn('transition-opacity duration-300', focused !== undefined && 'opacity-15'),
        data: hubData,
      },
    ]
    for (const agent of agents) {
      const isFocused = agent.id === focused
      const expanded = !isFocused && hovered === agent.id && agent.shape !== 'panel'
      const size = isFocused ? focusSize : expanded ? PANEL : sizes[boxOf(agent)]
      const flags = {
        selected: agent.id === shown,
        focused: isFocused,
        expanded,
        renaming: renaming === agent.id,
        born: born.get(agent.id) ?? 0,
      }
      const previous = cache.current.get(agent.id)
      const data =
        previous &&
        sameAgent(previous.agent, agent) &&
        (Object.keys(flags) as (keyof typeof flags)[]).every((key) => previous[key] === flags[key])
          ? previous
          : { agent, ...flags }
      cache.current.set(agent.id, data)
      list.push({
        id: String(agent.id),
        type: 'agent',
        position: points.get(agent.id) ??
          (agent.parent === undefined ? undefined : points.get(agent.parent)) ?? { x: 0, y: 0 },
        width: size.width,
        height: size.height,
        zIndex: isFocused ? 30 : expanded ? 20 : agent.id === shown ? 10 : 1,
        // Focused, the rest of the map steps back.
        className: cn(
          'transition-opacity duration-300',
          focused !== undefined && !isFocused && 'opacity-15',
        ),
        ariaLabel: agent.summary.title ?? `#${agent.id}`,
        data,
      })
    }
    return list
  }, [agents, points, hubData, focused, hovered, focusSize, shown, renaming, born])

  /** Per parent-child edge: whether the parent waits on the working child, and when its last wait ended. */
  const flows = useRef(new Map<string, { flowing: boolean; answered: number }>())
  // The edges change with the tree, its states and who waits on whom, not with every streamed row.
  const lines = JSON.stringify(
    agents.map((agent): Line => ({
      id: agent.id,
      parent: agent.parent,
      archived: agent.archived,
      status: agent.status,
      flowing:
        agent.parent !== undefined &&
        (agent.status === 'working' || agent.status === 'waiting') &&
        feed.agents[agent.parent]?.waitingOn?.includes(agent.id) === true,
    })),
  )
  const edges = useMemo(
    () =>
      (JSON.parse(lines) as Line[]).map((line): HubEdge | FlowEdge => {
        if (line.parent === undefined)
          return {
            id: `hub-${line.id}`,
            source: 'hub',
            target: String(line.id),
            type: 'hub',
            data: { archived: line.archived },
          }
        const id = `${line.parent}-${line.id}`
        const { flowing } = line
        const before = flows.current.get(id)
        const answered = before?.flowing && !flowing ? Date.now() : (before?.answered ?? 0)
        flows.current.set(id, { flowing, answered })
        return {
          id,
          source: String(line.parent),
          target: String(line.id),
          type: 'flow',
          data: { status: line.status, flowing, answered },
        }
      }),
    [lines],
  )

  // Camera.
  const placeOf = (id: number) => {
    const point = latest.current.targets.get(id)
    const agent = latest.current.byId.get(id)
    return point && agent ? { point, size: sizes[boxOf(agent)] } : undefined
  }
  const fitAll = (duration = 500) => {
    const boxes = [
      { point: { x: 0, y: 0 }, size: HUB },
      ...latest.current.agents.flatMap((agent) => placeOf(agent.id) ?? []),
    ]
    frame(bounds(boxes), 0.08, duration)
  }
  /** Fit a rectangle into the view with `padding` (a fraction of the view) around it, never past zoom 1. */
  const frame = (rect: ReturnType<typeof bounds>, padding: number, duration: number) => {
    const view = latest.current
    const zoom = Math.max(
      0.05,
      Math.min(
        1,
        (view.width * (1 - 2 * padding)) / rect.width,
        (view.height * (1 - 2 * padding)) / rect.height,
      ),
    )
    void flow.setViewport(
      {
        x: view.width / 2 - (rect.x + rect.width / 2) * zoom,
        y: view.height / 2 - (rect.y + rect.height / 2) * zoom,
        zoom,
      },
      { duration },
    )
  }
  /** Ease `id` into view, centring it, unless it is already well inside. */
  const show = (id: number) => {
    const box = placeOf(id)
    if (!box) return
    const view = latest.current
    const { x, y, zoom } = flow.getViewport()
    const left = box.point.x * zoom + x - (box.size.width * zoom) / 2
    const top = box.point.y * zoom + y - (box.size.height * zoom) / 2
    const inside =
      left > 24 &&
      top > 24 &&
      left + box.size.width * zoom < view.width - 24 &&
      top + box.size.height * zoom < view.height - 24
    if (!inside) void flow.setCenter(box.point.x, box.point.y, { zoom, duration: 450 })
  }
  const back = () => {
    if (!focus) return
    setFocus(false)
    container.current?.focus({ preventScroll: true })
    if (saved.current) void flow.setViewport(saved.current, { duration: 450 })
  }
  const open = (id: number) => {
    if (!latest.current.byId.has(id)) return
    switchConversation(id)
    if (!focus) saved.current = flow.getViewport()
    setFocus(true)
  }

  // A new conversation springs out of the hub: keep both in view.
  useEffect(() => {
    const id = reveal.current
    const box = id === undefined ? undefined : placeOf(id)
    if (!box) return
    reveal.current = undefined
    revealed.current = id
    frame(bounds([{ point: { x: 0, y: 0 }, size: HUB }, box]), 0.15, 700)
  })
  // A subagent springing out of the shown tree: re-frame the tree gently, unless the user just moved the map.
  const moved = useRef(0)
  const known = useRef<ReadonlySet<number>>(new Set())
  useEffect(() => {
    const fresh = [...targets.keys()].filter((id) => !known.current.has(id))
    known.current = new Set(targets.keys())
    const now = latest.current
    if (!settled || now.focus || Date.now() - moved.current < HANDS_OFF) return
    const topOf = (id: number) => {
      let agent = now.byId.get(id)
      while (agent?.parent !== undefined) agent = now.byId.get(agent.parent)
      return agent?.id
    }
    const tree = now.shown === undefined ? undefined : topOf(now.shown)
    if (
      tree === undefined ||
      !fresh.some((id) => now.byId.get(id)?.parent !== undefined && topOf(id) === tree)
    )
      return
    const rect = bounds(
      now.agents.flatMap((agent) => (topOf(agent.id) === tree ? (placeOf(agent.id) ?? []) : [])),
    )
    const { x, y, zoom } = flow.getViewport()
    const margin = 32
    if (
      rect.x * zoom + x > margin &&
      rect.y * zoom + y > margin &&
      (rect.x + rect.width) * zoom + x < now.width - margin &&
      (rect.y + rect.height) * zoom + y < now.height - margin
    )
      return
    // Never closer than now: the tree comes into view, the user's zoom stays unless it must give.
    const fit = Math.min(zoom, (now.width * 0.9) / rect.width, (now.height * 0.9) / rect.height)
    void flow.setViewport(
      {
        x: now.width / 2 - (rect.x + rect.width / 2) * fit,
        y: now.height / 2 - (rect.y + rect.height / 2) * fit,
        zoom: Math.max(0.05, fit),
      },
      { duration: 600 },
    )
  }, [targets, settled, flow])
  // The first layout: the stored viewport, else everything; a deep-linked conversation eases into view.
  const [stored] = useState(storedViewport)
  const placed = useRef(false)
  useEffect(() => {
    if (!loaded || placed.current || !width) return
    placed.current = true
    if (!stored) fitAll(0)
    if (shown !== undefined) show(shown)
  })
  // The selection follows the shown conversation; the camera follows the selection.
  useEffect(() => {
    // A conversation started at the hub is framed with the hub instead.
    if (shown === reveal.current || shown === revealed.current) return
    if (placed.current && shown !== undefined && !latest.current.focus) show(shown)
  }, [shown])
  // Focused: the panel fills the view at zoom 1, crisp; it follows resizes and the shown conversation.
  const flown = useRef(false)
  useEffect(() => {
    if (focused === undefined) {
      flown.current = false
      if (focus && placed.current) setFocus(false)
      return
    }
    const point = targets.get(focused)
    if (!point) return
    void flow.setCenter(point.x, point.y, { zoom: 1, duration: flown.current ? 0 : 450 })
    flown.current = true
  }, [focused, focusSize, targets, focus, flow])

  const actions = useMemo<CanvasActions>(
    () => ({
      open: (id) => latest.current.open(id),
      back: () => latest.current.back(),
      rename: (id) => setRenaming(id),
      archive: (id, archive) => latest.current.archive(id, archive),
      clear: (id) => {
        switchConversation(id)
        const deadline = Date.now() + 5000
        // The command clears the shown conversation once its view has arrived.
        const run = () => {
          const view = getConversation()
          if (view.id === id && !view.loading) runCommand('conversations.reset')
          else if (Date.now() < deadline) requestAnimationFrame(run)
        }
        run()
      },
      workspace: (id) => {
        switchConversation(id)
        openPanel('workspaces')
      },
    }),
    [switchConversation, openPanel, runCommand],
  )
  const archive = (id: number, hide: boolean) => {
    setArchived((previous) => [...previous.filter((other) => other !== id), ...(hide ? [id] : [])])
    // As the sidebar: archiving the shown conversation shows the next one.
    if (!hide || showArchived || id !== shown) return
    const tops = agents.filter((agent) => agent.parent === undefined && agent.id !== id)
    const next = tops.find((agent) => agent.id > id) ?? tops.at(-1)
    if (next) switchConversation(next.id)
  }
  Object.assign(latest.current, { open, back, archive, focus, showArchived, setShowArchived })

  useEffect(() => {
    const move = (direction: Direction) => {
      const now = latest.current
      const from = (now.shown !== undefined && now.targets.get(now.shown)) || { x: 0, y: 0 }
      let best: { id: number; score: number } | undefined
      for (const agent of now.agents) {
        const point = now.targets.get(agent.id)
        if (!point || agent.id === now.shown) continue
        const dx = point.x - from.x
        const dy = point.y - from.y
        const [along, across] =
          direction === 'left'
            ? [-dx, dy]
            : direction === 'right'
              ? [dx, dy]
              : direction === 'up'
                ? [-dy, dx]
                : [dy, dx]
        if (along < 8) continue
        const score = along + 2 * Math.abs(across)
        if (!best || score < best.score) best = { id: agent.id, score }
      }
      if (best) switchConversation(best.id)
    }
    const flyHome = (compose: boolean) => {
      if (latest.current.focus) setFocus(false)
      void flow.setCenter(0, 0, { zoom: Math.max(flow.getZoom(), 0.85), duration: 500 })
      if (compose)
        setTimeout(() => document.getElementById(HUB_INPUT)?.focus({ preventScroll: true }), 520)
    }
    controller = {
      zoom: (direction) => {
        if (latest.current.focus) {
          if (direction < 0) latest.current.back()
          return
        }
        void (direction > 0 ? flow.zoomIn({ duration: 250 }) : flow.zoomOut({ duration: 250 }))
      },
      fit: () => {
        setFocus(false)
        fitAll()
      },
      fitTree: () => {
        const now = latest.current
        let top = now.shown === undefined ? undefined : now.byId.get(now.shown)
        while (top?.parent !== undefined) top = now.byId.get(top.parent)
        if (!top) return
        const members = new Set([top.id])
        for (const agent of now.agents)
          if (agent.parent !== undefined && members.has(agent.parent)) members.add(agent.id)
        setFocus(false)
        frame(bounds([...members].flatMap((id) => placeOf(id) ?? [])), 0.1, 500)
      },
      move,
      open: () => {
        const now = latest.current
        if (now.shown !== undefined) now.open(now.shown)
      },
      back: () => latest.current.back(),
      hub: flyHome,
      focused: () => latest.current.focus,
      selected: () => {
        const now = latest.current
        return now.shown === undefined ? undefined : now.byId.get(now.shown)
      },
      rename: () => {
        const id = latest.current.shown
        if (id === undefined) return
        setFocus(false)
        if (flow.getZoom() < 0.8) {
          const point = latest.current.targets.get(id)
          if (point) void flow.setCenter(point.x, point.y, { zoom: 1, duration: 300 })
        }
        setRenaming(id)
      },
      archive: () => {
        const agent = controller?.selected()
        if (agent?.parent === undefined && agent) latest.current.archive(agent.id, !agent.archived)
      },
      archivedShown: () => latest.current.showArchived,
      toggleArchived: () => latest.current.setShowArchived(!latest.current.showArchived),
      workspace: () => {
        const id = latest.current.shown
        if (id !== undefined) actions.workspace(id)
      },
    }
    return () => {
      controller = undefined
    }
  }, [flow, switchConversation, actions])

  // Zoom in is `=`, the key `+` shares on many layouts; `+` itself (Shift+`=`, or its own key) zooms in too.
  useEffect(() => {
    const zoomIn = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key !== '+' || !mapHasKeys()) return
      event.preventDefault()
      runCommand('canvas.zoom-in')
    }
    window.addEventListener('keydown', zoomIn)
    return () => window.removeEventListener('keydown', zoomIn)
  }, [runCommand])

  const archivedCount = conversations.filter(
    (conversation) =>
      conversation.parentConversationId === undefined && archived.includes(conversation.id),
  ).length
  const context = useMemo(
    () => ({ actions, conversations: conversationsOn }),
    [actions, conversationsOn],
  )
  const container = useRef<HTMLDivElement>(null)

  return (
    <CanvasContext value={context}>
      <div
        className="relative min-h-0 flex-1 bg-background outline-none"
        data-canvas-map
        data-focused={focused}
        onPointerDown={(event) => {
          // Clicks on the map give it the keyboard, unless they land in something that takes keys itself.
          const target = event.target as HTMLElement
          if (!target.closest('input, textarea, button, a, [data-canvas-focus], [role="menu"]'))
            container.current?.focus({ preventScroll: true })
        }}
        ref={container}
        tabIndex={-1}
      >
        <ReactFlow
          defaultViewport={stored ?? { x: 0, y: 0, zoom: 0.8 }}
          deleteKeyCode={null}
          disableKeyboardA11y
          edgeTypes={edgeTypes}
          edges={edges}
          edgesFocusable={false}
          elementsSelectable={false}
          maxZoom={1.6}
          minZoom={0.05}
          multiSelectionKeyCode={null}
          nodeOrigin={[0.5, 0.5]}
          nodeTypes={nodeTypes}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          nodesFocusable={false}
          onMove={(event, viewport) => {
            if (event) moved.current = Date.now()
            // Zooming out of a focused panel returns to the map.
            if (event && latest.current.focus && viewport.zoom < 0.92) setFocus(false)
          }}
          onMoveEnd={(_event, viewport) => {
            if (!latest.current.focus) localStorage.setItem(VIEWPORT, JSON.stringify(viewport))
          }}
          onNodeClick={(_event, node) => {
            if (node.id !== 'hub') switchConversation(Number(node.id))
          }}
          onNodeDoubleClick={(_event, node) => {
            if (node.id !== 'hub') open(Number(node.id))
          }}
          onNodeMouseEnter={(_event, node) => {
            clearTimeout(hoverTimer.current)
            const agent = byId.get(Number(node.id))
            if (agent && agent.shape !== 'panel')
              hoverTimer.current = setTimeout(() => setHovered(agent.id), 140)
          }}
          onNodeMouseLeave={() => {
            clearTimeout(hoverTimer.current)
            hoverTimer.current = setTimeout(() => setHovered(undefined), 80)
          }}
          onlyRenderVisibleElements
          panActivationKeyCode={null}
          panOnDrag={!focused}
          panOnScroll={!focused}
          proOptions={{ hideAttribution: true }}
          selectionKeyCode={null}
          zoomOnDoubleClick={false}
          zoomOnScroll={false}
        >
          <Background color="var(--border)" gap={28} size={1.4} variant={BackgroundVariant.Dots} />
          {focused === undefined && (
            <Corner
              className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-card/90 p-1 shadow-sm backdrop-blur"
              position="bottom-left"
            >
              <Control keys="-" label="Zoom out" onClick={() => controller?.zoom(-1)}>
                <MinusIcon className="size-3.5" />
              </Control>
              <Zoom />
              <Control keys="=" label="Zoom in" onClick={() => controller?.zoom(1)}>
                <PlusIcon className="size-3.5" />
              </Control>
              <Control keys="0" label="Fit every agent" onClick={() => controller?.fit()}>
                <ScanIcon className="size-3.5" />
              </Control>
              <Control keys="h" label="Fly to the hub" onClick={() => controller?.hub(false)}>
                <HouseIcon className="size-3.5" />
              </Control>
              {conversationsOn && archivedCount > 0 && (
                <Control
                  label={
                    showArchived ? 'Hide archived conversations' : 'Show archived conversations'
                  }
                  onClick={() => setShowArchived(!showArchived)}
                  pressed={showArchived}
                >
                  <ArchiveIcon className="size-3.5" />
                  <span className="font-mono text-[11px]">{archivedCount}</span>
                </Control>
              )}
            </Corner>
          )}
        </ReactFlow>
      </div>
    </CanvasContext>
  )
}
