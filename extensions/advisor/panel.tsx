import { CircleAlertIcon, ScanEyeIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  cn,
  errorMessage,
  formatAgo,
  useAction,
  useConversations,
  useExtensionUiState,
  useNow,
} from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { Editor } from './editor.tsx'
import { Notes } from './notes.tsx'
import { Rates } from './rates.tsx'
import { ConfigAction, ROLES, SEVERITIES } from './refs.ts'
import type { AdvisorStateDoc, ConfigView, Role } from './refs.ts'
import { SeverityDot, tones, useAdvisorState, useOpenNote, usd } from './parts.tsx'

const heading = 'font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase'
const today = () => new Date().toISOString().slice(0, 10)

export function AdvisorPanel() {
  const [tab, setTab] = useExtensionUiState<'activity' | 'settings'>('tab', 'activity')
  const config = useAction(ConfigAction, null, { onError: () => {} })
  const [fresh, setFresh] = useState<ConfigView>()
  const view = fresh ?? config.data
  const state = useAdvisorState()
  const on = ROLES.filter((role) => view?.effective.roles?.[role]?.enabled)
  return (
    <div className="flex min-h-full flex-col" data-advisor-panel={tab}>
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <span className={heading}>Advisor</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground/70">
          {view ? (on.length ? `${on.length} of ${ROLES.length} roles on` : 'all roles off') : ''}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {(['activity', 'settings'] as const).map((name) => (
            <button
              aria-pressed={tab === name}
              className={cn(
                'h-6 cursor-pointer rounded-md px-2 font-mono text-[11px] text-muted-foreground transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
                tab === name ? 'bg-accent text-foreground' : 'hover:text-foreground',
              )}
              key={name}
              onClick={() => setTab(name)}
              type="button"
            >
              {name}
            </button>
          ))}
        </span>
      </div>
      {config.error && !view ? (
        <p className="flex items-start gap-1.5 px-3 py-2 font-mono text-[11.5px] text-error">
          <CircleAlertIcon className="mt-px size-3 shrink-0" />
          {errorMessage(config.error).replace(/^advisor\/config: /, '')}
        </p>
      ) : !view ? (
        <p className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">loading…</p>
      ) : tab === 'settings' ? (
        <Editor onSaved={setFresh} view={view} />
      ) : (
        <Activity onSettings={() => setTab('settings')} state={state} view={view} />
      )}
    </div>
  )
}

