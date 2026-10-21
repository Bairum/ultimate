import type { ImageContent, TextContent, UserMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { MentionText, Message, MessageContent } from '@/components/ai/message'
import { ToolImage } from '@/components/ai/tool'
import { cn } from 'cn'
import { MessageActions } from './message-actions.tsx'

/** The text blocks of a user message, joined. */
export function textOf(content: string | readonly (TextContent | ImageContent)[]) {
  return typeof content === 'string'
    ? content
    : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** The user's words as written, with mentions as chips: the body of every user turn. */
export function UserText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn('break-words whitespace-pre-wrap', className)}>
      <MentionText text={text} />
    </p>
  )
}

/**
 * A turn of the user's: its text as written, with mentions as chips, and its images. `text` replaces the message's own,
 * such as the user's words inside a message an extension delivered.
 */
export function UserView({
  entry,
  message,
  text = textOf(message.content),
}: {
  entry: EntryRecord
  message: UserMessage
  text?: string
}) {
  const images =
    typeof message.content === 'string'
      ? []
      : message.content.filter((block) => block.type === 'image')
  return (
    <Message className="group/message mt-3 first:mt-0" from="user">
      <MessageContent>
        <UserText text={text} />
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((image, index) => (
              <ToolImage alt={`Attached image ${index + 1}`} image={image} key={index} />
            ))}
          </div>
        )}
      </MessageContent>
      <MessageActions
        className="-mt-1 justify-end"
        entry={entry}
        text={text}
        timestamp={message.timestamp}
      />
    </Message>
  )
}
