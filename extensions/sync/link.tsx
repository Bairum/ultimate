import { cn } from 'cn'
import { MessageCircleIcon } from 'lucide-react'
import { projectBase, useAction } from '@/sdk'

const inCloud = projectBase() !== ''

/**
 * "Ask @sync": a quiet link to this machine's home while it runs, for a project's standby page and cloud popover.
 * Nothing in the cloud, nothing while the machine home is stopped.
 */
export function AskSync({ className }: { className?: string }) {
  const home = useAction<{ url: string } | null>(
    'sync',
    'home',
    {},
    // Without the sync extension, or with a server that cannot list projects, there is simply no link.
    { enabled: !inCloud, onError: () => {} },
  )
  if (inCloud || !home.data) return null
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
