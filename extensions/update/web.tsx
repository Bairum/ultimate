import { ArrowDownIcon, CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, cn, defineWebExtension, useAction, useRestart, useSystem } from '@/sdk'
import { AskSync } from '../sync/ui.tsx'
import { StateAction, UpdateAction } from './refs.ts'
import type { Layers, UpdateResult, UpdateState } from './refs.ts'

const statusButton =
  '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent'

/** `just now`, `12m ago`, `3h ago`. */
function ago(at: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

const short = (root: string) => root.replace(/^\/(?:home|Users)\/[^/]+/, '~')

/** "extensions, web · server · lockfile": what the range touches, core and lockfile marked. */
function Touches({ layers }: { layers: Layers }) {
  const parts: ReactNode[] = []
  if (layers.live) parts.push(<span key="live">extensions, web</span>)
  if (layers.core)
    parts.push(
      <span className="text-warning" key="core">
        server
      </span>,
    )
  if (layers.lockfile)
    parts.push(
      <span className="text-warning" key="lock">
        lockfile
      </span>,
    )
  if (layers.bin)
    parts.push(
      <span className="text-warning" key="bin">
        bin
      </span>,
    )
  return (
    <span>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && ' · '}
          {part}
        </span>
      ))}
    </span>
  )
}

/** What has to happen after an update with `layers`, one line each. */
function After({ layers, install }: { layers: Layers; install?: UpdateResult & { ok: true } }) {
  const lines: ReactNode[] = []
  if (layers.live) lines.push('extensions and web reload by themselves')
  if (layers.core || layers.lockfile)
    lines.push(
      <span className="text-warning">
        restart this Ultimate ({layers.core ? 'server changed' : 'packages changed'}), and every
        other one running from this clone
      </span>,
    )
  if (layers.lockfile && install?.install !== 'done')
    lines.push(install?.install === 'failed' ? 'pnpm install failed' : 'pnpm install')
  if (layers.bin)
    lines.push(
      <span className="text-warning">
        bin/ changed: restart the supervisor (systemctl --user restart ultimate, or launchctl
        kickstart -k gui/$UID/com.ultimate.app)
      </span>,
    )
  return (
    <ul className="space-y-0.5">
      {lines.map((line, index) => (
        <li className="flex gap-1.5" key={index}>
          <span className="text-muted-foreground">·</span>
          <span className="min-w-0">{line}</span>
        </li>
      ))}
    </ul>
  )
}

