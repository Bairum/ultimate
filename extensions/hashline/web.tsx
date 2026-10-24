import type { ReactNode } from 'react'
import { parsePatch } from 'diff'
import { CodeBlock, languageFromPath } from '@/components/ai/code-block'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import {
  cn,
  defineWebExtension,
  shortenPath,
  useConversation,
  useStore,
  useToolDuration,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'

type ReadDetails = { path: string; tag: string; startLine: number; text: string }
type SearchFile = {
  path: string
  displayPath?: string
  tag: string
  rows: { line: number; text: string }[]
}
type Details = {
  patch?: string
  hashline?: Partial<ReadDetails> & { files?: SearchFile[]; matches?: number; capped?: boolean }
}
type Props = { call: ToolCallView; core: ReactNode }
function usePath(path: string) {
  const cwd = useConversation((conversation) => conversation.agent.cwd)
  const home = useStore((state) => state.system?.machine.home)
  return shortenPath(path, { cwd, home })
}
function Read({ call, core }: Props) {
  const read = (call.details as Details | undefined)?.hashline
  const shown = usePath(typeof call.args.path === 'string' ? call.args.path : (read?.path ?? ''))
  const duration = useToolDuration(call)
  if (typeof read?.text !== 'string') return core
  return (
    <Tool defaultOpen={call.status === 'error'}>
      <ToolHeader
        name="read"
        state={call.status}
        title={shown}
        meta={
          <>
            {read.tag && <span>#{read.tag}</span>}
            {duration && <span>{duration}</span>}
          </>
        }
      />
      <ToolContent>
        <CodeBlock
          className="max-h-96 overflow-auto rounded-none border-none"
          code={read.text}
          language={languageFromPath(read.path ?? '')}
          showLineNumbers
          startLine={read.startLine ?? 1}
        />
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

/** Minimal equivalent of coding-tools' diff rows; its helpers are not a public ui.tsx API. */
function PatchDiff({ patch }: { patch: string }) {
  return (
    <div className="max-h-[28rem] overflow-auto bg-terminal py-1 font-mono text-[12px] leading-[1.6]">
      {parsePatch(patch).map((file, index) => (
        <div key={index}>
          <div className="bg-muted/40 px-3 py-1 text-muted-foreground">{file.newFileName}</div>
          <div className="grid min-w-max grid-cols-[auto_auto_auto_1fr]">
            {file.hunks.flatMap((hunk, hunkIndex) => {
              let old = hunk.oldStart,
                next = hunk.newStart
              return [
                <div
                  className="col-span-4 bg-muted/40 px-3 text-muted-foreground"
                  key={`h${hunkIndex}`}
                >
                  @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                </div>,
                ...hunk.lines
                  .filter((line) => !line.startsWith('\\'))
                  .map((line, row) => {
                    const sign = line[0],
                      added = sign === '+',
                      removed = sign === '-'
                    const before = added ? '' : old++,
                      after = removed ? '' : next++
                    return (
                      <div
                        className={cn(
                          'col-span-4 grid grid-cols-subgrid',
                          added && 'bg-diff-add/10 text-diff-add',
                          removed && 'bg-diff-del/10 text-diff-del',
                        )}
                        key={`${hunkIndex}:${row}`}
                      >
                        <span className="pl-3 text-right text-muted-foreground/50 select-none">
                          {before}
                        </span>
                        <span className="pl-2 text-right text-muted-foreground/50 select-none">
                          {after}
                        </span>
                        <span className="w-6 text-center select-none">{removed ? '−' : sign}</span>
                        <span className="pr-4 whitespace-pre">{line.slice(1) || ' '}</span>
                      </div>
                    )
                  }),
              ]
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
function Edit({ call, core }: Props) {
  const input = typeof call.args.input === 'string' ? call.args.input : undefined
  const details = call.details as Details | undefined
  const paths =
    input?.split('\n').flatMap((line) => /^\[(.+)#[\dA-Fa-f]{4}\]$/.exec(line)?.[1] ?? []) ?? []
  const shown = usePath([...new Set(paths)].join(', '))
  const duration = useToolDuration(call)
  if (input === undefined && !details?.hashline) return core
  return (
    <Tool defaultOpen>
      <ToolHeader
        name="edit"
        state={call.status}
        title={shown || 'hashline patch'}
        meta={duration && <span>{duration}</span>}
      />
      <ToolContent>
        {call.status === 'error' ? (
          <ToolOutput isError output={call.output} />
        ) : details?.patch ? (
          <PatchDiff patch={details.patch} />
        ) : (
          <ToolSection className="text-muted-foreground">
            {call.status === 'done' ? 'No content change.' : 'Preparing patch…'}
          </ToolSection>
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}
function SearchFileView({ file }: { file: SearchFile }) {
  const shown = usePath(file.displayPath ?? file.path)
  const runs: { start: number; lines: string[] }[] = []
  for (const row of file.rows) {
    const last = runs.at(-1)
    if (last && last.start + last.lines.length === row.line) last.lines.push(row.text)
    else runs.push({ start: row.line, lines: [row.text] })
  }
  return (
    <div>
      <ToolSection className="bg-muted/40 text-muted-foreground">
        {shown}
        <span className="ml-2 text-muted-foreground/60">#{file.tag}</span>
      </ToolSection>
      {runs.map((run, index) => (
        <div key={run.start}>
          {index > 0 && <div className="bg-terminal px-3 text-muted-foreground/60">⋯</div>}
          <CodeBlock
            className="max-h-96 overflow-auto rounded-none border-none"
            code={run.lines.join('\n')}
            language={languageFromPath(file.path)}
            showLineNumbers
            startLine={run.start}
          />
        </div>
      ))}
    </div>
  )
}
function Grep({ call, core }: Props) {
  const search = (call.details as Details | undefined)?.hashline
  const duration = useToolDuration(call)
  if (!search?.files) return core
  return (
    <Tool defaultOpen>
      <ToolHeader
        name="grep"
        state={call.status}
        title={typeof call.args.pattern === 'string' ? call.args.pattern : ''}
        meta={
          <>
            <span>{search.matches ?? 0} matches</span>
            {duration && <span>{duration}</span>}
          </>
        }
      />
      <ToolContent>
        {search.files.length ? (
          search.files.map((file) => <SearchFileView file={file} key={file.path} />)
        ) : (
          <ToolSection className="text-muted-foreground">No matches.</ToolSection>
        )}
        {search.capped && (
          <ToolSection className="text-warning">
            Results capped; narrow the pattern or path.
          </ToolSection>
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}
function EditLine({ call }: { call: ToolCallView }) {
  return typeof call.args.input === 'string' ? (
    <>
      <span className="text-foreground/80">edit</span> hashline patch
    </>
  ) : (
    <>
      <span className="text-foreground/80">edit</span>{' '}
      {typeof call.args.path === 'string' ? call.args.path : ''}
    </>
  )
}
export default defineWebExtension({
  tools: { read: Read, edit: Edit, grep: Grep },
  toolLines: { edit: EditLine },
})
