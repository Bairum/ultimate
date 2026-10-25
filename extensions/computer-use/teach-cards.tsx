/**
 * `computer_teach` in the transcript, the teaching document in the Documents tab, and the Teach section of the
 * Computer session view. The newest draft call carries the live review; the newest practice or check call carries the
 * live practice ladder; older calls show what they returned.
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
import { SessionDoc, TeachDoc } from './refs.ts'
import type { Teach } from './refs.ts'
import { PracticeRun } from './practice-cards.tsx'
import type { TeachDetails } from './practice-cards.tsx'
import { Requests } from './requests.tsx'
import {
  detailsOf,
  headerState,
  Mark,
  refusalText,
  ScreenMark,
  toneOf,
  useSession,
} from './shared.tsx'
import { live, TeachStrip, teachDialog } from './teach-live.tsx'
import { shown, StepFields, TeachReview } from './teach-review.tsx'

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const wrap = (value: string) => ({ text: value, untrusted: true as const })

/**
 * The live document's practice in the `teachDetails` shape (`teach.ts`), so the ladder renders a result's details and
 * the live run alike. Mirrors the server's mapping; change both together.
 */
export function practiceDetails(doc: Teach): TeachDetails | undefined {
  const practice = doc.practice
  if (!practice) return undefined
  return {
    status: practice.status === 'mismatch' ? 'mismatch' : 'practice',
    frames: Object.keys(practice.frames).length,
    dropped: {},
    practice: {
      task: practice.task,
      skill: practice.skill,
      scope: practice.scope,
      status: practice.status,
      title: wrap(practice.title),
      app: wrap(practice.app),
      window: { id: practice.window.id, titleSubstring: wrap(practice.window.titleSubstring) },
      checks: practice.checks.map(({ step, phase, at, frame }) => ({ step, phase, at, frame })),
      final: practice.final?.frame,
    },
    mismatches: doc.mismatches?.map((m) => ({
      step: m.step,
      phase: m.phase,
      at: m.at,
      expected: m.expected.map(wrap),
      seen: m.seen.map(wrap),
      taught: m.taught,
      fresh: { id: m.fresh.id, width: m.fresh.width, height: m.fresh.height, file: m.fresh.file },
    })),
    steps: practice.steps.map(shown),
  }
}

/** Whether `call` is the newest `computer_teach` call with one of `actions` in this transcript. */
function useNewest(call: ToolCallView, actions: readonly string[]) {
  const entries = useTranscript()
  for (const entry of entries.toReversed()) {
    for (const message of entry.model ?? []) {
      if (message.role !== 'assistant') continue
      for (const block of message.content.toReversed())
        if (
          block.type === 'toolCall' &&
          block.name === 'computer_teach' &&
          actions.includes(text(block.arguments.action))
        )
          return block.id === call.id
    }
  }
  return false
}

/** A practice or check call: the live ladder while it is the newest one of its run, else what it returned. */
function PracticeCall({ call }: { call: ToolCallView }) {
  const { id, session } = useSession()
  const teach = useDoc(TeachDoc)
  const newest = useNewest(call, ['practice', 'check'])
  const details = detailsOf(call)
  const own = details?.teach
  const current = teach ? practiceDetails(teach) : undefined
  const shownRun =
    newest && current && (!own?.practice || own.practice.task === current.practice?.task)
      ? current
      : own
  const status = details?.status
  if (!shownRun?.practice) {
    const tone = toneOf(status)
    return (
      <Tool defaultOpen={!!status && tone !== 'good'}>
        <ToolHeader
          meta={
            status && (
              <span className={tone === 'bad' ? 'text-error' : 'text-warning'}>
                {refusalText(status)}
              </span>
            )
          }
          name={`teach · ${text(call.args.action)}`}
          state={headerState(call.status, tone)}
          title={text(call.args.skill)}
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
  const waiting =
    newest &&
    session?.task?.status === 'awaiting_confirmation' &&
    session.task.spec.id === shownRun.practice.task
  return (
    <div className="space-y-2">
      {waiting && id !== undefined && (
        <Requests
          conversation={id}
          only={(request) => request.kind === 'task'}
          reasons={['practice run of a saved lesson']}
          session={session}
        />
      )}
      <PracticeRun
        conversation={newest ? id : undefined}
        header={<GraduationCapIcon className="size-3.5 text-brand" />}
        pending={waiting}
        teach={shownRun}
      />
    </div>
  )
}

export function TeachCall({ call }: { call: ToolCallView }) {
  const action = text(call.args.action)
  if (action === 'practice' || action === 'check') return <PracticeCall call={call} />
  return <TeachStep call={call} />
}

function TeachStep({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { conversationId } = useUltimate()
  const teach = useDoc(TeachDoc)
  const newest = useNewest(call, ['draft'])
  const details = detailsOf(call)
  const action = text(call.args.action)
  const status = details?.status
  const summary = details?.teach
  const steps = Array.isArray(call.args.steps) ? call.args.steps.length : 0
  // The newest draft carries the live, editable review from the document; an older draft shows the steps it
  // produced, read-only, from its own `details.teach` (`teachDetails`, every string `UntrustedText`).
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
        {action === 'draft' && summary && summary.steps.length > 0 && (
          <ToolSection>
            <ol className="space-y-2">
              {summary.steps.map((step) => (
                <li className="space-y-0.5" key={step.n}>
                  <div className="flex items-baseline gap-2">
                    <Mark
                      outcome={
                        step.approved === true
                          ? 'delivered'
                          : step.approved === false
                            ? 'refused'
                            : 'not_run'
                      }
                    />
                    <span className="w-4 text-right text-muted-foreground">{step.n}</span>
                    <span className="min-w-0 break-words">
                      <span className="text-muted-foreground">{step.action}</span> “
                      {step.label.text}”<ScreenMark />
                      {step.consequential && (
                        <span className="ml-2 text-warning">consequential</span>
                      )}
                    </span>
                  </div>
                  <div className="pl-11">
                    <StepFields step={step} />
                  </div>
                </li>
              ))}
            </ol>
          </ToolSection>
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

/** The teaching document of a conversation: its live strip, the review or outcome, and a practice run's ladder. */
function TeachState({ teach, conversation }: { teach: Teach; conversation: number }) {
  const segment = teach.segment
  const now = useNow(1000, live(segment))
  const practice = practiceDetails(teach)
  const task = useDocOf(conversation, SessionDoc)?.task
  if (!segment && !practice) return null
  const strip = !!segment && (live(segment) || segment.status === 'drafting')
  const pending = task?.status === 'awaiting_confirmation' && task.spec.id === teach.practice?.task
  return (
    <div className="space-y-2">
      {strip && (
        <TeachStrip conversation={conversation} now={now} segment={segment} steps={teach.steps} />
      )}
      {segment && <TeachReview conversation={conversation} teach={teach} />}
      {practice && <PracticeRun conversation={conversation} pending={pending} teach={practice} />}
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
      {teach && ((segment && !['saved', 'rejected'].includes(segment.status)) || teach.practice) ? (
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