function Activity({
  state,
  view,
  onSettings,
}: {
  state: AdvisorStateDoc
  view: ConfigView
  onSettings: () => void
}) {
  const now = useNow(60_000)
  const anyOn = ROLES.some((role) => view.effective.roles?.[role]?.enabled)
  const rows = Object.entries(state.conversations).toSorted(
    ([, a], [, b]) => (b.lastAt ?? 0) - (a.lastAt ?? 0),
  )
  if (!anyOn && rows.length === 0 && state.notes.length === 0)
    return (
      <div className="flex flex-col items-center px-6 pt-8 pb-6 text-center">
        <ScanEyeIcon className="size-5 text-muted-foreground/60" />
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
          A second model reads agent conversations and leaves advice when it finds a gap: an
          unverified claim, a step outside scope, a promise left open. Every role is off. Turn one
          on to start, and keep the daily budget small.
        </p>
        <Button className="mt-3.5 h-7 text-[12px]" onClick={onSettings} size="sm" variant="outline">
          Choose roles
        </Button>
      </div>
    )
  return (
    <div className="pb-4">
      {!view.effective.model &&
        ROLES.some(
          (role) =>
            view.effective.roles?.[role]?.enabled &&
            !(view.effective.roles?.[role]?.advisors ?? []).some(
              (a) => view.effective.advisors?.[a]?.model,
            ),
        ) && (
          <p className="mx-3 mb-2 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-[12px] leading-snug text-warning">
            <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
            <span>
              No model set: reviews skip.{' '}
              <button
                className="cursor-pointer underline underline-offset-2"
                onClick={onSettings}
                type="button"
              >
                Set one in settings
              </button>
            </span>
          </p>
        )}
      <Spend state={state} view={view} />
      <Notes notes={state.notes} now={now} />
      <Rates notes={state.notes} now={now} />
      <section className="border-t border-border/60 px-3 pt-2.5 pb-1">
        <h3 className={cn(heading, 'flex items-center pb-1')}>
          Conversations
          <span className="ml-auto tracking-normal normal-case text-muted-foreground/60">
            {rows.length || ''}
          </span>
        </h3>
        {rows.length === 0 ? (
          <p className="py-1 text-[12px] text-muted-foreground/80">No reviews yet.</p>
        ) : (
          <ul className="-mx-1.5">
            {rows.map(([id, activity]) => (
              <ActivityRow activity={activity} id={Number(id)} key={id} now={now} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** Today's spend: a meter against the global budget, then each role that spent or has a budget of its own. */
function Spend({ state, view }: { state: AdvisorStateDoc; view: ConfigView }) {
  const spend = state.spend[today()] ?? { total: 0, roles: {} }
  const budget = view.effective.dayUsd ?? 5
  const roles = ROLES.filter(
    (role) => (spend.roles[role] ?? 0) > 0 || view.effective.roles?.[role]?.dayUsd !== undefined,
  )
  return (
    <section className="px-3 pt-1 pb-2.5">
      <h3 className={cn(heading, 'flex items-center pb-1.5')}>
        Today
        <span className="ml-auto tracking-normal normal-case text-muted-foreground/60">
          UTC day
        </span>
      </h3>
      <Budget label="all roles" spent={spend.total} budget={budget} />
      {roles.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {roles.map((role) => (
            <Budget
              budget={view.effective.roles?.[role]?.dayUsd}
              key={role}
              label={role === 'ultimate' ? '@ultimate' : role}
              muted
              spent={spend.roles[role] ?? 0}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function Budget({
  label,
  spent,
  budget,
  muted,
}: {
  label: string
  spent: number
  budget?: number
  muted?: boolean
}) {
  const share = budget ? spent / budget : 0
  const tone = share >= 1 ? 'bg-error' : share >= 0.8 ? 'bg-warning' : 'bg-foreground/40'
  return (
    <div className="flex items-center gap-2 font-mono text-[11.5px] tabular-nums">
      <span
        className={cn(
          'w-28 shrink-0 truncate',
          muted ? 'text-muted-foreground' : 'text-foreground/85',
        )}
      >
        {label}
      </span>
      {budget !== undefined ? (
        <span className="relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn('absolute inset-y-0 left-0 rounded-full', tone)}
            style={{ width: `${Math.min(100, share * 100)}%` }}
          />
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <span
        className={cn('shrink-0 text-right', share >= 1 ? 'text-error' : 'text-muted-foreground')}
      >
        {usd(spent)}
        <span className="text-muted-foreground/60">
          {budget !== undefined ? ` / $${budget}` : ''}
        </span>
      </span>
    </div>
  )
}

function ActivityRow({
  id,
  activity,
  now,
}: {
  id: number
  activity: AdvisorStateDoc['conversations'][string]
  now: number
}) {
  const open = useOpenNote()
  const known = useConversations().some((c) => c.id === id)
  const role: Role = activity.role
  return (
    <li className="rounded-md px-1.5 py-1.5 hover:bg-accent/40" data-advisor-activity={id}>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <button
          className="flex min-w-0 cursor-pointer items-center hover:underline disabled:cursor-default disabled:no-underline"
          disabled={!known}
          onClick={() => open({ id: '', conversation: id })}
          title={known ? `Show #${id}` : 'Conversation not available'}
          type="button"
        >
          <ConversationRef id={id} />
        </button>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
          {role === 'ultimate' ? '' : role}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {usd(activity.usd)}
        </span>
      </div>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground/80 tabular-nums">
        <span>
          {activity.reviews} {activity.reviews === 1 ? 'review' : 'reviews'}
        </span>
        {activity.skipped > 0 && (
          <span title={activity.lastSkip ? `Last skip: ${activity.lastSkip}` : undefined}>
            {activity.skipped} skipped
            {activity.lastSkip && (
              <span className="text-muted-foreground/60"> · {activity.lastSkip.slice(0, 40)}</span>
            )}
          </span>
        )}
        {SEVERITIES.toReversed().map((s) =>
          activity.notes[s] ? (
            <span className={cn('flex items-center gap-1', s !== 'nit' && tones[s].text)} key={s}>
              <SeverityDot severity={s} />
              {activity.notes[s]}
            </span>
          ) : null,
        )}
        {activity.lastAt && (
          <span className="ml-auto text-muted-foreground/60">
            {formatAgo(activity.lastAt, now)}
          </span>
        )}
      </div>
    </li>
  )
}
