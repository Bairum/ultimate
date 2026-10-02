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
import { ProjectPage, Welcome } from './pages.tsx'
import { ExtensionsPanel } from './panel.tsx'
import { projectDialog } from './parts.tsx'
import type { Status } from './parts.tsx'

/** Closing the project page without a choice defers it for this tab; a new tab or window asks again. */
const later = (root: string) => `ultimate.onboarding.later:${root}`

/** The ask-once project page first, then the first-run welcome; each closes with Escape. */
function Onboarding() {
  const system = useSystem()
  const status = useAction<Status>('onboarding', 'status')
  const ui = useUltimate()
  const [reopened, setReopened] = useDialog(projectDialog)
  const [welcomed, setWelcomed] = useState(false)
  const [, deferred] = useReducer((count: number) => count + 1, 0)
  // Where focus goes once the welcome has gone: the composer, unless it opened the Extensions panel.
  const composer = useRef(true)
  const project = system?.project
  const asking =
    project?.config === true &&
    project.decision === null &&
    sessionStorage.getItem(later(project.root)) === null
  const projectOpen = reopened || asking
  // Each opening reads the setup again, so agents, skills, and folders added since show.
  const { refetch } = status
  const wasOpen = useRef(false)
  useEffect(() => {
    if (projectOpen && !wasOpen.current) void refetch()
    wasOpen.current = projectOpen
  }, [projectOpen, refetch])
  if (!project) return null
  const welcoming = status.data?.firstRun === true && !welcomed
  return (
    <>
      <ProjectPage
        adds={status.data?.adds}
        onClose={() => {
          setReopened(false)
          if (getState().system?.project.decision === null) {
            sessionStorage.setItem(later(project.root), '1')
            deferred()
          }
        }}
        // The welcome follows on a first run and takes focus itself.
        onClosed={() => !welcoming && ui.focusComposer()}
        open={projectOpen}
      />
      <Welcome
        onClosed={() => composer.current && ui.focusComposer()}
        onDone={(next) => {
          composer.current = next !== 'extensions'
          setWelcomed(true)
          void api.action('onboarding', 'firstRunDone')
          if (next === 'extensions') ui.openPanel('extensions')
        }}
        open={!projectOpen && welcoming}
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
