import { CheckIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { ReplyQuestions } from './card.tsx'
import type { Answers } from './types.ts'

function AnswerCard({ entry }: { entry: EntryRecord }) {
  const data = entry.data as Answers
  return (
    <section
      className="rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20"
      data-questions-answers={entry.id}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <CheckIcon className="size-3.5 text-brand" />
        Your answers
      </header>
      <div className="space-y-3 px-3 py-3 text-sm">
        {data.answers.map((a, i) => (
          <div key={i}>
            <p className="mb-1 text-xs text-muted-foreground">{a.question}</p>
            <p className="whitespace-pre-wrap text-foreground">{a.answer}</p>
          </div>
        ))}
        {data.note && (
          <div className="border-t border-border pt-2">
            <p className="mb-1 font-mono text-[10px] text-muted-foreground">Note</p>
            <p className="whitespace-pre-wrap">{data.note}</p>
          </div>
        )}
      </div>
    </section>
  )
}

export default defineWebExtension({
  // Stored transcript cards from before stay hidden and never answerable; @ultimate's current answer gets the card.
  entries: {
    'pi.assistant': ReplyQuestions,
    'questions.asked': () => null,
    'questions.answers': AnswerCard,
  },
})
