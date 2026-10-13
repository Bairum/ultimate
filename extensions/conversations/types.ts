import type { EntryId } from '@earendil-works/pi-durable'

export type IntentSummary = { summary: string; at: number }

export type TitleChange = { title: string; at: number }

export type AssessmentValue = 'needs_input' | 'done' | 'neutral'
export type Assessment = { inputId: EntryId; answerId: EntryId; value: AssessmentValue }
/** `stale`: newer work or a reset superseded the result; `error`: the request failed. */
export type SummaryStatus = 'pending' | 'ready' | 'stale' | 'error'
export type Assessed = Assessment & { activity: string; model?: string; at: number }
export type SummaryDiscard = { reason: 'stale' | 'error'; cause: string; at: number }
export type OverviewRow = {
  /** `answered`: the latest input got a reply; whether its goal is met is the assessment's opinion. */
  runState: 'working' | 'queued' | 'idle' | 'answered' | 'error'
  inputId?: number
  answerId?: number
  summary?: string
  summaryStatus?: SummaryStatus
  activity?: string
  assessment?: Assessment
  assessmentStatus?: SummaryStatus
}
export type OverviewState = { conversations: Record<string, OverviewRow> }
