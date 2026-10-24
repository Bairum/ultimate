import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { defineWebExtension } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import type { Range, Turn } from './refs.ts'

type Result = Partial<Range> & {
  saved?: number
  restored?: boolean
  from?: number
  to?: number
  reason?: string
  turns?: Turn[]
  ranges?: Range[]
}
function Compression({ call }: { call: ToolCallView }) {
  let result: Result = {}
  let malformed = false
  if (call.status === 'done') {
    try {
      result = JSON.parse(call.output) as Result
    } catch {
      // Keep malformed output inside its tool card instead of breaking the transcript.
      malformed = true
    }
  }
  const listing = call.name === 'context_ranges'
  return (
    <Tool defaultOpen>
      <ToolHeader
        name={call.name}
        state={call.status}
        title={
          listing
            ? 'Older context'
            : call.name === 'decompress'
              ? `${result.id ?? (typeof call.args.id === 'string' ? call.args.id : '')}${result.restored === true ? ' restored' : result.restored === false ? ' not restored' : ''}`
              : `${result.fromEntry ?? (typeof call.args.from === 'number' ? call.args.from : '')}–${result.toEntry ?? (typeof call.args.to === 'number' ? call.args.to : '')}`
        }
        meta={
          result.saved !== undefined ? `${result.saved.toLocaleString()} tokens saved` : undefined
        }
      />
      {(call.status === 'error' ||
        malformed ||
        listing ||
        result.summary ||
        result.restored !== undefined) && (
        <ToolContent>
          {call.status === 'error' || malformed ? (
            <ToolOutput isError output={call.output} />
          ) : (
            <ToolSection>
              {listing ? (
                <div className="space-y-1 text-xs">
                  {result.turns?.map((turn) => (
                    <div className="flex gap-3" key={turn.id}>
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {turn.fromEntry}–{turn.toEntry} · {turn.tokens.toLocaleString()} tokens
                        {turn.compressed ? ` · ${turn.compressed}` : ''}
                      </span>
                      <span className="truncate">{turn.gist}</span>
                    </div>
                  ))}
                  {result.turns?.length === 0 && (
                    <p className="text-muted-foreground">No turns outside the protect window.</p>
                  )}
                  {result.ranges?.map((range) => (
                    <p className="font-mono text-muted-foreground" key={range.id}>
                      {range.id} · {range.fromEntry}–{range.toEntry}
                    </p>
                  ))}
                </div>
              ) : result.summary ? (
                <p className="whitespace-pre-wrap font-sans text-sm text-foreground/80">
                  {result.summary}
                </p>
              ) : result.restored !== undefined ? (
                <p className="font-sans text-sm text-muted-foreground">
                  {result.restored
                    ? `Original turns ${result.from}–${result.to} return on the next request`
                    : result.reason}
                </p>
              ) : null}
            </ToolSection>
          )}
        </ToolContent>
      )}
    </Tool>
  )
}
export default defineWebExtension({
  tools: { context_ranges: Compression, compress: Compression, decompress: Compression },
})
