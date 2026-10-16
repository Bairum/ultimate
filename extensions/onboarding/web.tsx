import { BlocksIcon, FolderCogIcon, GitBranchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  api,
  defineWebExtension,
  useAction,
  useConversation,
  useDialog,
  useEvent,
  useExtensions,
  useSystem,
  useUltimate,
} from '@/sdk'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FirstRun, GitCard, ProjectCard } from './pages.tsx'
import type { Isolation } from './pages.tsx'
import { ExtensionsPanel } from './panel.tsx'
import { gitDialog, projectDialog } from './parts.tsx'
import type { Status } from './parts.tsx'

/**
 * Whether the project can have isolated conversations, read again after the Git card set it up and whenever the shown
 * conversation finishes a run, since an agent may just have made the first commit.
 */
function useIsolation() {
  const workspaces = useExtensions().some((extension) => extension.name === 'workspaces')
  const isolation = useAction<Isolation>('workspaces', 'isolation', {}, { enabled: workspaces })
  const busy = useConversation((conversation) => conversation.busy)
  const { refetch } = isolation
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy && workspaces) void refetch()
    wasBusy.current = busy
  }, [busy, refetch, workspaces])
  useEvent('onboarding:git', () => {
    if (workspaces) void refetch()
  })
  return workspaces ? isolation.data : undefined
}

/**
 * The first run's two pages, which also ask about an undecided project setup; afterwards, that question as a compact
 * card that opens only when asked for, from the status line or the Extensions panel. Each closes with Escape.
 */
function Onboarding() {
  const system = useSystem()
  const status = useAction<Status>('onboarding', 'status')
  const ui = useUltimate()
  const [cardOpen, setCardOpen] = useDialog(projectDialog)
  const [gitOpen, setGitOpen] = useDialog(gitDialog)
  const isolation = useIsolation()
  const [finished, setFinished] = useState(false)
  const project = system?.project
  // Until status answers, the first run does not show; without an answer there is none. A page driven by automation,
  // such as the agent's browser tool, does not get it.
  const settled = !navigator.webdriver && (status.data !== undefined || status.error !== undefined)
  const firstRun = settled && status.data?.firstRun === true && !finished
  // Each opening reads the setup again, so agents, skills, and folders added since show.
  const { refetch } = status
  const wasOpen = useRef(false)
  useEffect(() => {
    if (cardOpen && !wasOpen.current) void refetch()
    wasOpen.current = cardOpen
  }, [cardOpen, refetch])
  if (!project) return null
  return (
    <>
      <FirstRun
        askProject={project.config && project.decision === null}
        onClosed={() => ui.focusComposer()}
        onDone={(skipped) => {
          setFinished(true)
          // Skipped: the defaults stay, and the status line keeps offering the project question.
          if (skipped) void api.action('onboarding', 'firstRunDone')
        }}
        open={firstRun}
        status={status.data}
      />
      <ProjectCard
        adds={status.data?.adds}
        onClose={() => setCardOpen(false)}
        onClosed={() => ui.focusComposer()}
        open={!firstRun && cardOpen}
      />
      <GitCard
        isolation={isolation}
        onClose={() => setGitOpen(false)}
        onClosed={() => ui.focusComposer()}
        open={!firstRun && gitOpen && !!isolation?.reason}
      />
    </>
  )
}

/** While the project's setup is undecided, a quiet status-line entry that opens the question. */
function Undecided() {
  const system = useSystem()
  const ui = useUltimate()
  const project = system?.project
  if (!project?.config || project.decision !== null) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => ui.open(projectDialog)}
          type="button"
        >
          <FolderCogIcon className="size-3 text-brand" />
          project setup
        </button>
      </TooltipTrigger>
      <TooltipContent className="text-[11px]" side="top">
        This folder has its own setup. Using global until you choose.
      </TooltipContent>
    </Tooltip>
  )
}

/** While conversations must share the folder for want of Git, a quiet status-line entry that offers to set it up. */
function NoGit() {
  const ui = useUltimate()
  const reason = useIsolation()?.reason
  if (!reason) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => ui.open(gitDialog)}
          type="button"
        >
          <GitBranchIcon className="size-3 text-brand" />
          set up git
        </button>
      </TooltipTrigger>
      <TooltipContent className="text-[11px]" side="top">
        {reason}; until then, conversations share this folder.
      </TooltipContent>
    </Tooltip>
  )
}

export default defineWebExtension({
  slots: { overlay: [Onboarding], 'statusline.right': [NoGit, Undecided] },
  panels: [{ id: 'extensions', title: 'Extensions', icon: BlocksIcon, component: ExtensionsPanel }],
  commands: [
    {
      id: 'onboarding.extensions',
      title: 'Extensions…',
      run: (context) => context.openPanel('extensions'),
    },
  ],
})
