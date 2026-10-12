import type { EntryId } from '@earendil-works/pi-durable'

export type AssessmentValue = 'needs_input' | 'done' | 'neutral'
export type Assessment = { inputId: EntryId; answerId: EntryId; value: AssessmentValue }
export type OverviewRow = {
  runState: 'working' | 'queued' | 'idle' | 'done' | 'error'
  inputId?: number
  answerId?: number
  summary?: string
  summaryStatus?: 'pending' | 'ready' | 'error'
  activity?: string
  assessment?: Assessment
  assessmentStatus?: 'pending' | 'ready' | 'error'
}
export type OverviewState = { conversations: Record<string, OverviewRow> }
