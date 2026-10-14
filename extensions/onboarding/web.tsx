import { BlocksIcon } from 'lucide-react'
import { useEffect, useReducer, useRef, useState } from 'react'
import {
  api,
  defineWebExtension,
  getState,
  useAction,
  useDialog,
  useSystem,
  useUltimate,
} from '@/sdk'
import { FirstRun, ProjectCard } from './pages.tsx'
import { ExtensionsPanel } from './panel.tsx'
import { projectDialog } from './parts.tsx'
import type { Status } from './parts.tsx'

/** Closing the project question without a choice defers it for this tab; a new tab or window asks again. */
const later = (root: string) => `ultimate.onboarding.later:${root}`

/**
 * The first run's two pages, which also ask about an undecided project setup; afterwards, that question as a compact
 * card. Each closes with Escape.
 */
function Onboarding() {
  const system = useSystem()
  const status = useAction<Status>('onboarding', 'status')
  const ui = useUltimate()
  const [reopened, setReopened] = useDialog(projectDialog)
  const [finished, setFinished] = useState(false)
  const [, deferred] = useReducer((count: number) => count + 1, 0)
  const project = system?.project
  // Until status answers, neither shows; without an answer there is no first run. A page driven by automation, such
  // as the agent's browser tool, gets neither unasked: the Extensions panel still opens the project card.
  const settled = !navigator.webdriver && (status.data !== undefined || status.error !== undefined)
  const firstRun = settled && status.data?.firstRun === true && !finished
  const undecided = project?.config === true && project.decision === null
  const asking =
    settled && !firstRun && undecided && sessionStorage.getItem(later(project.root)) === null
  const cardOpen = !firstRun && (reopened || asking)
  // Each opening reads the setup again, so agents, skills, and folders added since show.
  const { refetch } = status
  const wasOpen = useRef(false)
  useEffect(() => {
    if (cardOpen && !wasOpen.current) void refetch()
    wasOpen.current = cardOpen
  }, [cardOpen, refetch])
  if (!project) return null
  const defer = () => {
    if (getState().system?.project.decision !== null) return
    sessionStorage.setItem(later(project.root), '1')
    deferred()
  }
  return (
    <>
      <FirstRun
        askProject={undecided}
        onClosed={() => ui.focusComposer()}
        onDone={(skipped) => {
          setFinished(true)
          if (!skipped) return
          // Skipped: the defaults stay, and the project question waits for another tab.
          void api.action('onboarding', 'firstRunDone')
          defer()
        }}
        open={firstRun}
        status={status.data}
      />
      <ProjectCard
        adds={status.data?.adds}
        onClose={() => {
          setReopened(false)
          defer()
        }}
        onClosed={() => ui.focusComposer()}
        open={cardOpen}
      />
    </>
  )
}

export default defineWebExtension({
  slots: { overlay: [Onboarding] },
  panels: [{ id: 'extensions', title: 'Extensions', icon: BlocksIcon, component: ExtensionsPanel }],
  commands: [
    {
      id: 'onboarding.extensions',
      title: 'Extensions…',
      run: (context) => context.openPanel('extensions'),
    },
  ],
})
