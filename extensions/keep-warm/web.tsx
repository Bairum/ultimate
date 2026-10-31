import { FlameIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { api, cn, defineWebExtension, formatAgo, useAction, useDocOf, useNow } from '@/sdk'
import { failing, TTL } from './due.ts'
import { SetAction, StateAction, WarmDoc } from './refs.ts'
import type { WarmConversation } from './refs.ts'

const tokens = (count = 0) => (count >= 1000 ? `${Math.round(count / 1000)}k` : String(count))

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Where the cache stands: warm until the hour after @ultimate's last request ends, else cold. */
function cacheLine(state: WarmConversation, now: number) {
  if (state.lastRequest === undefined) return 'No Claude request yet'
  const until = state.lastRequest + TTL
  return until > now ? `Warm until ${clock(until)}` : `Cold since ${clock(until)}`
}

/** Why no ping is coming, or when the next one is. */
function nextLine(state: WarmConversation, now: number) {
  if (state.nextAt !== undefined) return `Next ping ${clock(Math.max(now, state.nextAt))}`
  if (state.lastRequest !== undefined && failed(state)) return 'Waiting for next answer'
  if (state.lastRequest !== undefined && state.lastRequest + TTL <= now) return 'Cache is cold'
  return 'No ping scheduled'
}

/** The last ping failed and nothing renewed the cache since: a later cached answer from @ultimate clears it. */
const failed = (state: WarmConversation) =>
  state.last?.error !== undefined && failing(state.last.at, state.lastRequest)

/**
 * The status-line chip: whether @ultimate's prompt cache is kept warm. Quiet while it is, dimmed while off; the
 * popover has the switch, where the cache stands and the last ping.
 */
function Chip() {
  const doc = useDocOf(1, WarmDoc)
  const { data: state, refetch } = useAction(
    StateAction,
    null,
    // A failed poll keeps the last state; the next one asks again.
    { onError: () => {} },
  )
  const now = useNow(60_000)
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void refetch()
  }, [doc, now, refetch])
  if (!state) return null
  const warm = state.conversations.some(
    (item) => item.lastRequest !== undefined && item.lastRequest + TTL > now,
  )
  const red = state.conversations.some(failed)
  const toggle = (on: boolean) =>
    api
      .action(SetAction, { on })
      // The state comes back from the document change; a failure leaves the switch as it was.
      .catch((error: unknown) => console.warn('Keep warm', error))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="Keep conversation caches warm"
          className={cn(
            '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            !state.on && 'text-muted-foreground/60',
          )}
          data-keep-warm={state.on ? (warm ? 'warm' : 'cold') : 'off'}
          type="button"
        >
          <FlameIcon
            className={cn('size-3', state.on && warm && 'text-amber-500', red && 'text-red-500')}
          />
          warm
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1 font-mono" side="top">
        <label className="flex h-8 cursor-pointer items-center justify-between px-2 text-[12px]">
          Keep caches warm
          <Switch checked={state.on} onCheckedChange={(on) => void toggle(on)} />
        </label>
        <div className="space-y-1 border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
          {state.conversations.map((item) => (
            <div key={item.id} className="space-y-1 py-1">
              <div className="truncate text-foreground/80">{item.title}</div>
              <div>{cacheLine(item, now)}</div>
              <div>{state.on ? nextLine(item, now) : 'Off'}</div>
              {item.last && (
                <div className={cn(failed(item) && 'text-red-500')}>
                  Last ping {formatAgo(item.last.at)}
                  {item.last.error !== undefined
                    ? `: ${item.last.error}`
                    : ` · read ${tokens(item.last.read)}, wrote ${tokens(item.last.write)}`}
                </div>
              )}
            </div>
          ))}
          <div className="pt-1 text-muted-foreground/70">
            One ping near the end of each cache hour; stops after 8 h away.
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -1 }] },
})
