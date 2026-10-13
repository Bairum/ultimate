// Pi upstream: @earendil-works/pi-durable@1.2.0 src/tools/bash.ts and src/tools/edit.ts — internal bash exit_code diagnostic message drives exitOf and untyped details.patch/details.diff drive Edit. Drop when Pi exports structured bash outcomes and structured diff rows for rendering.
import { useEffect, useRef } from 'react'
import { AnsiOutput } from '@/components/ai/ansi-output'
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
  formatBytes,
  shortenPath,
  useConversation,
  useSystem,
  useToolDuration,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { formatBashCommand, pythonHeredoc } from './bash-command.tsx'
import { countChanges, Diff, editRows, parseDisplayDiff, parsePatch } from './diff.tsx'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** A path relative to the conversation's cwd, else with `~`. */
function usePath(path: string) {
  const system = useSystem()
  const { agent } = useConversation()
  return shortenPath(path, {
    cwd: agent.cwd ?? system?.execution.defaultCwd,
    home: system?.machine.home,
  })
}

function lineCount(value: string) {
  if (!value) return 0
  return value.split('\n').length - (value.endsWith('\n') ? 1 : 0)
}
const lines = (count: number) => `${count} line${count === 1 ? '' : 's'}`

function Read({ call }: { call: ToolCallView }) {
  const path = text(call.args.path)
  const shown = usePath(path)
  const duration = useToolDuration(call)
  const offset = typeof call.args.offset === 'number' ? call.args.offset : undefined
  const limit = typeof call.args.limit === 'number' ? call.args.limit : undefined
  const range =
    offset || limit ? `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : '+'}` : ''
  const failed = call.status === 'error'
  const count = call.status === 'done' ? lineCount(call.output) : 0
  return (
    <Tool defaultOpen={failed}>
      <ToolHeader
        meta={
          <>
            {count > 0 && <span>{lines(count)}</span>}
            {duration && <span>{duration}</span>}
          </>
        }
        name="read"
        state={call.status}
        title={
          <>
            {shown}
            <span className="text-muted-foreground/60">{range}</span>
          </>
        }
      />
      <ToolContent>
        {failed ? (
          <ToolOutput isError output={call.output} />
        ) : (
          call.output && (
            <CodeBlock
              className="max-h-96 overflow-auto rounded-none border-none"
              code={call.output}
              language={languageFromPath(path)}
              showLineNumbers
              startLine={offset ?? 1}
            />
          )
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

function Write({ call }: { call: ToolCallView }) {
  const path = text(call.args.path)
  const shown = usePath(path)
  const content = text(call.args.content)
  const duration = useToolDuration(call)
  const failed = call.status === 'error'
  return (
    <Tool defaultOpen={failed}>
      <ToolHeader
        meta={
          <>
            {content && (
              <span>
                {lines(lineCount(content))} ·{' '}
                {formatBytes(new TextEncoder().encode(content).length)}
              </span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name="write"
        state={call.status}
        title={shown}
      />
      <ToolContent>
        {content && (
          <CodeBlock
            className="max-h-96 overflow-auto rounded-none border-none"
            code={content}
            language={languageFromPath(path)}
            showLineNumbers
          />
        )}
        {failed && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

interface EditDetails {
  diff?: string
  patch?: string
}

function Edit({ call }: { call: ToolCallView }) {
  const path = text(call.args.path)
  const shown = usePath(path)
  const duration = useToolDuration(call)
  const details = (call.details ?? {}) as EditDetails
  const edits = Array.isArray(call.args.edits)
    ? (call.args.edits as { oldText?: string; newText?: string }[])
    : [{ oldText: text(call.args.oldText), newText: text(call.args.newText) }]
  const rows = details.patch
    ? parsePatch(details.patch)
    : details.diff
      ? parseDisplayDiff(details.diff)
      : editRows(edits)
  const { added, removed } = countChanges(rows)
  const failed = call.status === 'error'
  return (
    <Tool defaultOpen>
      <ToolHeader
        meta={
          <>
            {added + removed > 0 && (
              <span>
                <span className="text-diff-add">+{added}</span>{' '}
                <span className="text-diff-del">−{removed}</span>
              </span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name="edit"
        state={call.status}
        title={shown}
      />
      <ToolContent>
        {failed ? (
          <ToolOutput isError output={call.output} />
        ) : (
          <Diff className="max-h-[28rem]" rows={rows} />
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

function exitOf(call: ToolCallView): { label: string; ok: boolean } | undefined {
  if (call.status === 'done') return { label: 'exit 0', ok: true }
  if (call.status === 'interrupted') return { label: 'interrupted', ok: false }
  if (call.status !== 'error') return undefined
  const exited = call.diagnostics.find((diagnostic) => diagnostic.code === 'exit_code')
  const code = exited && /\d+/.exec(exited.message)?.[0]
  if (code) return { label: `exit ${code}`, ok: false }
  const messages = call.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
  if (/timed out/.test(messages)) return { label: 'timeout', ok: false }
  if (/aborted/i.test(messages)) return { label: 'aborted', ok: false }
  return { label: 'failed', ok: false }
}

function Bash({ call }: { call: ToolCallView }) {
  const command = text(call.args.command)
  const display = formatBashCommand(command)
  const directory = usePath(display.directory ?? '')
  const heredoc = pythonHeredoc(display.commands[0])
  const formatted = !!display.directory || display.commands.length > 1 || !!heredoc
  const duration = useToolDuration(call)
  const exit = exitOf(call)
  const output = call.output
  const running = call.status === 'running'
  const scroller = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const element = scroller.current
    if (running && element) element.scrollTop = element.scrollHeight
  }, [output, running])
  const multiline = command.includes('\n')
  return (
    <Tool defaultOpen>
      <ToolHeader
        meta={
          <>
            {exit && <span className={exit.ok ? 'text-success' : 'text-error'}>{exit.label}</span>}
            {duration && <span>{duration}</span>}
          </>
        }
        name="$"
        state={call.status}
        title={
          <span className="text-foreground/90">
            {display.commands[0].split('\n')[0]}
            {display.commands.length > 1 && (
              <span className="text-muted-foreground/60"> · +{display.commands.length - 1}</span>
            )}
          </span>
        }
      />
      <ToolContent>
        {(formatted || multiline) && (
          <ToolSection className="space-y-1">
            {display.directory && (
              <div className="truncate text-muted-foreground/70" title={display.directory}>
                cd {directory} <span className="text-muted-foreground/50">&&</span>
              </div>
            )}
            <div className="space-y-1 text-foreground/85">
              {display.commands.map((part, index) => (
                <div className="flex gap-2" key={index}>
                  <span className="w-4 shrink-0 text-muted-foreground/50">
                    {index === 0 ? '$' : display.operators[index - 1]}
                  </span>
                  {index === 0 && heredoc ? (
                    <div className="min-w-0 flex-1 space-y-1">
                      <pre className="whitespace-pre-wrap break-words">{heredoc.opening}</pre>
                      <CodeBlock
                        className="rounded-none border-none"
                        code={heredoc.body}
                        language="python"
                      />
                      <pre className="whitespace-pre-wrap break-words">{heredoc.ending}</pre>
                    </div>
                  ) : (
                    <pre className="min-w-0 whitespace-pre-wrap break-words">{part}</pre>
                  )}
                </div>
              ))}
            </div>
            {formatted && (
              <details className="text-muted-foreground/70">
                <summary className="cursor-pointer">Original command</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words">{command}</pre>
              </details>
            )}
          </ToolSection>
        )}
        {(multiline || output || running) && (
          <pre
            className="max-h-80 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85"
            ref={scroller}
          >
            {call.dropped && (
              <div className="text-muted-foreground/70">
                … {call.dropped.lines.toLocaleString()} earlier lines dropped
              </div>
            )}
            <AnsiOutput output={output} />
            {running && (
              <span className="ml-px inline-block h-3.5 w-1.5 animate-pulse-dot bg-brand align-middle" />
            )}
          </pre>
        )}
        {!output && !running && !multiline && (
          <ToolSection className={cn('text-muted-foreground/70')}>no output</ToolSection>
        )}
        <ToolDiagnostics diagnostics={call.diagnostics.filter((d) => d.code !== 'tool_error')} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({
  tools: { read: Read, write: Write, edit: Edit, bash: Bash },
})
