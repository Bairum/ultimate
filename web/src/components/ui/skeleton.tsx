// shadcn/ui skeleton. Changes: one shimmer sweeps across every block on screen instead of each pulsing.
import { cn } from 'cn'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        'animate-shimmer rounded-md bg-muted bg-size-[200%_100%] bg-fixed bg-[linear-gradient(90deg,transparent_35%,color-mix(in_oklab,var(--color-foreground)_6%,transparent)_50%,transparent_65%)]',
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
