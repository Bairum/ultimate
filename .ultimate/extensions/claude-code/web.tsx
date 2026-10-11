import { Message, MessageResponse } from '@/components/ai/message'
import { Shimmer } from '@/components/ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { defineWebExtension, formatDuration, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const list = (value: unknown) =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string').join(', ') : text(value)

type Details = {
  model?: string
  sessionId?: string
  activity?: string
  numTurns?: number
  costUsd?: number
  durationMs?: number
  subtype?: string
  permissionDenials?: number
}

function ClaudeCodeCall({ call }: { call: ToolCallView }) {
  const elapsed = useToolDuration(call)
  const details = call.details as Details | undefined
  const requestedModel = text(call.args.model) || 'opus'
  const model = details?.model || requestedModel
  const duration =
    elapsed ?? (details?.durationMs !== undefined ? formatDuration(details.durationMs) : undefined)
  const prompt = text(call.args.prompt)
  const working = ['streaming', 'pending', 'running'].includes(call.status)
  const failed = call.status === 'error'
  const interrupted = call.status === 'interrupted'
  const options = [
    ['Budget', typeof call.args.maxBudgetUsd === 'number' ? `$${call.args.maxBudgetUsd}` : ''],
    ['Effort', text(call.args.effort)],
    ['Agent', text(call.args.agent)],
    ['Tools', list(call.args.tools)],
    ['Allowed tools', list(call.args.allowedTools)],
    ['Permission mode', text(call.args.permissionMode)],
  ].filter(([, value]) => value)
  return (
    <Tool defaultOpen={call.status !== 'done'}>
      <ToolHeader
        className="cursor-pointer"
        meta={
          <>
            <span title={model !== requestedModel ? `Requested: ${requestedModel}` : undefined}>
              {model}
            </span>
            {duration && <span>{duration}</span>}
          </>
        }
        name="Claude Code"
        state={call.status}
        title={<>external subagent{prompt && ` · ${prompt}`}</>}
      />
      <ToolContent>
        {prompt && (
          <ToolSection label="Task">
            <p className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {prompt}
            </p>
          </ToolSection>
        )}
        <ToolSection label="Configuration">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words text-muted-foreground">
            <dt>Model</dt>
            <dd>{requestedModel}</dd>
            <dt>Limits</dt>
            <dd>
              {typeof call.args.maxTurns === 'number' ? call.args.maxTurns : 10} turns ·{' '}
              {typeof call.args.timeoutSeconds === 'number' ? call.args.timeoutSeconds : 300}s
              timeout
            </dd>
            {options.map(([label, value]) => (
              <div className="contents" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </ToolSection>
        {working && (
          <ToolSection label="Activity">
            <Shimmer className="text-[12px]">
              {details?.activity ||
                (call.status === 'running'
                  ? 'Claude Code is working…'
                  : call.status === 'pending'
                    ? 'queued…'
                    : 'writing task…')}
            </Shimmer>
          </ToolSection>
        )}
        {(failed || interrupted) && (
          <ToolSection>
            <p className={failed ? 'text-error' : 'text-warning'}>
              {failed
                ? 'Claude Code failed.'
                : 'Claude Code was interrupted; the task may be incomplete.'}
              {details?.subtype && ` (${details.subtype})`}
            </p>
          </ToolSection>
        )}
        {(details?.permissionDenials ?? 0) > 0 && (
          <ToolSection>
            <p className="text-warning">
              {details!.permissionDenials} permission denial
              {details!.permissionDenials === 1 ? '' : 's'} · some actions were not allowed.
            </p>
          </ToolSection>
        )}
        {call.status === 'done' && call.output && (
          <ToolSection label="Answer">
            <Message className="font-sans text-[13px]" from="assistant">
              <MessageResponse mode="static">{call.output}</MessageResponse>
            </Message>
          </ToolSection>
        )}
        {(failed || interrupted) && <ToolOutput isError={failed} output={call.output} />}
        {(details?.sessionId ||
          details?.numTurns !== undefined ||
          details?.costUsd !== undefined) && (
          <ToolSection label="Run">
            <div className="flex flex-wrap gap-x-3 gap-y-1 break-all text-muted-foreground">
              {details?.numTurns !== undefined && <span>{details.numTurns} turns</span>}
              {details?.costUsd !== undefined && <span>${details.costUsd.toFixed(4)}</span>}
              {details?.sessionId && <span>session {details.sessionId}</span>}
            </div>
          </ToolSection>
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({ tools: { claude_code: ClaudeCodeCall } })
