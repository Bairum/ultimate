import * as React from 'react'
import { cn } from 'cn'
import { Switch as SwitchPrimitive } from 'radix-ui'

/** An on/off switch. While `busy` it ignores presses but keeps focus, which `disabled` would drop. */
function Switch({
  className,
  busy,
  onClick,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { busy?: boolean }) {
  return (
    <SwitchPrimitive.Root
      aria-busy={busy || undefined}
      data-slot="switch"
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:bg-brand data-[state=unchecked]:bg-input',
        busy && 'animate-pulse cursor-progress',
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        // Radix skips its toggle for a prevented click.
        if (busy) event.preventDefault()
      }}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="block size-3 rounded-full shadow-sm transition-transform data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-brand-foreground data-[state=unchecked]:translate-x-0.5 data-[state=unchecked]:bg-muted-foreground/80"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
