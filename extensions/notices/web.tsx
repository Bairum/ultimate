import { CircleAlertIcon, InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { cn, defineWebExtension, useNotices, useNow } from '@/sdk'
import type { Notice } from '@/sdk'

/** How long a notice stays, by level; hovering keeps them. */
const lifetime: Record<Notice['level'], number> = { info: 5000, warning: 9000, error: 15000 }
const icons = {
  info: [InfoIcon, 'text-muted-foreground'],
  warning: [TriangleAlertIcon, 'text-warning'],
  error: [CircleAlertIcon, 'text-error'],
} as const

/** Server and client notices as small toasts under the header. */
function Toasts() {
  const notices = useNotices()
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set())
  const [hovered, setHovered] = useState(false)
  const live = notices.some((notice) => Date.now() - notice.at < lifetime[notice.level])
  const now = useNow(500, live && !hovered)
  const shown = notices
    .filter(
      (notice) =>
        !dismissed.has(notice.id) && (hovered || now - notice.at < lifetime[notice.level]),
    )
    .slice(-4)
  if (shown.length === 0) return null
  return (
    <div
      className="fixed top-12 right-3 z-40 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-1.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="status"
    >
      {shown.map((notice) => {
        const [Icon, tone] = icons[notice.level]
        return (
          <div
            className={cn(
              'group/notice flex items-start gap-2 rounded-md border bg-popover px-2.5 py-2 font-mono text-[11.5px] leading-snug shadow-lg',
              notice.level === 'error'
                ? 'border-error/30'
                : notice.level === 'warning'
                  ? 'border-warning/30'
                  : 'border-border/80',
            )}
            key={notice.id}
          >
            <Icon className={cn('mt-px size-3.5 shrink-0', tone)} />
            <span className="min-w-0 flex-1 break-words text-foreground/90">{notice.message}</span>
            <button
              aria-label="Dismiss"
              className="shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover/notice:opacity-100 hover:text-foreground"
              onClick={() => setDismissed((previous) => new Set([...previous, notice.id]))}
              type="button"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export default defineWebExtension({ slots: { overlay: Toasts } })
