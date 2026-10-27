import { CheckIcon, ChevronDownIcon, EllipsisIcon, ListChecksIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, errorMessage, formatAgo, useConversations, useExtensionUiState } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { AdviceText, control, DismissMenu, menuItem, NoteControls } from './card.tsx'
import { ROLES, SEVERITIES, recipient } from './refs.ts'
import type { DismissReason, NoteSelection, Role, Severity, StoredNote } from './refs.ts'
import {
  isLive,
  judgeLabel,
  manage,
  OUTCOMES,
  outcomeOf,
  outcomes,
  rank,
  reasons,
  SeverityDot,
  tones,
  useOpenNote,
} from './parts.tsx'
import type { Outcome } from './parts.tsx'

const heading = 'font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase'
const chip =
  'flex h-5 cursor-pointer items-center gap-1 rounded-sm px-1.5 font-mono text-[10.5px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring'
const chipOn = 'bg-accent text-foreground'
const chipOff = 'text-muted-foreground/70 hover:text-foreground data-[state=open]:text-foreground'
/** Above this many notes, a bulk action asks first. */
const FEW = 3

type View = 'open' | 'snoozed' | 'closed' | 'archived'
const views: Record<View, { test: (note: StoredNote, now: number) => boolean; empty: string }> = {
  open: { test: isLive, empty: 'Nothing open.' },
  snoozed: {
    test: (n, now) =>
      n.status === 'open' &&
      n.archivedAt === undefined &&
      n.snoozedUntil !== undefined &&
      n.snoozedUntil > now,
    empty: 'Nothing snoozed.',
  },
  closed: {
    test: (n) => n.status !== 'open' && n.archivedAt === undefined,
    empty: 'Nothing resolved or dismissed.',
  },
  archived: {
    test: (n) => n.archivedAt !== undefined,
    empty: 'Nothing archived.',
  },
}
const VIEWS = Object.keys(views) as View[]

/** `role:coordinator`, `conversation:42`, or everywhere. */
type Scope = '' | `role:${Role}` | `conversation:${number}`
const scopeArgs = (scope: Scope): NoteSelection =>
  scope.startsWith('role:')
    ? { role: scope.slice(5) as Role }
    : scope.startsWith('conversation:')
      ? { conversation: Number(scope.slice(13)) }
      : {}
const inScope = (scope: Scope) => {
  const args = scopeArgs(scope)
  return (n: StoredNote) =>
    (args.role === undefined || n.role === args.role) &&
    (args.conversation === undefined || n.conversation === args.conversation)
}
const plural = (n: number, word = 'note') => `${n} ${word}${n === 1 ? '' : 's'}`
const roleName = (role: Role) => (role === 'ultimate' ? '@ultimate' : role)

type Bulk = {
  /** "Dismiss 12 notes", the confirm button's words. */
  verb: string
  question: string
  count: number
  run: () => Promise<{ changed: number }>
  /** "dismissed", for "12 notes dismissed". */
  done: string
}

/**
 * Every note the advisor kept, by view (open, snoozed, closed, archived), filtered by severity and response and scoped
 * to a role or conversation; a select mode and a ⋯ menu act on many at once, asking first above a few.
 */
