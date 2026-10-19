import { CheckIcon, ChevronRightIcon } from 'lucide-react'
import { cn, useDocOf, useNow, useUltimate } from '@/sdk'
import { accentOf, Address, BoardDoc, emptyBoard, MessageBody, relativeTime } from '../board/ui.tsx'
import { MessageQuestions } from './card.tsx'
import { openQuestions, waiting } from './open.tsx'
import { QuestionsDoc } from './refs.ts'

/**
 * Every question that waits on you, newest first, wherever you are: the asker, when it asked, its message and its answer
 * card with Dismiss. A question leaves only when you answer or dismiss it.
 */
export function OpenQuestions() {
  const messages = waiting((useDocOf(1, BoardDoc) ?? emptyBoard).messages)
  const extracted = useDocOf(1, QuestionsDoc)
  const now = useNow(60_000)
  const { switchConversation, showSurface } = useUltimate()
  return (
    <div className="py-2" data-open-questions>
      <div className="flex items-center gap-2 px-3 pb-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Questions
        <span className="ml-auto tracking-normal normal-case text-muted-foreground/70">
          {messages.length ? `${messages.length} waiting on you` : 'none open'}
        </span>
      </div>
      {messages.length === 0 && (
        <p className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5 text-success" />
          Nothing waits on you. New questions stay here until you answer or dismiss them.
        </p>
      )}
      <div className="flex flex-col gap-3 px-2">
        {messages.map((message) => {
          const accent = accentOf(message.from)
          return (
            <section
              key={message.id}
              data-open-question={message.id}
              className={cn(
                'min-w-0 rounded-md border border-l-2 border-border',
                accent.left,
                accent.fill,
              )}
            >
              <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                <span className={cn('flex min-w-0 font-semibold', accent.name)}>
                  <Address id={message.from} mark />
                </span>
                <time
                  dateTime={new Date(message.at).toISOString()}
                  title={new Date(message.at).toLocaleString()}
                >
                  asked {relativeTime(message.at, now)}
                  {relativeTime(message.at, now) === 'now' ? '' : ' ago'}
                </time>
                {typeof message.from === 'number' && (
                  <button
                    className="ml-auto cursor-pointer hover:text-foreground"
                    onClick={() => {
                      showSurface('agent')
                      switchConversation(message.from as number)
                    }}
                    type="button"
                  >
                    Open chat
                  </button>
                )}
              </header>
              {/* Extracted questions read on their own; the full message stays one click away. */}
              {openQuestions(extracted, message).length === 0 ? (
                <MessageBody text={message.text} />
              ) : (
                <details className="group/full border-b border-border/60">
                  <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground">
                    <ChevronRightIcon className="size-3 transition-transform group-open/full:rotate-90" />
                    Full message
                  </summary>
                  <MessageBody text={message.text} />
                </details>
              )}
              <MessageQuestions
                message={message}
                keys={false}
                {...(openQuestions(extracted, message).length ? { className: '' } : {})}
              />
            </section>
          )
        })}
      </div>
    </div>
  )
}
