import { parsePatchFiles } from '@pierre/diffs'
import { FileDiff, Virtualizer } from '@pierre/diffs/react'
import type { FileDiffMetadata, FileDiffOptions } from '@pierre/diffs/react'
import { ArrowUpRightIcon, ChevronDownIcon, Columns2Icon, Rows3Icon } from 'lucide-react'
import { useMemo } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, errorMessage, useAction, useExtensionUiState, useStore, useViewport } from '@/sdk'
import { compareUrl } from '../../lib/compare.ts'
import { useGithubRepo } from '../workspaces/ui.tsx'
import { useSpec } from './link.tsx'
import { Frame, Loading, Notice } from './parts.tsx'
import { DiffAction } from './refs.ts'
import type { ReviewDiff, ReviewFile } from './refs.ts'
import { Selector } from './selector.tsx'

/**
 * Our theme for the viewer, inside its shadow root: our page's tokens inherit into it, so the code takes our mono
 * font, our background and our add/del colours in both themes, with the vitesse themes for syntax.
 */
const themeCss = `
:host {
  --diffs-font-family: var(--font-mono);
  --diffs-header-font-family: var(--font-sans);
  --diffs-font-size: 12px;
  --diffs-line-height: 19px;
  --diffs-light-bg: var(--background);
  --diffs-dark-bg: var(--background);
  --diffs-addition-color-override: var(--diff-add);
  --diffs-deletion-color-override: var(--diff-del);
  --diffs-modified-color-override: var(--brand);
  --diffs-fg-number-override: color-mix(in oklab, var(--muted-foreground) 70%, transparent);
  --diffs-bg-separator-override: var(--muted);
  --diffs-bg-context-override: var(--card);
}
[data-diffs-header] { border-bottom: 1px solid var(--border); font-size: 12.5px; }
`

const status: Record<ReviewFile['status'], [string, string]> = {
  added: ['A', 'text-diff-add'],
  deleted: ['D', 'text-diff-del'],
  modified: ['M', 'text-muted-foreground'],
  renamed: ['R', 'text-brand'],
  copied: ['C', 'text-brand'],
}

/** Files by their directory, directories in path order, files in diff order within each. */
function byDirectory(files: ReviewFile[]) {
  const groups = Map.groupBy(files, (file) => {
    const slash = file.path.lastIndexOf('/')
    return slash === -1 ? '' : file.path.slice(0, slash)
  })
  return [...groups].toSorted(([a], [b]) => a.localeCompare(b))
}
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const anchor = (path: string) => `review-file-${path}`

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      <span className="text-diff-add">+{additions}</span>{' '}
      <span className="text-diff-del">−{deletions}</span>
    </span>
  )
}

