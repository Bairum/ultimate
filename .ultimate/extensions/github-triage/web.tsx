import { FileTextIcon, InboxIcon, MessageSquareReplyIcon, TagIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  Conversation,
  api,
  Dock,
  Header,
  StatusLine,
  defineWebExtension,
  useAction,
  useExtensionUiState,
  useUiState,
} from '@/sdk'
import type { ActionState } from '@/sdk'
import { Detail } from './detail.tsx'
import { List } from './list.tsx'
import { Proposal } from './proposal.tsx'
import type { Filters } from './list.tsx'
import { RepoPicker } from './repo-picker.tsx'
import { Setup } from './setup.tsx'
import { changed } from './types.tsx'
import type { Detail as DetailData, Kind, Listing, Shown, Status } from './types.tsx'

const initialFilters: Filters = { kind: 'issue', label: '', search: '' }

function Placeholder({ children }: { children: string }) {
  return (
    <main className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-6 py-5">
      <p className="text-[13px] text-muted-foreground">{children}</p>
    </main>
  )
}

/** Reload `state` after the user applied a proposal. */
function useRefetchOnChange(state: ActionState<unknown>) {
  const { refetch } = state
  useEffect(() => {
    const reload = () => void refetch()
    changed.addEventListener('change', reload)
    return () => changed.removeEventListener('change', reload)
  }, [refetch])
}

/** What each button asks; every request names the item exactly and how to read it. */
const tasks = {
  summarize: {
    label: 'Summarize',
    icon: FileTextIcon,
    ask: () =>
      `Summarize this in a few sentences: the problem or change, where the discussion stands, and what is still open. Do not propose anything.`,
  },
  labels: {
    label: 'Suggest labels',
    icon: TagIcon,
    ask: () =>
      `Suggest labels for it. Read the repository's labels with \`gh label list\` and pick only from those, then call triage_propose with addLabels (and removeLabels for wrong ones) and a one-line reason.`,
  },
  reply: {
    label: 'Draft a reply',
    icon: MessageSquareReplyIcon,
    ask: () =>
      `Draft a reply as the maintainer: helpful, short, and specific to what was said. Call triage_propose with the reply in markdown and a one-line reason; do not post it.`,
  },
} as const

/** Hands the item to the agent: who, what, where to read it, then the task. Opens the dock so the answer shows. */
function Ask({ repo, item }: { repo: string; item: DetailData }) {
  const [, setDock] = useUiState<{ open?: boolean; width?: number }>(
    'shell.dock.github-triage.right',
    {},
  )
  const noun = item.kind === 'pr' ? 'pull request' : 'issue'
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.values(tasks).map((task) => (
        <Button
          key={task.label}
          onClick={() => {
            setDock((dock) => ({ ...dock, open: true }))
            void api.submit(
              [
                `GitHub ${noun} ${repo}#${item.number}: "${item.title}" by ${item.author}${item.labels.length ? `, labelled ${item.labels.map((label) => label.name).join(', ')}` : ', no labels'}.`,
                `Read it with \`gh ${item.kind} view ${item.number} -R ${repo} --comments\`${item.kind === 'pr' ? ` (and \`gh pr diff ${item.number} -R ${repo}\` if the change matters)` : ''}.`,
                task.ask(),
              ].join(' '),
              'followUp',
            )
          }}
          size="sm"
          variant="outline"
        >
          <task.icon />
          {task.label}
        </Button>
      ))}
    </div>
  )
}

/** The middle column: the selected item, loaded in full. Keyed by item, so it scrolls back to the top. */
function Selected({ repo, kind, number }: { repo: string; kind: Kind; number: number }) {
  const shown = useAction<Shown>('github-triage', 'show', { repo, kind, number })
  useRefetchOnChange(shown)
  if (!shown.data)
    return <Placeholder>{shown.loading ? 'Loading…' : 'Could not load it.'}</Placeholder>
  if (shown.data.status === 'error') return <Placeholder>{shown.data.message}</Placeholder>
  return (
    <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
      <Detail actions={<Ask item={shown.data.item} repo={repo} />} item={shown.data.item} />
    </main>
  )
}

/** The list and the selected item for one repository. */
function Repository({ repo }: { repo: string }) {
  const [filters, setFilters] = useExtensionUiState<Filters>('filters', initialFilters)
  const [selection, setSelection] = useExtensionUiState<{ repo: string; number: number } | null>(
    'selected',
    null,
  )
  const listing = useAction<Listing>('github-triage', 'list', { repo, ...filters })
  useRefetchOnChange(listing)
  const items = listing.data?.status === 'ok' ? listing.data.items : []
  const chosen = selection?.repo === repo ? selection.number : null
  const selected = items.find((item) => item.number === chosen) ?? items[0] ?? null
  return (
    <>
      <List
        filters={filters}
        listing={listing}
        onFilters={setFilters}
        onSelect={(number) => setSelection({ repo, number })}
        repo={repo}
        selected={selected?.number ?? null}
      />
      {selected ? (
        <Selected
          key={`${filters.kind}${selected.number}`}
          kind={filters.kind}
          number={selected.number}
          repo={repo}
        />
      ) : (
        <Placeholder>{listing.loading ? 'Loading…' : 'Nothing to triage.'}</Placeholder>
      )}
    </>
  )
}

/** Open issues and pull requests on the left, the selected one in the middle, the agent docked on the right. */
function Triage() {
  const status = useAction<Status>('github-triage', 'status')
  const [chosenRepo, setRepo] = useExtensionUiState<string | null>('repo', null)
  const [, setFilters] = useExtensionUiState<Filters>('filters', initialFilters)
  const ready = status.data?.status === 'ready' ? status.data : null
  const repo = chosenRepo ?? ready?.defaultRepo ?? null
  return (
    <>
      <Header>
        {ready && (
          <RepoPicker
            defaultRepo={ready.defaultRepo}
            onChange={(next) => {
              // Labels and searches belong to a repository: start the next one unfiltered.
              setRepo(next)
              setFilters((filters) => ({ ...filters, label: '', search: '' }))
            }}
            repo={repo}
          />
        )}
      </Header>
      <div className="flex min-h-0 flex-1">
        {!status.data ? (
          <Placeholder>{status.loading ? 'Checking gh…' : 'Could not check gh.'}</Placeholder>
        ) : !ready ? (
          <Setup retry={() => void status.refetch()} status={status.data} />
        ) : repo ? (
          <Repository key={repo} repo={repo} />
        ) : (
          <Placeholder>Choose a repository in the header.</Placeholder>
        )}
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </>
  )
}

export default defineWebExtension({
  tools: { triage_propose: Proposal },
  surfaces: [
    {
      id: 'github-triage',
      title: 'Triage',
      icon: InboxIcon,
      description: 'Open GitHub issues and pull requests; triage them with the agent',
      component: Triage,
    },
  ],
})
