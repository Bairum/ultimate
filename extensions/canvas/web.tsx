import { ReactFlowProvider } from '@xyflow/react'
import { OrbitIcon } from 'lucide-react'
import { Header, Panels, StatusLine, defineWebExtension, getState } from '@/sdk'
import type { CommandContribution, UltimateContext } from '@/sdk'
import { CanvasMap, getController, onMap } from './map.tsx'
import type { Direction } from './map.tsx'

/** Conversations as a live map around the hub, in place of the Agent surface's sidebar and column. */
function Canvas() {
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <Header />
          <ReactFlowProvider>
            <CanvasMap />
          </ReactFlowProvider>
        </main>
        <Panels />
      </div>
      <StatusLine />
    </>
  )
}

const here = (context: UltimateContext) =>
  context.surface === 'canvas' && getController() !== undefined
/** On the map with the keyboard, not zoomed into one conversation. */
const mapping = (context: UltimateContext) =>
  here(context) && onMap() && !getController()!.focused()
const selected = () => getController()?.selected()
const conversationsOn = () =>
  getState().system?.extensions.some(
    (extension) => extension.name === 'conversations' && extension.enabled,
  ) === true
const topSelected = () => {
  const agent = selected()
  return agent !== undefined && agent.parent === undefined && conversationsOn()
}

const arrows: [Direction, string, string][] = [
  ['left', 'arrowleft', 'Select the panel to the left'],
  ['right', 'arrowright', 'Select the panel to the right'],
  ['up', 'arrowup', 'Select the panel above'],
  ['down', 'arrowdown', 'Select the panel below'],
]

/** Every key on the map is a command, so the palette lists them; they act only on this surface, never while typing. */
const commands: CommandContribution[] = [
  {
    id: 'canvas.zoom-in',
    title: 'Zoom in',
    // `+` is Shift+`=` on many layouts; the map also takes `+` itself (see map.tsx).
    keys: '=',
    when: mapping,
    run: () => getController()?.zoom(1),
  },
  {
    id: 'canvas.zoom-out',
    title: 'Zoom out',
    keys: '-',
    when: (context) => here(context) && onMap(),
    run: () => getController()?.zoom(-1),
  },
  {
    id: 'canvas.fit',
    title: 'Fit every agent',
    keys: '0',
    when: (context) => here(context) && onMap(),
    run: () => getController()?.fit(),
  },
  {
    id: 'canvas.fit-tree',
    title: "Fit the selected conversation's tree",
    keys: 'f',
    when: (context) => mapping(context) && selected() !== undefined,
    run: () => getController()?.fitTree(),
  },
  ...arrows.map(([direction, keys, title]): CommandContribution => ({
    id: `canvas.select-${direction}`,
    title,
    keys,
    when: mapping,
    run: () => getController()?.move(direction),
  })),
  {
    id: 'canvas.open',
    title: 'Open the selected agent',
    keys: 'enter',
    when: (context) => mapping(context) && selected() !== undefined,
    run: () => getController()?.open(),
  },
  {
    id: 'canvas.back',
    title: 'Back to the map',
    keys: 'escape',
    whileTyping: true,
    when: (context) => here(context) && getController()!.focused(),
    run: () => getController()?.back(),
  },
  {
    id: 'canvas.hub',
    title: 'Fly to the hub',
    keys: 'h',
    when: (context) => here(context) && onMap(),
    run: () => getController()?.hub(true),
  },
  {
    id: 'canvas.new',
    title: 'Branch from the root at the hub',
    keys: 'n',
    when: (context) => here(context) && onMap(),
    run: () => getController()?.hub(true),
  },
  {
    id: 'canvas.rename',
    title: 'Rename the selected conversation',
    when: (context) => here(context) && topSelected(),
    run: () => getController()?.rename(),
  },
  {
    id: 'canvas.archive',
    title: 'Conclude the selected conversation',
    when: (context) => here(context) && topSelected() && !selected()!.archived,
    run: () => getController()?.archive(),
  },
  {
    id: 'canvas.unarchive',
    title: 'Resume the selected conversation',
    when: (context) => here(context) && topSelected() && selected()!.archived,
    run: () => getController()?.archive(),
  },
  {
    id: 'canvas.archived',
    title: 'Show concluded conversations',
    when: (context) => here(context) && conversationsOn() && !getController()!.archivedShown(),
    run: () => getController()?.toggleArchived(),
  },
  {
    id: 'canvas.archived-hide',
    title: 'Hide concluded conversations',
    when: (context) => here(context) && getController()!.archivedShown(),
    run: () => getController()?.toggleArchived(),
  },
  {
    id: 'canvas.workspace',
    title: 'Workspace details of the selected agent',
    when: (context) => here(context) && selected()?.workspace !== undefined,
    run: () => getController()?.workspace(),
  },
]

export default defineWebExtension({
  surfaces: [
    {
      id: 'canvas',
      title: 'Canvas',
      icon: OrbitIcon,
      description: 'Every agent on a live map around the hub',
      component: Canvas,
    },
  ],
  commands: commands.map((command) => ({ group: 'Canvas', ...command })),
})