export function Notes({ notes, now }: { notes: StoredNote[]; now: number }) {
  // UI state comes back as plain strings: narrow each, so a value from an older build falls back to the default.
  const [storedView, setView] = useExtensionUiState('view', 'open')
  const view: View = VIEWS.includes(storedView as View) ? (storedView as View) : 'open'
  const [severity, setSeverity] = useExtensionUiState<Severity | 'all'>('filter', 'all')
  const [storedResponse, setResponse] = useExtensionUiState('response', 'all')
  const response = (OUTCOMES.includes(storedResponse as Outcome) ? storedResponse : 'all') as
    | Outcome
    | 'all'
  const [storedScope, setScope] = useExtensionUiState('scope', '')
  const scope = (/^(role:[\w-]+|conversation:\d+)$/.test(storedScope) ? storedScope : '') as Scope
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [ask, setAsk] = useState<Bulk>()
  const [result, setResult] = useState<{ text: string; error?: boolean }>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!result || result.error) return undefined
    const timer = setTimeout(() => setResult(undefined), 5000)
    return () => clearTimeout(timer)
  }, [result])

  const scoped = notes.filter(inScope(scope))
  const inView = scoped.filter((n) => views[view].test(n, now))
  const bySeverity = severity === 'all' ? inView : inView.filter((n) => n.severity === severity)
  const shown = (
    response === 'all' ? bySeverity : bySeverity.filter((n) => outcomeOf(n) === response)
  ).toSorted(
    view === 'open'
      ? (a, b) => rank(b.severity) - rank(a.severity) || b.at - a.at
      : (a, b) => (b.archivedAt ?? b.closedAt ?? b.at) - (a.archivedAt ?? a.closedAt ?? a.at),
  )
  const visible = new Set(shown.map((n) => n.id))
  const picked = [...selected].filter((id) => visible.has(id))
  const filtered = severity !== 'all' || response !== 'all'

  const go = (bulk: Bulk) => {
    setResult(undefined)
    if (bulk.count === 0) return setResult({ text: `No notes to ${bulk.done.replace(/d$/, '')}.` })
    if (bulk.count > FEW) return setAsk(bulk)
    return run(bulk)
  }
  const run = (bulk: Bulk) => {
    setBusy(true)
    bulk
      .run()
      .then(({ changed }) => {
        setAsk(undefined)
        setSelected(new Set())
        setResult({ text: `${plural(changed)} ${bulk.done}.` })
      })
      .catch((failure: unknown) => {
        setAsk(undefined)
        setResult({ text: errorMessage(failure), error: true })
      })
      .finally(() => setBusy(false))
  }
  const bulkSelected = (action: 'resolve' | 'dismiss', reason?: DismissReason) =>
    go({
      verb: `${action === 'resolve' ? 'Resolve' : 'Dismiss'} ${picked.length}`,
      question: `${action === 'resolve' ? 'Resolve' : 'Dismiss'} ${plural(picked.length, 'selected note')}${reason ? ` as ${reasons[reason]}` : ''}?`,
      count: picked.length,
      done: action === 'resolve' ? 'resolved' : 'dismissed',
      run: () => manage({ notes: picked, do: action, ...(reason ? { reason } : {}) }),
    })
  const where = scope
    ? ` in ${scope.startsWith('role:') ? roleName(scope.slice(5) as Role) : `#${scope.slice(13)}`}`
    : ''
  const clearClosed = () => {
    const count = scoped.filter(views.closed.test).length
    go({
      verb: `Archive ${count}`,
      question: `Archive ${plural(count, 'resolved or dismissed note')}${where}? They move to archived; transcript cards stay.`,
      count,
      done: 'archived',
      // The action wants at least one filter; archive only touches closed notes, so "older than 0 days" is all of them.
      run: () => manage({ olderThanDays: 0, ...scopeArgs(scope), do: 'archive' }),
    })
  }
  const dismissOlder = (days: number) => {
    const count = scoped.filter(
      (n) => n.status === 'open' && n.archivedAt === undefined && n.at < now - days * 86_400_000,
    ).length
    go({
      verb: `Dismiss ${count}`,
      question: `Dismiss ${plural(count, 'open note')} older than ${plural(days, 'day')}${where}?`,
      count,
      done: 'dismissed',
      run: () =>
        manage({
          ...scopeArgs(scope),
          status: 'open',
          olderThanDays: days,
          do: 'dismiss',
        }),
    })
  }

  return (
    <section className="border-t border-border/60 pt-2.5 pb-1" data-advisor-notes={view}>
      <h3 className={cn(heading, 'flex items-center gap-1 px-3 pb-1.5')}>
        Notes
        <span className="ml-auto flex items-center gap-0.5 tracking-normal normal-case">
          {VIEWS.map((name) => {
            const count = scoped.filter((n) => views[name].test(n, now)).length
            return name !== 'open' && name !== view && count === 0 ? null : (
              <button
                aria-pressed={view === name}
                className={cn(chip, view === name ? chipOn : chipOff)}
                key={name}
                onClick={() => {
                  setView(name)
                  setSelected(new Set())
                }}
                type="button"
              >
                {name}
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            )
          })}
        </span>
      </h3>

      <div className="flex min-w-0 flex-wrap items-center gap-0.5 px-2.5 pb-1.5">
        {(['all', ...SEVERITIES.toReversed()] as const).map((s) => {
          const count = s === 'all' ? inView.length : inView.filter((n) => n.severity === s).length
          return s !== 'all' && count === 0 && severity !== s ? null : (
            <button
              aria-label={s === 'all' ? 'Every severity' : `${s}s only`}
              aria-pressed={severity === s}
              className={cn(chip, severity === s ? chipOn : chipOff)}
              key={s}
              onClick={() => setSeverity(s)}
              type="button"
            >
              {s !== 'all' && <SeverityDot severity={s} />}
              <span className="tabular-nums">{count}</span>
              {s === 'all' ? ' all' : ''}
            </button>
          )
        })}
        <span className="mx-1 h-3 w-px bg-border/70" />
        <ResponseFilter notes={bySeverity} onChange={setResponse} value={response} />
        <ScopeFilter notes={notes} onChange={setScope} value={scope} />
        <span className="ml-auto flex items-center gap-0.5">
          {view !== 'archived' && (
            <button
              aria-pressed={selecting}
              className={cn(chip, selecting ? chipOn : chipOff)}
              onClick={() => {
                setSelecting(!selecting)
                setSelected(new Set())
              }}
              title="Select notes to resolve or dismiss together"
              type="button"
            >
              <ListChecksIcon className="size-3" />
              select
            </button>
          )}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              aria-label="Clear notes"
              className={cn(chip, chipOff)}
              disabled={busy}
            >
              <EllipsisIcon className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="py-1 font-mono text-[10.5px] font-normal text-muted-foreground">
                {scope ? `clear${where}` : 'clear everywhere'}
              </DropdownMenuLabel>
              <DropdownMenuItem className={menuItem} onSelect={clearClosed}>
                Archive resolved and dismissed
              </DropdownMenuItem>
              {[7, 30].map((days) => (
                <DropdownMenuItem
                  className={menuItem}
                  key={days}
                  onSelect={() => dismissOlder(days)}
                >
                  Dismiss open older than {days} days
                </DropdownMenuItem>
              ))}
              <p className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground/70">
                Clearing never removes the cards in transcripts.
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      {(ask || result) && (
        <div
          className={cn(
            'mx-3 mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-[12px] leading-snug',
            result?.error ? 'border-error/30 text-error' : 'border-border bg-muted/30',
          )}
          data-advisor-bulk={ask ? 'confirm' : 'result'}
          role={ask ? 'alertdialog' : 'status'}
        >
          {ask ? (
            <>
              <span className="min-w-0 flex-1 basis-40">{ask.question}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <button
                  className="h-6 cursor-pointer rounded-md px-2 text-[12px] text-muted-foreground hover:text-foreground"
                  disabled={busy}
                  onClick={() => setAsk(undefined)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  autoFocus
                  className="h-6 cursor-pointer rounded-md bg-foreground px-2 text-[12px] font-medium text-background hover:bg-foreground/85 disabled:opacity-60"
                  disabled={busy}
                  onClick={() => run(ask)}
                  type="button"
                >
                  {busy ? 'Working…' : ask.verb}
                </button>
              </span>
            </>
          ) : (
            <>
              {!result!.error && <CheckIcon className="size-3 shrink-0 text-success" />}
              <span className="min-w-0 flex-1">{result!.text}</span>
              <button
                aria-label="Close"
                className="shrink-0 cursor-pointer text-muted-foreground/70 hover:text-foreground"
                onClick={() => setResult(undefined)}
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            </>
          )}
        </div>
      )}

      {selecting && view !== 'archived' && shown.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1 px-3 pb-1.5 font-mono text-[10.5px] text-muted-foreground">
          <label className="flex cursor-pointer items-center gap-1.5 pr-1">
            <Checkbox
              aria-label="Select every shown note"
              checked={
                picked.length === 0
                  ? false
                  : picked.length === shown.length
                    ? true
                    : 'indeterminate'
              }
              className="size-3.5"
              disabled={shown.length === 0}
              onCheckedChange={(on) =>
                setSelected(new Set(on === true ? shown.map((n) => n.id) : []))
              }
            />
            {picked.length ? `${picked.length} selected` : 'select all'}
          </label>
          {picked.length > 0 && (
            <>
              <span className="mx-1 h-3 w-px bg-border/70" />
              {view !== 'closed' && (
                <>
                  <button
                    className={control}
                    disabled={busy}
                    onClick={() => bulkSelected('resolve')}
                    type="button"
                  >
                    <CheckIcon className="size-3" />
                    resolve
                  </button>
                  <DismissMenu
                    disabled={busy}
                    onDismiss={(reason) => bulkSelected('dismiss', reason)}
                  />
                </>
              )}
              {view === 'closed' && (
                <button
                  className={control}
                  disabled={busy}
                  onClick={() =>
                    go({
                      verb: `Archive ${picked.length}`,
                      question: `Archive ${plural(picked.length, 'selected note')}?`,
                      count: picked.length,
                      done: 'archived',
                      run: () => manage({ notes: picked, do: 'archive' }),
                    })
                  }
                  type="button"
                >
                  archive
                </button>
              )}
            </>
          )}
          <button
            className={cn(control, 'ml-auto')}
            onClick={() => {
              setSelecting(false)
              setSelected(new Set())
            }}
            type="button"
          >
            done
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="px-3 py-1 text-[12px] text-muted-foreground/80">
          {filtered && inView.length > 0 ? 'No notes match these filters.' : views[view].empty}
          {view === 'archived' && (
            <span className="block pt-0.5 text-[11.5px] text-muted-foreground/60">
              Archived notes stay here for 90 days after closing; transcript cards stay for good.
            </span>
          )}
        </p>
      ) : (
        <ul>
          {shown.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              now={now}
              selected={selecting && view !== 'archived' ? selected.has(note.id) : undefined}
              onSelect={(on) =>
                setSelected((previous) => {
                  const next = new Set(previous)
                  if (on) next.add(note.id)
                  else next.delete(note.id)
                  return next
                })
              }
            />
          ))}
        </ul>
      )}
      {view === 'archived' && shown.length > 0 && (
        <p className="px-3 pt-1.5 text-[11px] text-muted-foreground/60">
          Kept for 90 days after closing. Transcript cards are never removed.
        </p>
      )}
    </section>
  )
}

