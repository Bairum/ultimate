import { CornerDownRightIcon, MessageCircleQuestionIcon, Undo2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { api, cn, errorMessage, useConversation, useDocOf, useViewport } from '@/sdk'
import { MessagesDoc } from '../messages/ui.tsx'
import { keyCard, openQuestions } from './open.tsx'
import type { Message } from './open.tsx'
import { brief, QuestionItem } from './question.tsx'
import { AnswerAction, DismissAction, QuestionsDoc } from './refs.ts'
import type { Answer } from './refs.ts'
import type { Question } from './types.ts'
import {
  answered,
  answerOf,
  choiceForKey,
  choices,
  keyOf,
  pickDraft,
  pickIndices,
} from './state.tsx'
import type { Draft } from './state.tsx'

/** How long a sent card can still be taken back before the answer goes out. */
const UNDO_MS = 3000

/** Whether `card` is the one on the shown conversation's page that takes the desktop 1–9 and Enter keys. */
function useKeys(card: string) {
  const log = useDocOf(1, QuestionsDoc)
  const messages = useDocOf(1, MessagesDoc)?.messages ?? []
  const conversation = useConversation((value) => value.id)
  return keyCard(log, conversation, messages) === card
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

/** Sends the answer waiting out its undo window now, if one does. */
function flushPending(pending: {
  current?: { timer: ReturnType<typeof setTimeout>; fire: () => void }
}) {
  const waiting = pending.current
  if (!waiting) return
  clearTimeout(waiting.timer)
  waiting.fire()
}

/** Where the card is: being answered, sent but still undoable, on its way, or settled into a summary. */
type Phase = 'answering' | 'undo' | 'sending' | 'sent'

/** A small key cap for the hint line and buttons. */
const Key = ({ children, className }: { children: string; className?: string }) => (
  <Kbd className={cn('h-4 min-w-4 rounded-[3px] px-1 font-mono text-[10px]', className)}>
    {children}
  </Kbd>
)

/** One dot per question, filled as it gets an answer: how far along the card is, at a glance. */
function Progress({ done }: { done: boolean[] }) {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {done.map((value, index) => (
        <span
          key={index}
          className={cn(
            'h-1 rounded-full transition-all duration-300 ease-out',
            value ? 'w-3 bg-brand' : 'w-1.5 bg-muted-foreground/30',
          )}
        />
      ))}
    </span>
  )
}

/**
 * What was sent, folded to a line per question in the shape of the answer under an answered message: the number and
 * letter, the words, and "skipped" for a question left open.
 */
function Summary({ questions, drafts }: { questions: Question[]; drafts: Record<number, Draft> }) {
  return (
    <ul className="mt-1.5 space-y-0.5 pl-5.5 text-[13px] leading-relaxed">
      {questions.map((question, index) => {
        const answer = brief(question, index, drafts[index])
        return (
          <li
            key={index}
            className="flex min-w-0 items-baseline gap-2 motion-safe:animate-fade-in"
            style={{ animationDelay: `${index * 40}ms` }}
          >
            <span className="w-7 shrink-0 font-mono text-[11px] text-brand">{answer.tag}</span>
            {answer.words ? (
              <span className="min-w-0 text-foreground">{answer.words}</span>
            ) : (
              <span className="text-muted-foreground/70">skipped</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function Card({
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
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [current, setCurrent] = useState(0)
  const [phase, setPhase] = useState<Phase>('answering')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // The send waiting out its undo window, and the click that folds a chosen question away.
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; fire: () => void }>(undefined)
  const advance = useRef<ReturnType<typeof setTimeout>>(undefined)
  const flush = () => flushPending(pending)
  const phone = useViewport() === 'phone'
  const hints = keys && !phone
  const words = questions.map((question, index) => answerOf(question, drafts[index]))
  const ready = answered(questions, words)
  const open = questions.flatMap((question, index) =>
    !words[index] && pickIndices(question).length ? [index] : [],
  )
  const settled = phase !== 'answering'

  // Leaving the page inside the undo window sends what was sent: only Undo takes it back.
  useEffect(
    () => () => {
      clearTimeout(advance.current)
      flush()
    },
    [],
  )

  const focusField = (index: number) =>
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLInputElement>(`[data-question="${index}"] input`)
        ?.focus({ preventScroll: true }),
    )
  const go = (index: number) => {
    clearTimeout(advance.current)
    const next = Math.min(questions.length - 1, Math.max(0, index))
    setCurrent(next)
    if (questions[next]?.kind === 'text') focusField(next)
  }
  const draft = (index: number, change: (old: Draft) => Draft) =>
    setDrafts((old) => ({ ...old, [index]: change(old[index] ?? { chosen: [] }) }))
  const select = (index: number, option: number, click = false) => {
    const question = questions[index]
    const choice = question && choices(question)[option]
    if (!question || !choice) return
    setCurrent(index)
    if (question.kind === 'multi')
      return draft(index, (old) =>
        choice.custom
          ? { ...old, other: !old.other }
          : {
              ...old,
              chosen: old.chosen.includes(option)
                ? old.chosen.filter((i) => i !== option)
                : [...old.chosen, option].toSorted((a, b) => a - b),
            },
      )
    draft(index, (old) =>
      choice.custom
        ? { ...old, chosen: [], other: true }
        : { ...old, chosen: [option], other: false },
    )
    // A click on a single answer lets its check land, then folds the question and opens the next.
    clearTimeout(advance.current)
    if (click && !choice.custom && index < questions.length - 1)
      advance.current = setTimeout(() => go(index + 1), 320)
  }
  /** Takes @ultimate's picks for questions `indices`, returning the answers that are ready then. */
  const takePicks = (indices: number[]) => {
    const next = { ...drafts }
    for (const [index, question] of questions.entries())
      if (indices.includes(index)) next[index] = pickDraft(question)
    setDrafts(next)
    return answered(
      questions,
      questions.map((question, index) => answerOf(question, next[index])),
    )
  }
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const send = (list: Answer[] = ready) => {
    if (!list.length || pending.current || phase !== 'answering') return
    clearTimeout(advance.current)
    const fire = () => {
      pending.current = undefined
      setPhase('sending')
      setError(undefined)
      submit(list).then(
        () => setPhase('sent'),
        (failure: unknown) => {
          setPhase('answering')
          setError(errorMessage(failure))
        },
      )
    }
    pending.current = { timer: setTimeout(fire, UNDO_MS), fire }
    setPhase('undo')
  }
  const now = flush
  const undo = () => {
    if (!pending.current) return
    clearTimeout(pending.current.timer)
    pending.current = undefined
    setPhase('answering')
  }
  /** Every pick for the questions still open, sent at once: the one-keystroke path. */
  const acceptAndSend = () => send(takePicks(open))
  /** Enter: take the pick of an open question, move on, and send from the last one or once all are answered. */
  const enter = () => {
    if (phase === 'undo') return now()
    if (phase !== 'answering') return
    if (!words[current] && open.includes(current)) {
      const list = takePicks([current])
      return current < questions.length - 1 ? go(current + 1) : send(list)
    }
    if (current < questions.length - 1 && ready.length < questions.length) return go(current + 1)
    send()
  }
  const clear = () => {
    clearTimeout(advance.current)
    setDrafts((old) => ({ ...old, [current]: { chosen: [] } }))
  }
  const fieldKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) acceptAndSend()
      else enter()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.currentTarget.blur()
      go(current + (event.key === 'ArrowDown' ? 1 : -1))
    }
  }

  useEffect(() => {
    if (!keys || phone || phase === 'sending' || phase === 'sent') return undefined
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        // Outside this card, another card or a control keeps its own keys.
        (!root.current?.contains(target) && target?.closest('[data-questions-card], button, a'))
      )
        return
      if (phase === 'undo') {
        if (event.key === 'Escape' || event.key === 'u') {
          event.preventDefault()
          undo()
        } else if (event.key === 'Enter') {
          event.preventDefault()
          now()
        }
        return
      }
      const question = questions[current]
      const choice =
        question && /^[1-9a-z]$/.test(event.key) ? choiceForKey(question, event.key) : undefined
      if (choice !== undefined) {
        event.preventDefault()
        select(current, choice)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        go(current + (event.key === 'ArrowDown' ? 1 : -1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (event.shiftKey) acceptAndSend()
        else enter()
      } else if (event.key === 'Escape' && words[current]) {
        event.preventDefault()
        clear()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  // Nothing extracted to answer with buttons: a reply field for this message, and Dismiss.
  if (!questions.length)
    return (
      <form
        className={cn(className, 'flex flex-wrap items-center gap-2 px-3 py-2.5')}
        data-questions-card={card}
        onSubmit={(event) => {
          event.preventDefault()
          // oxlint-disable-next-line typescript/no-floating-promises -- run catches reply failures and displays them with setError.
          if (text.trim()) void run(() => reply(text.trim()))
        }}
      >
        <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-brand" />
        <input
          aria-label="Your answer"
          placeholder="Your answer…"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          className="min-h-8 min-w-0 flex-1 basis-40 rounded-md border border-border bg-background px-2.5 py-1 text-[13px] outline-none placeholder:text-muted-foreground/70 focus:border-brand/60 max-md:min-h-11"
        />
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => void run(dismiss)}
          title="Close it without an answer; the agent gets a note"
        >
          Dismiss
        </Button>
        <Button size="sm" type="submit" disabled={!text.trim() || busy}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
        {error && (
          <p role="alert" className="w-full text-xs text-error">
            {error}
          </p>
        )}
      </form>
    )

  if (settled)
    return (
      <div className={cn(className, 'px-3 py-2.5')} data-questions-card={card} ref={root}>
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <CornerDownRightIcon className="size-3.5 shrink-0 text-brand" />
          <span className="font-semibold text-brand">
            {phase === 'sent' ? 'You answered' : 'Sending your answer'}
          </span>
          {phase === 'undo' && (
            <span className="ml-auto flex items-center gap-2">
              {hints && (
                <span className="flex items-center gap-1 max-md:hidden">
                  <Key>esc</Key> undo
                </span>
              )}
              <Button variant="ghost" size="xs" onClick={undo}>
                <Undo2Icon />
                Undo
              </Button>
            </span>
          )}
          {phase === 'sending' && <span className="ml-auto">sending…</span>}
        </div>
        <Summary questions={questions} drafts={drafts} />
        {phase === 'undo' && (
          <div className="mt-2.5 h-0.5 overflow-hidden rounded-full bg-border/60">
            <div
              className="h-full w-full origin-left rounded-full bg-brand/70 transition-[scale] ease-linear starting:scale-x-0"
              style={{ transitionDuration: `${UNDO_MS}ms` }}
            />
          </div>
        )}
      </div>
    )

  const last = questions.length - 1
  // The keys of the open question: its first two choices, none while it is typed.
  const shown = questions[current]
  const shownKeys = shown ? [0, 1].flatMap((i) => keyOf(shown, i) ?? []) : []
  const unanswered = questions.length - ready.length
  return (
    <div className={className} data-questions-card={card} ref={root}>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 font-mono text-[11px] text-muted-foreground">
        <MessageCircleQuestionIcon className="size-3.5 text-brand" />
        <span className="text-foreground">
          {questions.length === 1 ? '1 question' : `${questions.length} questions`}
        </span>
        {questions.length > 1 && (
          <span className="ml-auto flex items-center gap-2">
            <span>
              {ready.length}/{questions.length}
            </span>
            <Progress done={words.map(Boolean)} />
          </span>
        )}
      </div>
      <div className="space-y-0.5 px-1.5">
        {questions.map((question, index) => (
          <div key={index} data-question={index}>
            <QuestionItem
              question={question}
              index={index}
              draft={drafts[index]}
              current={index === current}
              disabled={busy}
              hints={hints}
              onOpen={() => go(index)}
              onSelect={(option) => select(index, option, true)}
              onText={(value) => draft(index, (old) => ({ ...old, text: value }))}
              onFieldKey={fieldKey}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-2.5">
        {hints && (
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-muted-foreground/80 max-md:hidden">
            {shownKeys.length > 0 && (
              <span className="flex items-center gap-1">
                {shownKeys.map((key) => (
                  <Key key={key}>{key}</Key>
                ))}{' '}
                choose
              </span>
            )}
            {questions.length > 1 && (
              <span className="flex items-center gap-1">
                <Key>↑</Key>
                <Key>↓</Key> move
              </span>
            )}
            <span className="flex items-center gap-1">
              <Key>↵</Key>
              {!words[current] && open.includes(current)
                ? 'take pick'
                : current < last && unanswered
                  ? 'next'
                  : 'send'}
            </span>
            {words[current] && (
              <span className="flex items-center gap-1">
                <Key>esc</Key> clear
              </span>
            )}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run(dismiss)}
            title="Close it without an answer; the agent gets a note"
          >
            Dismiss
          </Button>
          {open.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => takePicks(open)}
              title="Choose @ultimate's pick for every question still open (⇧↵ also sends)"
            >
              Accept picks
              {hints && <Key className="bg-transparent">⇧↵</Key>}
            </Button>
          )}
          <Button size="sm" disabled={!ready.length || busy} onClick={() => send()}>
            {unanswered && ready.length ? `Send ${ready.length} of ${questions.length}` : 'Send'}
          </Button>
        </span>
        {error && (
          <p role="alert" className="w-full text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
