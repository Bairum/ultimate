import type { EntryRecord } from '@earendil-works/pi-durable'
import { MessageCircleQuestionIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { Card, cn, events, useDocOf, useUltimate } from '@/sdk'
import { Address, useAccentOf } from './cards.tsx'
import { answerTo } from './data.tsx'
import { MessagesDoc } from './refs.ts'

/** A branch's question stays visible in @ultimate, with the answer card one click away. */
export function QuestionPointer({ entry }: { entry: EntryRecord }) {
  const { message: id, from } = entry.data as { message: number; from: number }
  const log = useDocOf(1, MessagesDoc)
  const message = log?.messages.find((m) => m.id === id)
  const answer = message && answerTo(log?.messages ?? [], message)
  const open = message?.to === 'user' && message.reply && message.state === 'delivered'
  const dismissed = message?.state === 'dismissed'
  const answered = message?.state === 'answered'
  const questions = message?.questions ?? []
  const accent = useAccentOf(from)
  const { showSurface, switchConversation } = useUltimate()
  const summary = dismissed
    ? undefined
    : answered
      ? answer?.text.split('\n').filter(Boolean).slice(0, 2).join(' · ')
      : (questions[0]?.text ?? message?.text.split('\n')[0])
  return (
    <Card attention={open} data-message-pointer={id}>
      <header className="flex min-w-0 items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MessageCircleQuestionIcon
          className={cn(
            'size-3.5 shrink-0',
            open ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
          )}
        />
        <span
          className={cn('flex min-w-0 max-w-24 shrink-0 overflow-hidden sm:max-w-48', accent.name)}
        >
          <Address id={from} />
        </span>
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:text-foreground"
          onClick={() => {
            if (message?.call)
              events.emit('messages:open', { conversation: from, call: message.call })
            showSurface('agent')
            switchConversation(from)
          }}
          type="button"
        >
          {message && (
            <span className="shrink-0">
              {dismissed
                ? 'dismissed'
                : answered
                  ? 'answered'
                  : questions.length
                    ? `asks you ${questions.length} question${questions.length === 1 ? '' : 's'}`
                    : 'asks you'}
            </span>
          )}
          {summary && <span className="min-w-0 flex-1 truncate">{summary}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <SquareArrowOutUpRightIcon className="size-3" />
            Open
          </span>
        </button>
      </header>
    </Card>
  )
}
