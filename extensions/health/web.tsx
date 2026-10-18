import { TriangleAlertIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { defineWebExtension, useAction } from '@/sdk'
import type { ProviderHealth } from '../../cloud/protocol.ts'

/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
function ago(at: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** An amber status-line item while a model provider's latest call on this machine failed. */
function Failing() {
  const { data, refetch } = useAction<{ machine: string; providers: ProviderHealth[] }>(
    'health',
    'state',
    null,
    // A failed poll keeps the last state; the next one tries again.
    { onError: () => {} },
  )
  useEffect(() => {
    const timer = setInterval(() => void refetch(), 60_000)
    return () => clearInterval(timer)
  }, [refetch])
  const failing = data?.providers.filter((provider) => provider.state === 'failing') ?? []
  if (!failing.length) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-warning transition-colors hover:bg-accent"
          data-health-failing
          type="button"
        >
          <TriangleAlertIcon className="size-3" />
          {failing.length === 1
            ? `${failing[0].provider} failing`
            : `${failing.length} providers failing`}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0 font-mono" side="top">
        <div className="border-b border-border/70 px-3 py-2 text-[11.5px] text-muted-foreground">
          The latest call failed on {data?.machine}. Log in again with ⌘K → Log in.
        </div>
        <ul className="px-3 py-2 text-[11.5px] leading-[1.55]">
          {failing.map((provider) => (
            <li className="flex gap-3" key={provider.provider}>
              <span className="shrink-0 text-warning">{provider.provider}</span>
              <span className="min-w-0 flex-1 break-words text-foreground/85">
                {provider.error ?? 'failed'}
              </span>
              {provider.lastFail !== undefined && (
                <span className="shrink-0 text-muted-foreground">{ago(provider.lastFail)}</span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [Failing] },
})
