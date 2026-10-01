// Adapted from vercel/ai-elements packages/elements/src/message.tsx (Apache-2.0, see LICENSE).
// Changes: `from` is a plain role, no branches or actions; only the code plugin; denser typography.
import { cn } from 'cn'
import type { ComponentProps, HTMLAttributes } from 'react'
import { memo } from 'react'
import { Streamdown } from 'streamdown'
import { codePlugin } from './code-block.tsx'

export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: 'user' | 'assistant' }

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full flex-col gap-2',
      from === 'user' ? 'is-user' : 'is-assistant',
      className,
    )}
    data-from={from}
    {...props}
  />
)

export const MessageContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex min-w-0 max-w-full flex-col gap-2 text-[14px] leading-relaxed',
      'group-[.is-user]:rounded-lg group-[.is-user]:border group-[.is-user]:border-border/70 group-[.is-user]:bg-secondary/60 group-[.is-user]:px-3.5 group-[.is-user]:py-2.5',
      className,
    )}
    {...props}
  />
)

const plugins = { code: codePlugin }
const controls = { code: { copy: true, download: false }, table: false, mermaid: false } as const

/** Markdown that may still be streaming. */
export const MessageResponse = memo(
  ({ className, ...props }: ComponentProps<typeof Streamdown>) => (
    <Streamdown
      className={cn('markdown min-w-0', className)}
      controls={controls}
      lineNumbers={false}
      plugins={plugins}
      shikiTheme={codePlugin.getThemes()}
      {...props}
    />
  ),
  (previous, next) =>
    previous.children === next.children && previous.isAnimating === next.isAnimating,
)
MessageResponse.displayName = 'MessageResponse'
