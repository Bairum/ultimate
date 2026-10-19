import { CheckIcon, MessageCircleQuestionIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api, cn, errorMessage, useConversation, useDocOf, useViewport } from '@/sdk'
import { BoardDoc } from '../board/ui.tsx'
import { keyCard, openQuestions } from './open.tsx'
import type { Message } from './open.tsx'
import { AnswerAction, DismissAction, QuestionsDoc } from './refs.ts'
import type { Answer } from './refs.ts'
import type { Question } from './types.ts'

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
  const board = useDocOf(1, QuestionsDoc)
  const messages = useDocOf(1, BoardDoc)?.messages ?? []
  const conversation = useConversation((value) => value.id)
  return keyCard(board, conversation, messages) === card
}

/**
 * The answer card of a message that waits on the user: its extracted questions, or only Dismiss while none were
 * extracted. `keys` (default: the shown conversation decides) whether it takes the desktop 1–9 and Enter keys.
 */
export function MessageQuestions({
  message,
  keys,
  className,
}: {
  message: Message
  keys?: boolean
  className?: string
}) {
  const questions = openQuestions(useDocOf(1, QuestionsDoc), message)
  const card = `message:${message.id}`
  const shown = useKeys(card)
  if (message.to !== 'user' || !message.reply || message.state !== 'delivered') return null
  return (
    <Card
      card={card}
      questions={questions}
      keys={questions.length > 0 && (keys ?? shown)}
      submit={(answers) => api.action(AnswerAction, { messageId: message.id, answers })}
      reply={(text) => api.action(AnswerAction, { messageId: message.id, text })}
      dismiss={() => api.action(DismissAction, { messageId: message.id })}
      {...(className === undefined ? {} : { className })}
    />
  )
}

function Card({
  card,
  questions,
  keys,
  submit,
  reply,
  dismiss,
  className = 'border-t border-border/60',
}: {
  card: string
  questions: Question[]
  keys: boolean
  submit: (answers: Answer[]) => Promise<unknown>
  reply: (text: string) => Promise<unknown>
  dismiss: () => Promise<unknown>
  className?: string
}) {
  const [text, setText] = useState('')
  const root = useRef<HTMLDivElement>(null)
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
  const run = async (action: () => Promise<unknown>) => {
    if (sending) return
    setSending(true)
    setError(undefined)
    try {
      await action()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSending(false)
    }
  }
  const send = () => (answered.length ? run(() => submit(answered)) : Promise.resolve())
  useEffect(() => {
    if (!keys || phone || sending) return undefined
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        // Outside this card, another card, a control or the Questions panel keeps its own keys.
        (!root.current?.contains(target) &&
          target?.closest('[data-questions-card], [data-open-questions], button, a'))
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
  // Nothing extracted to answer with buttons: a reply field for this message, and Dismiss.
  if (!questions.length)
    return (
      <form
        className={cn(className, 'flex flex-wrap items-center gap-2 px-3 py-2')}
        data-questions-card={card}
        onSubmit={(event) => {
          event.preventDefault()
          if (text.trim()) void run(() => reply(text.trim()))
        }}
      >
        <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-brand" />
        <input
          aria-label="Your answer"
          placeholder="Your answer…"
          value={text}
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          className="min-h-8 min-w-0 flex-1 basis-40 rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-brand/60"
        />
        <Button
          variant="ghost"
          size="xs"
          type="button"
          disabled={sending}
          onClick={() => void run(dismiss)}
          title="Close it without an answer; the agent gets a note"
        >
          Dismiss
        </Button>
        <Button size="xs" type="submit" disabled={!text.trim() || sending}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
        {error && (
          <p role="alert" className="w-full text-xs text-error">
            {error}
          </p>
        )}
      </form>
    )
  return (
    <div className={className} data-questions-card={card} ref={root}>
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
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-2">
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
              <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
                {current + 1}/{questions.length}
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
            variant="ghost"
            size={phone ? 'xs' : 'sm'}
            disabled={sending}
            onClick={() => void run(dismiss)}
            title="Close it without an answer; the agent gets a note"
          >
            Dismiss
          </Button>
          <Button size="sm" disabled={!answered.length || sending} onClick={() => void send()}>
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
