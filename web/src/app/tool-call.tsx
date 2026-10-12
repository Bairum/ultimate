import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolImages,
  ToolInput,
  ToolOutput,
} from '@/components/ai/tool'
import { useExtensions, useToolDuration } from '../sdk/hooks.ts'
import { rendererFor } from '../sdk/registry.ts'
import type { ToolCallView } from '../sdk/types.ts'
import { ExtensionBoundary } from './boundary.tsx'

/** A tool call through its extension renderer, or the generic one. */
export function ToolCallBlock({ call }: { call: ToolCallView }) {
  const renderer = rendererFor(useExtensions(), 'tools', call.name)
  const Renderer = renderer?.component
  return (
    <div className="empty:hidden" data-tool-call-id={call.id}>
      {renderer && Renderer ? (
        <ExtensionBoundary
          extension={renderer.extension}
          key={renderer.extension}
          fallback={<GenericToolCall call={call} />}
          version={renderer.version}
        >
          <Renderer call={call} />
        </ExtensionBoundary>
      ) : (
        <GenericToolCall call={call} />
      )}
    </div>
  )
}

function summary(args: ToolCallView['args']): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}

/** Name, arguments, output, and diagnostics of any tool. */
export function GenericToolCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  return (
    <Tool defaultOpen={call.status === 'error' || call.images.length > 0}>
      <ToolHeader meta={duration} name={call.name} state={call.status} title={summary(call.args)} />
      <ToolContent>
        <ToolInput input={call.args} />
        <ToolOutput isError={call.status === 'error'} output={call.output} />
        <ToolImages images={call.images} />
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}
