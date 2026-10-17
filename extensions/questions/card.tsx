import { CheckIcon, MessageCircleQuestionIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { api, cn, errorMessage, useConversation, useDocOf, useTranscript, useViewport } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { keyCard, openQuestions, replyQuestions } from './open.tsx'
import type { Message, QuestionsBoard } from './open.tsx'
import type { Question } from './types.ts'

type Answer = { question: string; answer: string }

function options(question: Question) {
  return [
    ...(question.kind === 'confirm'
      ? [{ label: 'Yes' }, { label: 'No' }]
      : (question.options ?? [])),
    { label: 'Something else…', custom: true },
  ]
}

/** Whether `card` is the one on the shown conversation's page that takes the desktop 1–9 and Enter keys. */
function useKeys(card: string) {
  const board = useDocOf<QuestionsBoard>(1, 'questions.board')
  const messages = useDocOf<{ messages: Message[] }>(1, 'board')?.messages ?? []
  const conversation = useConversation((value) => value.id)
  return keyCard(board, conversation, messages, useTranscript()) === card
}

/** The answer card under an open message to the user; renders nothing without extracted questions. */
export function MessageQuestions({ message }: { message: Message }) {
  const questions = openQuestions(useDocOf<QuestionsBoard>(1, 'questions.board'), message)
  const card = `message:${message.id}`
  const keys = useKeys(card)
  if (!questions.length) return null
  return (
    <Card
      card={card}
      questions={questions}
      keys={keys}
      submit={(answers) => api.action('questions', 'answer', { messageId: message.id, answers })}
    />
  )
}

/** A final answer, followed by the answer card for its questions while it is @ultimate's current answer. */
export function ReplyQuestions({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const conversation = useConversation((value) => value.id)
  const questions = replyQuestions(
    useDocOf<QuestionsBoard>(1, 'questions.board'),
    conversation,
    entry.id,
    useTranscript(),
  )
  const card = `reply:${entry.id}`
  const keys = useKeys(card)
  if (!questions.length) return core
  return (
    <div className="flex flex-col gap-3">
      {core}
      <section className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20">
        <Card
          card={card}
          questions={questions}
          keys={keys}
          className=""
          submit={(answers) => api.action('questions', 'reply', { entryId: entry.id, answers })}
        />
      </section>
    </div>
  )
}

function Card({
  card,
  questions,
  keys,
  submit,
  className = 'border-t border-border/60',
}: {
  card: string
  questions: Question[]
  keys: boolean
  submit: (answers: Answer[]) => Promise<unknown>
  className?: string
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [custom, setCustom] = useState<Record<number, boolean>>({})
  const [current, setCurrent] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const phone = useViewport() === 'phone'
  const answered = questions.flatMap((q, i) =>
    answers[i]?.trim() ? [{ question: q.text, answer: answers[i].trim() }] : [],
  )
  const select = (index: number, option: number) => {
    const value = options(questions[index])[option]
    if (!value) return
    const other = 'custom' in value
    setCustom((old) => ({ ...old, [index]: other }))
    setAnswers((old) => ({ ...old, [index]: other ? '' : value.label }))
    setCurrent(index)
  }
  const send = async () => {
    if (!answered.length || sending) return
    setSending(true)
    setError(undefined)
    try {
      await submit(answered)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSending(false)
    }
  }
  useEffect(() => {
    if (!keys || phone || sending) return undefined
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]')
      )
        return
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault()
        select(current, Number(event.key) - 1)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (current < questions.length - 1) setCurrent(current + 1)
        else void send()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  return (
    <div className={className} data-questions-card={card}>
      <div className="flex items-center gap-2 px-3 pt-2 font-mono text-[11px] text-muted-foreground">
        <MessageCircleQuestionIcon className="size-3.5 text-brand" />
        <span className="text-foreground">
          {questions.length} {questions.length === 1 ? 'question' : 'questions'}
        </span>
        <span>· Answer what you can</span>
      </div>
      <div className="space-y-3 px-3 pt-2 pb-3">
        {questions.map(
          (question, index) =>
            (!phone || index === current) && (
              <fieldset
                key={index}
                disabled={sending}
                onFocus={() => setCurrent(index)}
                className="min-w-0 space-y-2"
              >
                <legend className="mb-2 text-[13px] leading-relaxed text-foreground">
                  {!phone && (
                    <span className="mr-2 font-mono text-[11px] text-muted-foreground">
                      {index + 1}.
                    </span>
                  )}
                  {question.text}
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {options(question).map((option, number) => {
                    const other = 'custom' in option
                    const chosen = other
                      ? custom[index]
                      : !custom[index] && answers[index] === option.label
                    return (
                      <button
                        key={number}
                        type="button"
                        aria-pressed={chosen}
                        onClick={() => select(index, number)}
                        className={cn(
                          'flex min-h-9 cursor-pointer items-center gap-2 rounded border px-3 py-2 text-left text-xs transition-colors max-md:min-h-11 max-md:w-full',
                          chosen
                            ? 'border-brand/60 bg-brand/10 text-foreground'
                            : 'border-border bg-background/40 text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        <span className="font-mono text-[10px] opacity-60">{number + 1}</span>
                        <span>
                          <span>{option.label}</span>
                          {'detail' in option && option.detail && (
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                              {option.detail}
                            </span>
                          )}
                        </span>
                        {'recommended' in option && option.recommended && (
                          <span className="ml-1 font-mono text-[9px] text-brand">recommended</span>
                        )}
                        {chosen && <CheckIcon className="ml-auto size-3 shrink-0 text-brand" />}
                      </button>
                    )
                  })}
                </div>
                {custom[index] && (
                  <input
                    aria-label={`Your answer to question ${index + 1}`}
                    placeholder="Your answer…"
                    value={answers[index] ?? ''}
                    onChange={(event) =>
                      setAnswers((old) => ({ ...old, [index]: event.target.value }))
                    }
                    className="min-h-11 w-full rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-brand/60"
                  />
                )}
              </fieldset>
            ),
        )}
        <div className="flex items-center gap-2 border-t border-border/60 pt-2">
          {phone ? (
            <>
              <Button
                variant="ghost"
                size="xs"
                disabled={current === 0}
                onClick={() => setCurrent(current - 1)}
              >
                Back
              </Button>
              <span className="font-mono text-[10px] text-muted-foreground">
                {current + 1} of {questions.length}
              </span>
              {current < questions.length - 1 && (
                <Button variant="ghost" size="xs" onClick={() => setCurrent(current + 1)}>
                  Next
                </Button>
              )}
            </>
          ) : (
            keys && (
              <span className="font-mono text-[10px] text-muted-foreground">
                1–9 choose · Enter next / send
              </span>
            )
          )}
          <Button
            className="ml-auto"
            size="sm"
            disabled={!answered.length || sending}
            onClick={() => void send()}
          >
            {sending ? 'Sending…' : 'Send answers'}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
