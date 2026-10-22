import type { EntryRecord } from '@earendil-works/pi-durable'
import { useEffect, useState } from 'react'
import {
  api,
  defineWebExtension,
  events,
  useConversation,
  useDocOf,
  useEvent,
  useUltimate,
} from '@/sdk'
import {
  Address,
  BackgroundSummary,
  BoardInput,
  BranchCall,
  ChatAnswer,
  MessageCall,
} from './cards.tsx'
import { answeredMessages, chatQuiet, emptyBoard, scriptMessaged, ultimateChat } from './data.tsx'
import { callerOf } from './caller.ts'
import { BoardDoc, CallerAction } from './refs.ts'
import type { BoardData } from './refs.ts'

function BoardAnswerLabel({ entry }: { entry: EntryRecord }) {
  const board = useDocOf(1, BoardDoc) ?? emptyBoard
  const conversation = useConversation((value) => value.id)
  const messages =
    conversation === undefined ? [] : answeredMessages(board.messages, conversation, entry.id)
  return messages.map((message) => (
    <span
      key={message.id}
      className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-1 text-muted-foreground"
    >
      {message.reply ? '↩ sent to' : 'not sent · one-way from'}{' '}
      <Address id={message.from} remote={message.remote} />
    </span>
  ))
}

/**
 * Stay mounted across surfaces so an Open click can reveal after Agent mounts and loads. `board:open` names the entry,
 * or the tool call that sent a message (`call`): the response that made it, found in the loaded entries or else in the
 * stored history, which the transcript then pages in.
 */
function BoardNavigation() {
  const { id, entries, loading } = useConversation()
  const { surface } = useUltimate()
  const [target, setTarget] = useState<{ conversation: number; entry?: number; call?: string }>()
  useEvent('board:open', (value) => setTarget(value as NonNullable<typeof target>))
  useEffect(() => {
    if (!target || surface !== 'agent' || id !== target.conversation || loading) return undefined
    const { call } = target
    const reveal = (entry: number) =>
      events.emit('ultimate:reveal-entry', { conversationId: id, entryId: entry })
    const loaded = target.entry ?? (call && callerOf(entries, call.split('/')[0])?.id)
    setTarget(undefined)
    if (loaded) {
      const frame = requestAnimationFrame(() => reveal(loaded))
      return () => cancelAnimationFrame(frame)
    }
    if (call)
      api.action(CallerAction, { conversation: id, call }).then(
        ({ entry }) => entry !== undefined && reveal(entry),
        // The conversation is open either way; only the scroll to the question is lost.
        () => undefined,
      )
    return undefined
  }, [surface, id, entries, loading, target])
  return null
}

export default defineWebExtension({
  slots: { overlay: [BoardNavigation] },
  entries: {
    'board.message': BoardInput,
    'board.reply': BoardInput,
    // The message's row already says it woke the agent: `action`.
    'board.wake': () => null,
    // The agent's reminder of the questions still open; the user sees them in the To-dos panel.
    'board.open': () => null,
    'pi.assistant': ChatAnswer,
  },
  tools: { message: MessageCall, branch: BranchCall },
  chat: {
    when: ultimateChat,
    tools: [
      'message',
      'branch',
      'workspace',
      'setup',
      // A script that messaged you stays visible, so its messages show as bubbles, even when it was interrupted.
      (call, docs) => scriptMessaged(call, docs.board as BoardData | null | undefined),
    ],
    docs: ['board'],
    // Traffic between agents is background to your chat with @ultimate: each stretch of it folds into one line.
    quiet: (row, docs) => chatQuiet(row, docs.board as BoardData | null | undefined),
    summary: BackgroundSummary,
  },
  answerLabels: [BoardAnswerLabel],
})
