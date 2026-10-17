import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  useComposer,
  useConversation,
  useTranscript,
  useUiState,
  useViewport,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { Asked, Answers, Question } from './types.ts'

const input = (entry: EntryRecord) => entry.kind === 'pi.user' || entry.input === true
const column = (dock?: boolean) =>
  dock ? 'w-full px-4' : 'mx-auto w-full max-w-[46rem] px-3 sm:px-6'

function QuestionsComposer({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const transcript = useTranscript()
  const { busy, id } = useConversation()
  const latest = transcript.findLast(
    (entry) => input(entry) || entry.kind === 'questions.asked' || entry.kind === 'pi.reset',
  )
  return (
    <>
      {!busy && latest?.kind === 'questions.asked' && (
        <QuestionCard key={latest.id} entry={latest} conversationId={id!} dock={dock} />
      )}
      {core}
    </>
  )
}

function options(question: Question) {
  return [
    ...(question.kind === 'confirm'
      ? [{ label: 'Yes' }, { label: 'No' }]
      : (question.options ?? [])),
    { label: 'Something else…', custom: true },
  ]
}

function QuestionCard({
  entry,
  conversationId,
  dock,
}: {
  entry: EntryRecord
  conversationId: number
  dock?: boolean
}) {
  const { questions } = entry.data as Asked
  const [collapsed, setCollapsed] = useUiState(`questions.collapsed.${entry.id}`, false)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [custom, setCustom] = useState<Record<number, boolean>>({})
  const [current, setCurrent] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const { draft } = useComposer()
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
    const snapshot = draft?.read()
    setSending(true)
    setError(undefined)
    try {
      await api.action(
        'questions',
        'answer',
        {
          askedId: entry.id,
          answers: answered,
          ...(snapshot?.text.trim() ? { note: snapshot.text.trim() } : {}),
        },
        { conversationId },
      )
      if (snapshot) draft?.clear(snapshot)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSending(false)
    }
  }
  useEffect(() => {
    if (collapsed || phone || sending) return undefined
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
    <div className={cn(column(dock), 'pb-2')} data-questions-card={entry.id}>
      <section className="overflow-hidden rounded-md border border-border bg-muted/20">
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground hover:bg-muted/40"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
        >
          <MessageCircleQuestionIcon className="size-3.5 text-brand" />
          <span className="text-foreground">
            {questions.length} {questions.length === 1 ? 'question' : 'questions'}
          </span>
          <span className="ml-auto">{collapsed ? 'Expand' : 'Answer what you can'}</span>
          {collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </button>
        {!collapsed && (
          <div className="space-y-3 border-t border-border px-3 py-3">
            {questions.map(
              (question, index) =>
                (!phone || index === current) && (
                  <fieldset
                    key={index}
                    disabled={sending}
                    onFocus={() => setCurrent(index)}
                    className="min-w-0 space-y-2"
                  >
                    <legend className="mb-2 text-sm leading-relaxed text-foreground">
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
                                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
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
                              <span className="ml-1 font-mono text-[9px] text-brand">
                                recommended
                              </span>
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
            <div className="flex items-center gap-2 border-t border-border pt-2">
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
                <span className="font-mono text-[10px] text-muted-foreground">
                  1–9 choose · Enter next / send
                </span>
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
        )}
      </section>
    </div>
  )
}

function AskedNote({ entry }: { entry: EntryRecord }) {
  const transcript = useTranscript()
  const later = transcript.slice(transcript.findIndex((e) => e.id === entry.id) + 1)
  const next = later.find(input)
  if (!next || (next.kind === 'questions.answers' && (next.data as Answers).askedId === entry.id))
    return null
  const { questions } = entry.data as Asked
  return (
    <details
      className="rounded border border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground"
      data-questions-unanswered={entry.id}
    >
      <summary className="cursor-pointer">
        {questions.length} {questions.length === 1 ? 'question' : 'questions'} left unanswered — you
        replied directly
      </summary>
      <ul className="mt-2 space-y-1 pl-3">
        {questions.map((q, i) => (
          <li key={i}>{q.text}</li>
        ))}
      </ul>
    </details>
  )
}

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
  composer: QuestionsComposer,
  entries: { 'questions.asked': AskedNote, 'questions.answers': AnswerCard },
})