function Popup({
  state,
  busy,
  error,
  run,
}: {
  state: UpdateState
  busy: boolean
  error?: string
  run: () => void
}) {
  const restart = useRestart()
  const coreStale = useSystem()?.code.coreStale
  const updated = state.behind === 0 ? state.updated : undefined
  return (
    <>
      <div className="border-b border-border/70 px-3 py-2 text-[11.5px]">
        <div className="text-[10.5px] tracking-wider text-muted-foreground uppercase">
          Ultimate update
        </div>
        <div className="truncate text-muted-foreground" title={state.root}>
          {short(state.root)}
        </div>
      </div>
      <div className="space-y-2 px-3 py-2 text-[11.5px] leading-[1.55]">
        {updated ? (
          <>
            <div>
              <span className="text-success">Updated</span> {updated.from}..
              {updated.to} · {updated.commits} {updated.commits === 1 ? 'commit' : 'commits'}
              {updated.install === 'done' && ' · pnpm install done'}
            </div>
            <After install={updated} layers={updated.layers} />
            {updated.install === 'failed' && updated.installError && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-error">
                {updated.installError}
              </pre>
            )}
          </>
        ) : (
          <>
            <div>
              {state.branch ?? 'main'} is {state.behind} {state.behind === 1 ? 'commit' : 'commits'}{' '}
              behind origin/
              {state.branch ?? 'main'}
            </div>
            <ul className="space-y-0.5">
              {state.commits.map((commit) => (
                <li className="flex min-w-0 gap-2" key={commit.sha}>
                  <span className="shrink-0 text-muted-foreground">{commit.sha}</span>
                  <span className="truncate text-foreground/85" title={commit.subject}>
                    {commit.subject}
                  </span>
                </li>
              ))}
              {state.behind > state.commits.length && (
                <li className="text-muted-foreground">
                  … {state.behind - state.commits.length} more
                </li>
              )}
            </ul>
            {state.compare && (
              <a
                className="text-muted-foreground hover:text-brand"
                href={state.compare}
                rel="noreferrer"
                target="_blank"
              >
                DiffsHub ↗
              </a>
            )}
            {state.layers && (
              <div className="border-t border-border/60 pt-2">
                <div className="mb-0.5 text-muted-foreground">
                  Touches <Touches layers={state.layers} />
                </div>
                <After layers={state.layers} />
              </div>
            )}
          </>
        )}
        {state.refused && !updated && (
          <div className="flex items-start gap-1.5 text-warning">
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
            <span>Can't update: {state.refused}. Nothing was stashed, rebased or reset.</span>
          </div>
        )}
        {state.error && (
          <div className="break-words text-error" title={state.error}>
            Last fetch failed: {state.error.split('\n')[0]}
          </div>
        )}
        {error && <div className="break-words text-error">{error}</div>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-1.5">
        <span className="text-[10.5px] text-muted-foreground">
          {state.refused && !updated ? (
            <AskSync />
          ) : state.fetchedAt !== undefined ? (
            `checked ${ago(state.fetchedAt)}`
          ) : (
            ''
          )}
        </span>
        {updated ? (
          (updated.layers.core || updated.layers.lockfile || coreStale || state.restart) && (
            <Button
              className="h-7 font-sans text-[12px]"
              disabled={restart.busy}
              onClick={restart.run}
              size="sm"
              variant="outline"
            >
              {restart.busy ? 'Restarting…' : 'Restart now'}
            </Button>
          )
        ) : (
          <Button
            className="h-7 font-sans text-[12px]"
            data-update-now
            disabled={busy || !!state.refused}
            onClick={run}
            size="sm"
            title={state.refused}
            variant="outline"
          >
            {busy ? 'Updating…' : 'Update now'}
          </Button>
        )}
      </div>
    </>
  )
}

/** The status-line item while the Ultimate clone is behind origin, or just updated and owes a restart. */
function Update() {
  const { data, refetch } = useAction(
    StateAction,
    null,
    // A failed poll keeps the last state; the next one tries again.
    { onError: () => {} },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    const timer = setInterval(() => void refetch(), 60_000)
    return () => clearInterval(timer)
  }, [refetch])
  if (!data) return null
  const updated = data.behind === 0 && data.updated
  const restartOwed = updated && (updated.layers.core || updated.layers.lockfile)
  if (!data.behind && !restartOwed && !(updated && updated.layers.bin)) return null
  const run = () => {
    setBusy(true)
    setError(undefined)
    api
      .action(UpdateAction)
      // A refusal comes back in the refreshed state; only a failing command is shown here.
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => {
        setBusy(false)
        void refetch()
      })
  }
  const label = updated ? (
    <>
      <CheckIcon className="size-3" />
      <span className="max-md:hidden">updated · </span>restart
    </>
  ) : (
    <>
      {busy ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : data.refused ? (
        <TriangleAlertIcon className="size-3" />
      ) : (
        <ArrowDownIcon className="size-3" />
      )}
      {data.behind} new<span className="max-md:hidden"> · update</span>
    </>
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            statusButton,
            busy ? 'text-brand' : updated || data.refused ? 'text-warning' : 'text-brand',
          )}
          data-update
          title="Updates to the Ultimate clone"
          type="button"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[26rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
        side="top"
      >
        <Popup busy={busy} error={error} run={run} state={data} />
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Update, order: -2 }] },
})
