/**
 * `computer_teach` in the transcript, the teaching document in the Documents tab, and the Teach section of the
 * Computer session view. The newest draft call carries the live review; older calls and `frames` are one line.
 */
import { GraduationCapIcon } from 'lucide-react'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { useDoc, useDocOf, useNow, useToolDuration, useTranscript, useUltimate } from '@/sdk'
import type { DocumentProps, ToolCallView } from '@/sdk'
import { TeachDoc } from './refs.ts'
import type { Teach } from './refs.ts'
import { detailsOf, headerState, refusalText, toneOf } from './shared.tsx'
import { live, TeachStrip, teachDialog } from './teach-live.tsx'
import { TeachReview } from './teach-review.tsx'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** Whether `call` is the newest `computer_teach` draft in this transcript: only that one carries the review. */
function useNewestDraft(call: ToolCallView) {
  const entries = useTranscript()
  for (const entry of entries.toReversed()) {
    for (const message of entry.model ?? []) {
      if (message.role !== 'assistant') continue
      for (const block of message.content.toReversed())
        if (
          block.type === 'toolCall' &&
          block.name === 'computer_teach' &&
          block.arguments.action === 'draft'
        )
          return block.id === call.id
    }
  }
  return false
}

export function TeachCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { conversationId } = useUltimate()
  const teach = useDoc(TeachDoc)
  const newest = useNewestDraft(call)
  const details = detailsOf(call)
  const action = text(call.args.action)
  const status = details?.status
  const summary = details?.teach
  const steps = Array.isArray(call.args.steps) ? call.args.steps.length : 0
  // teachDetails: the result's `details.teach` names what this call produced; the live review reads the document.
  if (
    action === 'draft' &&
    newest &&
    status === 'review' &&
    teach?.segment &&
    conversationId !== undefined
  )
    return <TeachReview conversation={conversationId} teach={teach} />
  const tone = toneOf(status === 'review' ? 'ok' : status)
  return (
    <Tool>
      <ToolHeader
        meta={
          <>
            {status && status !== 'review' && (
              <span className="text-warning">{refusalText(status)}</span>
            )}
            {summary && action === 'frames' && <span>{summary.frames} frames</span>}
            {action === 'draft' && steps > 0 && <span>{steps} steps</span>}
            {duration && <span>{duration}</span>}
          </>
        }
        name={`teach · ${action || '…'}`}
        state={headerState(call.status, tone)}
        title={
          action === 'frames'
            ? 'read the recorded frames'
            : action === 'draft'
              ? newest
                ? 'drafted the procedure'
                : 'earlier draft'
              : ''
        }
      />
      <ToolContent>
        {details?.message && (
          <ToolSection className="text-muted-foreground">{details.message}</ToolSection>
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

/** The teaching document of a conversation: its live strip, then the review or outcome. */
function TeachState({ teach, conversation }: { teach: Teach; conversation: number }) {
  const segment = teach.segment
  const now = useNow(1000, live(segment))
  if (!segment) return null
  const strip = live(segment) || segment.status === 'drafting'
  return (
    <div className="space-y-2">
      {strip && (
        <TeachStrip conversation={conversation} now={now} segment={segment} steps={teach.steps} />
      )}
      <TeachReview conversation={conversation} teach={teach} />
    </div>
  )
}

export function TeachDocument({ value, conversationId }: DocumentProps) {
  return <TeachState conversation={conversationId} teach={value} />
}

/** The session view's Teach section: what is recording or waiting for review, or the way to start a lesson. */
export function TeachSection({ conversation }: { conversation: number }) {
  const teach = useDocOf(conversation, TeachDoc)
  const { open } = useUltimate()
  const segment = teach?.segment
  return (
    <div className="space-y-2">
      {teach && segment && !['saved', 'rejected'].includes(segment.status) ? (
        <TeachState conversation={conversation} teach={teach} />
      ) : (
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-muted-foreground">
            {segment?.status === 'saved' && teach?.saved
              ? `Saved “${segment.title}” as a skill.`
              : 'Show the agent a procedure once; it watches, then drafts the steps.'}
          </p>
          <Button
            className="h-7 gap-1.5 px-2 font-sans text-[12px]"
            data-teach-open
            onClick={() => open(teachDialog)}
            size="sm"
            variant="outline"
          >
            <GraduationCapIcon className="size-3" />
            Teach…
          </Button>
        </div>
      )}
    </div>
  )
}
