import type { EntryRecord } from '@earendil-works/pi-durable'
import { useEffect, useState } from 'react'
import { defineWebExtension, events, useConversation, useDocOf, useEvent, useUltimate } from '@/sdk'
import { Address, BoardInput, BranchCall, ChatAnswer, MessageCall } from './cards.tsx'
import { emptyBoard, answeredMessages, ultimateChat } from './data.tsx'
import type { BoardData } from './data.tsx'

function BoardAnswerLabel({ entry }: { entry: EntryRecord }) {
  const board = useDocOf<BoardData>(1, 'board') ?? emptyBoard
  const conversation = useConversation((value) => value.id)
  const messages =
    conversation === undefined ? [] : answeredMessages(board.messages, conversation, entry.id)
  return messages.map((message) => (
    <span
      key={message.id}
      className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-1 text-muted-foreground"
    >
      {message.reply ? '↩ sent to' : 'not sent · one-way from'} <Address id={message.from} />
    </span>
  ))
}

/** Stay mounted across surfaces so an Open click can reveal after Agent mounts and loads. */
function BoardNavigation() {
  const { id, entries, loading } = useConversation()
  const { surface } = useUltimate()
  const [target, setTarget] = useState<{ conversation: number; entry: number }>()
  useEvent('board:open', (value) => setTarget(value as NonNullable<typeof target>))
  useEffect(() => {
    if (!target || surface !== 'agent' || id !== target.conversation || loading) return undefined
    const frame = requestAnimationFrame(() => {
      events.emit('ultimate:reveal-entry', { conversationId: id, entryId: target.entry })
      setTarget(undefined)
    })
    return () => cancelAnimationFrame(frame)
  }, [surface, id, entries, loading, target])
  return null
}

export default defineWebExtension({
  slots: { overlay: [BoardNavigation] },
  entries: { 'board.message': BoardInput, 'board.reply': BoardInput, 'pi.assistant': ChatAnswer },
  tools: { message: MessageCall, branch: BranchCall },
  chat: { when: ultimateChat, tools: ['message', 'branch', 'workspace', 'setup'] },
  answerLabels: [BoardAnswerLabel],
})