function FileList({ files, onPick }: { files: ReviewFile[]; onPick: (path: string) => void }) {
  return (
    <nav className="w-64 shrink-0 overflow-y-auto border-r border-border/70 bg-sidebar py-1.5">
      {byDirectory(files).map(([directory, items]) => (
        <div key={directory}>
          {directory && (
            <div
              className="truncate px-3 pt-1.5 pb-0.5 font-mono text-[10.5px] text-muted-foreground/80"
              title={directory}
            >
              {directory}/
            </div>
          )}
          {items.map((file) => {
            const [letter, tone] = status[file.status]
            return (
              <button
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-0.5 text-left hover:bg-accent/60"
                key={file.path}
                onClick={() => onPick(file.path)}
                title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                type="button"
              >
                <span className={cn('w-2.5 shrink-0 font-mono text-[10.5px]', tone)}>{letter}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/90">
                  {fileName(file.path)}
                </span>
                {file.binary ? (
                  <span className="font-mono text-[10.5px] text-muted-foreground">bin</span>
                ) : (
                  <Counts additions={file.additions} deletions={file.deletions} />
                )}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

/** The file list as a dropdown, on a phone. */
function FileMenu({ files, onPick }: { files: ReviewFile[]; onPick: (path: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 w-full shrink-0 cursor-pointer items-center gap-1.5 border-b border-border/70 bg-sidebar px-3 font-mono text-[12px] text-muted-foreground">
        {files.length} file{files.length === 1 ? '' : 's'}
        <ChevronDownIcon className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[60vh] w-[calc(100vw-1rem)] overflow-y-auto"
      >
        {files.map((file) => (
          <DropdownMenuItem
            className="gap-2 font-mono text-[12px]"
            key={file.path}
            onSelect={() => onPick(file.path)}
          >
            <span className={cn('w-2.5 shrink-0 text-[10.5px]', status[file.status][1])}>
              {status[file.status][0]}
            </span>
            <span className="min-w-0 flex-1 truncate">{file.path}</span>
            <Counts additions={file.additions} deletions={file.deletions} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A file whose hunks were left out: binary, a type change, or too large to show. */
function Placeholder({ file }: { file: ReviewFile }) {
  return (
    <div className="rounded-md border border-border/70 bg-card/40">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2 font-mono text-[12px]">
        <span className="min-w-0 flex-1 truncate">{file.path}</span>
        {!file.binary && <Counts additions={file.additions} deletions={file.deletions} />}
      </div>
      <p className="px-4 py-3 font-mono text-[11.5px] text-muted-foreground">
        {file.binary
          ? 'Binary file'
          : file.typeChanged
            ? 'Changed between a file and a symlink'
            : 'Too large to show here'}
      </p>
    </div>
  )
}

function Diffs({
  diff,
  layout,
  phone,
}: {
  diff: ReviewDiff
  layout: 'split' | 'unified'
  phone: boolean
}) {
  const theme = useStore((state) => state.ui.theme)
  const parsed = useMemo(() => {
    const byPath = new Map<string, FileDiffMetadata>()
    for (const patch of parsePatchFiles(diff.patch, `${diff.base}:${diff.head ?? 'work'}`))
      for (const file of patch.files) byPath.set(file.name, file)
    return byPath
  }, [diff])
  const options = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({
      theme: { dark: 'vitesse-dark', light: 'vitesse-light' },
      themeType: theme,
      diffStyle: phone ? 'unified' : layout,
      diffIndicators: 'bars',
      overflow: phone ? 'wrap' : 'scroll',
      lineDiffType: 'word',
      hunkSeparators: 'line-info',
      unsafeCSS: themeCss,
    }),
    [theme, layout, phone],
  )
  const pick = (path: string) =>
    document.getElementById(anchor(path))?.scrollIntoView({ block: 'start' })
  return (
    <>
      {!phone && <FileList files={diff.files} onPick={pick} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {phone && <FileMenu files={diff.files} onPick={pick} />}
        {diff.truncated && (
          <p className="shrink-0 border-b border-border/70 bg-warning/10 px-4 py-1.5 font-mono text-[11.5px] text-warning">
            This diff is too large to show whole: later files are listed without their changes.
          </p>
        )}
        <Virtualizer
          className="min-h-0 flex-1 overflow-y-auto"
          contentClassName="space-y-3 p-3 md:p-4"
          key={`${diff.spec}:${phone}`}
        >
          {diff.files.map((file) => {
            const meta = parsed.get(file.path)
            return (
              <section className="scroll-mt-3" id={anchor(file.path)} key={file.path}>
                {meta ? (
                  <FileDiff
                    className="block overflow-hidden rounded-md border border-border/70"
                    fileDiff={meta}
                    options={options}
                  />
                ) : (
                  <Placeholder file={file} />
                )}
              </section>
            )
          })}
        </Virtualizer>
      </div>
    </>
  )
}

/** The Review surface: a spec's diff, its files on the left and their changes stacked on the right. */
export default function ReviewSurface() {
  const [spec, setSpec] = useSpec()
  const [stored, setLayout] = useExtensionUiState('layout', 'split')
  const layout = stored === 'unified' ? 'unified' : 'split'
  const phone = useViewport() === 'phone'
  const diff = useAction(DiffAction, { spec }, { onError: () => undefined })
  const github = useGithubRepo()
  const data = diff.data?.spec === spec ? diff.data : undefined
  const totals = data?.files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  )
  // A worktree branch is local until it lands, so only commits and ranges (landings) are on GitHub to compare.
  const compare =
    github && data?.base && data.head && (data.kind === 'commit' || data.kind === 'range')
      ? compareUrl(github, data.base, data.head)
      : undefined
  return (
    <Frame
      controls={
        <>
          <Selector onChange={setSpec} spec={spec} title={data?.title} />
          {data && totals && (
            <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
              <span className="text-diff-add">+{totals.additions}</span>{' '}
              <span className="text-diff-del">−{totals.deletions}</span>
              <span className="max-md:hidden">
                {' '}
                · {data.files.length} file{data.files.length === 1 ? '' : 's'}
              </span>
            </span>
          )}
          {!phone && (
            <div className="flex shrink-0 items-center rounded-md border border-border/70 p-0.5">
              {(
                [
                  ['split', Columns2Icon],
                  ['unified', Rows3Icon],
                ] as const
              ).map(([name, Icon]) => (
                <button
                  aria-pressed={layout === name}
                  className={cn(
                    'flex h-6 cursor-pointer items-center gap-1 rounded-sm px-1.5 font-mono text-[11px] text-muted-foreground transition-colors',
                    layout === name ? 'bg-accent text-foreground' : 'hover:text-foreground',
                  )}
                  key={name}
                  onClick={() => setLayout(name)}
                  title={`${name === 'split' ? 'Side by side' : 'Unified'} diff`}
                  type="button"
                >
                  <Icon className="size-3.5" />
                  <span className="max-lg:hidden">{name}</span>
                </button>
              ))}
            </div>
          )}
          {compare && (
            <a
              className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[11.5px] text-muted-foreground hover:text-foreground hover:underline"
              href={compare}
              rel="noreferrer"
              target="_blank"
              title="Compare on DiffsHub"
            >
              DiffsHub
              <ArrowUpRightIcon className="size-3 opacity-60" />
            </a>
          )}
        </>
      }
    >
      {data ? (
        data.files.length === 0 ? (
          <Notice>no changes · {data.title}</Notice>
        ) : (
          <Diffs diff={data} layout={layout} phone={phone} />
        )
      ) : diff.error && !diff.loading ? (
        <Notice>
          <span className="text-error">{errorMessage(diff.error)}</span>
        </Notice>
      ) : (
        <Loading />
      )}
    </Frame>
  )
}
