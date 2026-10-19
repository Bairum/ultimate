/** Sync's components for other extensions: the "Ask @sync" link to this machine's home. */
import { cn } from 'cn'
import { MessageCircleIcon } from 'lucide-react'
import { useAction } from '@/sdk'
import { HomeAction } from './refs.ts'

/**
 * "Ask @sync": a quiet link to this machine's home while it runs, for a project's standby page and cloud popover.
 * Nothing while the machine home is stopped.
 */
export function AskSync({ className }: { className?: string }) {
  const home = useAction(
    HomeAction,
    null,
    // Without the sync extension, or with a server that cannot list projects, there is simply no link.
    { onError: () => {} },
  )
  if (!home.data) return null
  return (
    <a
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground hover:text-brand',
        className,
      )}
      data-ask-sync
      href={home.data.url}
      rel="noreferrer"
      target="_blank"
      title="Open @sync, this machine's agent for moving projects"
    >
      <MessageCircleIcon className="size-3 shrink-0" />
      Ask @sync
    </a>
  )
}
