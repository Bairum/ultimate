import { RedoIcon } from 'lucide-react'
import { defineWebExtension, Fold } from '@/sdk'
import type { ContinuedEntry } from './refs.ts'

export default defineWebExtension({
  entries: {
    'stop-check.continued': function ContinuedCard({ entry }) {
      const data = entry.data as ContinuedEntry
      const line = 'Continued: the turn ended on a promise of more work'
      return (
        <Fold
          card={entry.id}
          summary={
            <>
              <RedoIcon className="size-3 shrink-0" />
              <span className="truncate">{line}</span>
            </>
          }
        >
          <section
            className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/60 bg-muted/20"
            data-stop-check
          >
            <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
              <RedoIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate text-foreground">{line}</span>
              <span className="ml-auto shrink-0" title="Probability of an unexpected stop">
                p {data.p.toFixed(2)}
              </span>
            </header>
            <blockquote className="border-l-2 border-border/70 mx-3 my-2.5 pl-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {data.excerpt}
            </blockquote>
          </section>
        </Fold>
      )
    },
  },
})
