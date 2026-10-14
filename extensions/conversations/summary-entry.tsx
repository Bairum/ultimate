import { PencilIcon } from 'lucide-react'
import { formatTime } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { Assessed, IntentSummary, SpawnSummary, SummaryDiscard, TitleChange } from './types.ts'

const assessmentLabel = { needs_input: 'may need input', done: 'Done', neutral: 'neutral' }

/** What a summary task concluded, as one quiet line; each entry traces to its task by `byTaskId`. */
function summaryText(entry: EntryRecord) {
  switch (entry.kind) {
    case 'conversations.intent-summarized':
      return `Intent: ${(entry.data as IntentSummary).summary}`
    case 'conversations.title-changed':
      return `Title changed to “${(entry.data as TitleChange).title}”`
    case 'conversations.summarized':
      return `Summary: ${(entry.data as SpawnSummary).summary}`
    case 'conversations.assessed': {
      const data = entry.data as Assessed
      return `Assessed: ${assessmentLabel[data.value]} (summary model's opinion) · ${data.activity}`
    }
    default: {
      const data = entry.data as SummaryDiscard
      return data.reason === 'stale'
        ? 'Summary superseded by newer work'
        : `Summary unavailable: ${data.cause}`
    }
  }
}

export function SummaryAction({ entry }: { entry: EntryRecord }) {
  const text = summaryText(entry)
  const date = new Date((entry.data as { at: number }).at)
  return (
    <div className="flex items-baseline gap-2 font-mono text-[11px] text-muted-foreground">
      <PencilIcon aria-hidden className="size-3 shrink-0 self-center" />
      <span className="min-w-0 break-words">{text}</span>
      <time
        className="shrink-0 text-muted-foreground/70"
        dateTime={date.toISOString()}
        title={date.toLocaleString()}
      >
        {formatTime(date)}
      </time>
    </div>
  )
}
