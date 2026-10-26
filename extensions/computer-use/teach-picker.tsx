/**
 * The start dialog's window picker: every titled window of every running app and helper process, searchable, ticked
 * explicitly (1–6), with an inline Allow for apps this conversation may not watch yet. Picking from the live list
 * replaces typing an app and a title fragment, which broke on helper processes (Citrix Viewer) and invisible
 * characters in titles. Each picked window can narrow `match`, the part of its title a saved lesson finds it by.
 */
import { RotateCwIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/sdk'
import type { ActionState } from '@/sdk'
import type { PickableWindow, TeachStart } from './refs.ts'
import { normalizeTitle, titleMatches } from './windows.ts'

/** The most windows one lesson may watch. */
export const maxWindows = 6

/** One ticked window, in the order ticked: its id and the title fragment a saved lesson finds it by. */
export type Pick = { window: number; match: string }

/** An app the user allowed watching in the start dialog: `TeachStart.allow`, sent only with the start. */
export type Allowed = NonNullable<TeachStart['allow']>[number]

/** What Allow on `w` permits: its app, and for a window-only helper (no bundle id) only its process. */
export const allowFor = (w: PickableWindow): Allowed => ({
  app: w.app,
  ...(w.bundle ? {} : { pid: w.pid }),
})

/** Whether `w`'s app (and, for a helper, its process) was allowed in this dialog. */
export const isAllowed = (allow: readonly Allowed[], w: PickableWindow) =>
  allow.some((a) => a.app === w.app && a.pid === allowFor(w).pid)

/** Windows whose app, title or pid contain `query`, compared normalised; an empty query keeps them all. */
export function filterWindows(windows: readonly PickableWindow[], query: string) {
  if (!normalizeTitle(query)) return [...windows]
  return windows.filter((w) => titleMatches(`${w.app} ${w.title} ${w.pid}`, query))
}

/**
 * Why `match` would not find this window again: text the title does not contain, or a fragment (the whole title when
 * blank) that another window of the same app also contains. Mirrors the refusal of `teachStart`.
 */
export function matchProblem(w: PickableWindow, match: string, windows: readonly PickableWindow[]) {
  if (match.trim() && !titleMatches(w.title, match)) return 'not part of the title'
  const fragment = match.trim() || w.title
  if (
    normalizeTitle(fragment) &&
    windows.some((o) => o.window !== w.window && o.app === w.app && titleMatches(o.title, fragment))
  )
    return `also matches another ${w.app} window; make it more specific`
  return undefined
}

/**
 * `TeachStart.windows` from the ticks, in tick order: picks whose window left the list are dropped, and `match` is
 * sent only when narrowed from the whole title.
 */
export function startWindows(
  windows: readonly PickableWindow[],
  picks: readonly Pick[],
): NonNullable<TeachStart['windows']> {
  return picks.flatMap((pick) => {
    const w = windows.find((candidate) => candidate.window === pick.window)
    if (!w) return []
    const match = pick.match.trim()
    return [
      {
        app: w.app,
        window: w.window,
        ...(match && normalizeTitle(match) !== normalizeTitle(w.title) ? { match } : {}),
      },
    ]
  })
}

/** The window to tick when the list first arrives: the frontmost of the app the session used last, if allowed. */
export function suggestedPick(windows: readonly PickableWindow[], app: string): Pick | undefined {
  const wanted = normalizeTitle(app)
  const w =
    wanted &&
    windows.find(
      (candidate) => candidate.consent !== 'denied' && normalizeTitle(candidate.app) === wanted,
    )
  return w ? { window: w.window, match: w.title } : undefined
}

/** Why a window is not on screen now, shortest first; undefined when it is visible. */
const away = (w: PickableWindow) =>
  !w.currentSpace ? 'other Space' : !w.onScreen ? 'hidden' : undefined

export function WindowPicker({
  listed,
  picks,
  onPicks,
  allow,
  onAllow,
}: {
  listed: ActionState<{ windows: PickableWindow[] }>
  picks: readonly Pick[]
  onPicks: (picks: Pick[]) => void
  /** The apps allowed in this dialog: sent with the start, so closing the dialog leaves no grant behind. */
  allow: readonly Allowed[]
  onAllow: (w: PickableWindow) => void
}) {
  const [query, setQuery] = useState('')
  const windows = listed.data?.windows ?? []
  const shown = filterWindows(windows, query)
  const ticked = picks.filter((p) => windows.some((w) => w.window === p.window))
  const full = ticked.length >= maxWindows
  const toggle = (w: PickableWindow, on: boolean) =>
    onPicks(
      on
        ? [...picks, { window: w.window, match: w.title }]
        : picks.filter((p) => p.window !== w.window),
    )
  const setMatch = (window: number, match: string) =>
    onPicks(picks.map((p) => (p.window === window ? { ...p, match } : p)))
  return (
    <fieldset className="min-w-0 space-y-1.5" data-teach-windows>
      <legend className="contents">
        <span className="flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
          <span>
            Windows to watch{' '}
            <span className="font-mono text-[11px] text-muted-foreground/70 tabular-nums">
              {ticked.length ? `${ticked.length} of ${maxWindows}` : `up to ${maxWindows}`}
            </span>
          </span>
          <button
            aria-label="Refresh the window list"
            className="-mr-1 flex items-center gap-1 rounded-sm px-1 font-mono text-[11px] transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            data-teach-refresh
            disabled={listed.loading}
            onClick={() => void listed.refetch()}
            title="List the open windows again"
            type="button"
          >
            <RotateCwIcon className={cn('size-3', listed.loading && 'motion-safe:animate-spin')} />
            refresh
          </button>
        </span>
      </legend>
      <input
        aria-label="Find a window"
        className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-brand/60 focus-visible:ring-2 focus-visible:ring-ring/30 max-md:h-10"
        data-teach-search
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Find by app or title"
        type="search"
        value={query}
      />
      <div className="max-h-[17rem] min-h-16 overflow-y-auto rounded-md border border-border bg-background max-sm:max-h-[45dvh]">
        {listed.error && !listed.data ? (
          <p className="px-2.5 py-3 text-[12px] leading-relaxed break-words text-error">
            Could not list the open windows: {listed.error.message}
          </p>
        ) : !listed.data ? (
          <div aria-label="Listing windows" className="space-y-2 px-2.5 py-2.5">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : !shown.length ? (
          <p className="px-2.5 py-3 text-[12px] text-muted-foreground">
            {windows.length
              ? `No window matches “${query.trim()}”.`
              : 'No open windows to watch. Open the app, then refresh.'}
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {shown.map((w, index) => {
              const pick = picks.find((p) => p.window === w.window)
              const denied = w.consent === 'denied'
              const where = away(w)
              const problem = pick && matchProblem(w, pick.match, windows)
              // One Allow per app (per process for a window-only helper): its first row in the shown list.
              const allowedHere = w.consent === 'required' && isAllowed(allow, w)
              const asks =
                w.consent === 'required' &&
                !allowedHere &&
                shown.findIndex((o) => o.app === w.app && allowFor(o).pid === allowFor(w).pid) ===
                  index
              return (
                <li data-teach-window={w.window} key={w.window}>
                  <div className="flex items-center gap-2 pr-2">
                    <label
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2.5 text-[12.5px] max-sm:py-2.5',
                        denied ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
                      )}
                      title={`${w.app} — ${w.title} (${w.pid})`}
                    >
                      <Checkbox
                        checked={!!pick}
                        disabled={denied || (!pick && full)}
                        onCheckedChange={(value) => toggle(w, value === true)}
                      />
                      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="max-w-[45%] shrink-0 truncate text-foreground">
                          {w.app}
                        </span>
                        <span className="shrink-0 text-muted-foreground/50">—</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {w.title}
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/60 tabular-nums">
                          ({w.pid})
                        </span>
                      </span>
                      {where && (
                        <span
                          className="shrink-0 rounded-sm border border-border/80 px-1 font-mono text-[10px] leading-4 text-muted-foreground"
                          title={
                            where === 'other Space'
                              ? 'On another Space: it is still recorded, but you have to switch there to work in it'
                              : 'Minimised, hidden or covered right now'
                          }
                        >
                          {where}
                        </span>
                      )}
                      {denied && (
                        <span className="shrink-0 font-mono text-[10.5px] text-error">denied</span>
                      )}
                      {allowedHere && (
                        <span
                          className="shrink-0 font-mono text-[10.5px] text-muted-foreground"
                          title="Watched for this lesson only, once you start it"
                        >
                          allowed
                        </span>
                      )}
                    </label>
                    {asks && (
                      <Button
                        className="h-6 shrink-0 gap-1 border-brand/50 px-1.5 font-sans text-[11px] text-foreground hover:border-brand max-md:h-8"
                        data-teach-allow={w.app}
                        onClick={() => {
                          onAllow(w)
                          if (!pick && !full)
                            onPicks([...picks, { window: w.window, match: w.title }])
                        }}
                        size="sm"
                        title={`Let the agent watch ${w.app} for this lesson (never act in it), then tick this window`}
                        type="button"
                        variant="outline"
                      >
                        Allow
                      </Button>
                    )}
                  </div>
                  {pick && (
                    <label className="flex items-center gap-2 pr-2 pb-1.5 pl-9 font-mono text-[10.5px] text-muted-foreground">
                      <span
                        className="shrink-0"
                        title="Titles change as pages change: keep only the part that stays"
                      >
                        found by
                      </span>
                      <input
                        aria-invalid={!!problem}
                        aria-label={`Part of the title that finds ${w.app} — ${w.title} later`}
                        className={cn(
                          'h-6 min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1 text-[11px] text-foreground/85 outline-none hover:border-border focus:border-brand/60 max-md:h-8',
                          problem && 'border-error/50',
                        )}
                        onChange={(event) => setMatch(w.window, event.target.value)}
                        value={pick.match}
                      />
                      {problem && <span className="shrink-0 text-error">{problem}</span>}
                    </label>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {listed.error && listed.data && (
        <p className="text-[11px] break-words text-error">Refresh failed: {listed.error.message}</p>
      )}
    </fieldset>
  )
}
