import { useEffect, useRef, useState } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { defineWebExtension, formatBytes, plural, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'

/** The tool's `details` (cascade.ts `FindDetails`). */
interface Details {
  query: string
  mode: 'semantic' | 'lexical'
  reason?: string
  partial?: string
  hits: {
    path: string
    score: number
    ranges: { start: number; end: number; p?: number; snippet: string }[]
  }[]
  stats: {
    listed: number
    judged: number
    requests: number
    bytesSent: number
    inputTokens: number
    cost: number
  }
}

/** A thin meter for a 0–1 value. */
function Meter({ value }: { value: number }) {
  return (
    <span className="relative h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-muted">
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-brand opacity-70"
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </span>
  )
}

function Hits({ details }: { details: Details }) {
  const semantic = details.mode === 'semantic'
  // A lexical score is unbounded: its meter is relative to the strongest file.
  const top = semantic ? 1 : Math.max(...details.hits.map((hit) => hit.score), 1e-9)
  return (
    <ol aria-label="Find hits" className="divide-y divide-border/60">
      {details.hits.map((hit) => (
        <li className="px-2.5 py-1.5" key={hit.path}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-foreground/90" title={hit.path}>
              {hit.path}
            </span>
            <Meter value={hit.score / top} />
            <span className="w-8 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
              {semantic ? hit.score.toFixed(2) : hit.score.toFixed(1)}
            </span>
          </div>
          {hit.ranges.slice(0, 3).map((range) => (
            <div
              className="flex min-w-0 gap-2 pl-2 text-[11px] text-muted-foreground"
              key={`${range.start}-${range.end}`}
            >
              <span className="shrink-0 tabular-nums">
                {range.start === range.end ? range.start : `${range.start}–${range.end}`}
              </span>
              {range.p !== undefined && (
                <span className="shrink-0 text-muted-foreground/70 tabular-nums">
                  {range.p.toFixed(2)}
                </span>
              )}
              <span className="min-w-0 truncate text-muted-foreground/80">{range.snippet}</span>
            </div>
          ))}
        </li>
      ))}
    </ol>
  )
}

function Find({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const details = call.details as Details | undefined
  const query = typeof call.args.query === 'string' ? call.args.query : ''
  // Collapsed while it goes well; a failure opens it, also one that arrives live.
  const failed = call.status === 'error'
  const [open, setOpen] = useState(failed)
  const was = useRef(failed)
  useEffect(() => {
    if (failed && !was.current) setOpen(true)
    was.current = failed
  }, [failed])
  const stats = details?.stats
  return (
    <Tool onOpenChange={setOpen} open={open}>
      <ToolHeader
        meta={
          <>
            {details?.mode === 'lexical' && <span className="text-warning">lexical</span>}
            {details?.partial && <span className="text-warning">partial</span>}
            {details && <span>{plural(details.hits.length, 'hit')}</span>}
            {duration && <span>{duration}</span>}
          </>
        }
        name="find"
        state={call.status}
        title={<span className="text-foreground/90">{query}</span>}
      />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">judging files…</Shimmer>
          </ToolSection>
        )}
        {details ? (
          <>
            {(details.reason || details.partial) && (
              <ToolSection className="text-[11.5px] text-warning">
                {details.reason && <div className="break-words">{details.reason}</div>}
                {details.partial && <div className="break-words">{details.partial}</div>}
              </ToolSection>
            )}
            {details.hits.length > 0 ? (
              <Hits details={details} />
            ) : (
              <ToolSection className="text-muted-foreground/70">no hits</ToolSection>
            )}
            {stats && (
              <ToolSection className="border-t border-border/60 text-[11px] text-muted-foreground/70">
                {[
                  `${stats.listed} files listed`,
                  stats.requests > 0 && `${stats.judged} judged`,
                  stats.requests > 0 && plural(stats.requests, 'request'),
                  stats.requests > 0 && `${formatBytes(stats.bytesSent)} sent`,
                  stats.requests > 0 && `${stats.inputTokens.toLocaleString()} tokens`,
                  stats.requests > 0 && `$${stats.cost.toFixed(4)}`,
                  stats.requests === 0 && 'nothing sent',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </ToolSection>
            )}
          </>
        ) : (
          failed && <ToolOutput isError output={call.output} />
        )}
        <ToolDiagnostics diagnostics={call.diagnostics.filter((d) => d.code !== 'tool_error')} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({ tools: { find: Find } })
