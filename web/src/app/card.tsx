import { cn } from 'cn'
import type { ComponentProps } from 'react'

/** The transcript's card: a bordered section with the brand accent on its left edge; `className` adds to it. */
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20',
        className,
      )}
      {...props}
    />
  )
}