function ResponseFilter({
  notes,
  value,
  onChange,
}: {
  notes: StoredNote[]
  value: Outcome | 'all'
  onChange: (value: Outcome | 'all') => void
}) {
  const count = (o: Outcome) => notes.filter((n) => outcomeOf(n) === o).length
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className={cn(chip, value === 'all' ? chipOff : chipOn)}
        title="Filter by what the agent did with the note"
      >
        {value === 'all' ? (
          'any response'
        ) : (
          <span className={outcomes[value].text}>{outcomes[value].word}</span>
        )}
        <ChevronDownIcon className="size-2.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuItem className={menuItem} onSelect={() => onChange('all')}>
          any response
        </DropdownMenuItem>
        {OUTCOMES.map((o) => (
          <DropdownMenuItem
            className={cn(menuItem, value === o && 'bg-accent/60')}
            key={o}
            onSelect={() => onChange(o)}
            title={outcomes[o].title}
          >
            <span className={outcomes[o].text}>{outcomes[o].word}</span>
            <span className="ml-auto text-muted-foreground/60 tabular-nums">{count(o) || ''}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ScopeFilter({
  notes,
  value,
  onChange,
}: {
  notes: StoredNote[]
  value: Scope
  onChange: (value: Scope) => void
}) {
  const roles = ROLES.map(
    (role) => [role, notes.filter((n) => n.role === role).length] as const,
  ).filter(([, n]) => n > 0)
  const conversations = [...Map.groupBy(notes, (n) => n.conversation)]
    .map(([id, list]) => [id, list.length, Math.max(...list.map((n) => n.at))] as const)
    .toSorted((a, b) => b[2] - a[2])
    .slice(0, 12)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className={cn(chip, 'min-w-0', value ? chipOn : chipOff)}
        title="Show and clear notes of one role or conversation"
      >
        <span className="truncate">
          {value.startsWith('role:')
            ? roleName(value.slice(5) as Role)
            : value.startsWith('conversation:')
              ? `#${value.slice(13)}`
              : 'everywhere'}
        </span>
        <ChevronDownIcon className="size-2.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem className={menuItem} onSelect={() => onChange('')}>
          everywhere
          <span className="ml-auto text-muted-foreground/60 tabular-nums">{notes.length}</span>
        </DropdownMenuItem>
        {roles.length > 0 && (
          <DropdownMenuLabel className="pt-1.5 pb-0.5 font-mono text-[10.5px] font-normal text-muted-foreground/70">
            role
          </DropdownMenuLabel>
        )}
        {roles.map(([role, n]) => (
          <DropdownMenuItem
            className={menuItem}
            key={role}
            onSelect={() => onChange(`role:${role}`)}
          >
            {roleName(role)}
            <span className="ml-auto text-muted-foreground/60 tabular-nums">{n}</span>
          </DropdownMenuItem>
        ))}
        {conversations.length > 0 && (
          <DropdownMenuLabel className="pt-1.5 pb-0.5 font-mono text-[10.5px] font-normal text-muted-foreground/70">
            conversation
          </DropdownMenuLabel>
        )}
        {conversations.map(([id, n]) => (
          <DropdownMenuItem
            className={menuItem}
            key={id}
            onSelect={() => onChange(`conversation:${id}`)}
          >
            <ConversationRef className="min-w-0 font-sans text-[12px]" id={id} />
            <span className="ml-auto shrink-0 text-muted-foreground/60 tabular-nums">{n}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function NoteItem({
  note,
  now,
  selected,
  onSelect,
}: {
  note: StoredNote
  now: number
  /** Undefined outside select mode. */
  selected: boolean | undefined
  onSelect: (on: boolean) => void
}) {
  const open = useOpenNote()
  const known = useConversations().some((c) => c.id === recipient(note))
  const outcome = outcomeOf(note)
  const closed = note.status !== 'open'
  return (
    <li
      className={cn(
        'flex min-w-0 gap-2 border-b border-border/40 px-3 py-2 last:border-b-0',
        selected && 'bg-accent/40',
      )}
      data-advisor-open-note={note.id}
    >
      {selected !== undefined && (
        <Checkbox
          aria-label="Select note"
          checked={selected}
          className="mt-px size-3.5"
          onCheckedChange={(on) => onSelect(on === true)}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <SeverityDot severity={note.severity} />
          <span className={closed ? 'text-muted-foreground/70' : tones[note.severity].text}>
            {note.severity}
          </span>
          <span className="text-muted-foreground/60">·</span>
          <span className="shrink-0">{note.advisor}</span>
          <button
            className="flex min-w-0 cursor-pointer items-center hover:text-foreground hover:underline disabled:cursor-default disabled:no-underline"
            disabled={!known}
            onClick={() => open(note)}
            title={known ? `Show the note in #${recipient(note)}` : 'Conversation not available'}
            type="button"
          >
            <ConversationRef id={note.conversation} />
          </button>
          {note.routedTo !== undefined && (
            <span
              className="shrink-0 text-muted-foreground/60"
              title="Routed to the parent: the agent had finished"
            >
              → <ConversationRef id={note.routedTo} />
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {outcome && (
              <span
                className={outcomes[outcome].text}
                data-response={outcome}
                title={[
                  outcomes[outcome].title,
                  judgeLabel(note.response) && `judged by ${judgeLabel(note.response)}`,
                  note.response?.reason,
                ]
                  .filter(Boolean)
                  .join('\n')}
              >
                {outcomes[outcome].word}
              </span>
            )}
            <span className="text-muted-foreground/60" title={new Date(note.at).toLocaleString()}>
              {formatAgo(note.at, now)}
            </span>
          </span>
        </div>
        <p
          className={cn(
            'mt-1 line-clamp-3 text-[12.5px] leading-snug',
            closed ? 'text-muted-foreground' : 'text-foreground/90',
          )}
          title={note.note}
        >
          <AdviceText text={note.note} />
        </p>
        {note.response?.reason && (
          <p
            className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70"
            title={note.response.reason}
          >
            <span className="text-muted-foreground/50">agent: </span>
            {note.response.reason.replaceAll('`', '')}
          </p>
        )}
        {selected === undefined && note.archivedAt === undefined && (
          <NoteControls className="mt-1" note={note} now={now} />
        )}
        {note.archivedAt !== undefined && (
          <p className="mt-1 font-mono text-[10.5px] text-muted-foreground/60">
            {note.status}
            {note.dismissReason ? ` · ${reasons[note.dismissReason]}` : ''} · archived{' '}
            {formatAgo(note.archivedAt, now, { ago: true })}
          </p>
        )}
      </div>
    </li>
  )
}
