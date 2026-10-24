/**
 * Fall asleep, on the journal card: the chapter name to wake up in, then each step live from the session's `sleep`:
 * packing the seed, checking it on a preview, the last backup, the switch. A failed step says what failed and that
 * we stay in this chapter.
 */
import { CheckIcon, LoaderCircleIcon, MoonIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn, formatTime, useNow, useSystem, useUltimate } from '@/sdk'
import {
  BusyBlocker,
  CHAPTER_NAME,
  chapterLabel,
  chaptersDialog,
  fallAsleep,
  useBusyElsewhere,
  useChapters,
} from './chapters.tsx'
import { Moon } from './moon.tsx'
import { Granted } from './morning.tsx'
import type { Session, Sleep } from './refs.ts'

type Step = Exclude<Sleep['phase'], 'waiting' | 'asleep' | 'failed'>
const STEPS: Step[] = ['seeding', 'checking', 'backing up', 'switching']

const titles: Record<Step, string> = {
  seeding: 'Pack what carries over',
  checking: 'Check the new chapter',
  'backing up': 'Back up this chapter',
  switching: 'Switch',
}

/** The step a failed sleep stopped at, from what it recorded before failing. */
function failedAt(sleep: Sleep): Step {
  if (sleep.backup) return 'switching'
  if (!sleep.checks) return 'seeding'
  return sleep.checks.every((item) => item.ok) ? 'backing up' : 'checking'
}

/** `0:42` since `at`, for the step that is running. */
const elapsed = (now: number, at: number) => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The journal card's last section: what falling asleep does, then its progress, failure or outcome. */
export function FallAsleep({ session }: { session: Session }) {
  const sleep = session.sleep
  if (sleep && sleep.phase !== 'failed') return <Progress session={session} sleep={sleep} />
  return <Ready failed={sleep} session={session} />
}

/** Proposals the user still has to settle: open ones, or approved ones whose branch has not landed. */
const unsettled = (session: Session) =>
  session.proposals.filter((item) => item.status === 'open' || item.status === 'approved').length

function Ready({ session, failed }: { session: Session; failed?: Sleep }) {
  const chapters = useChapters()
  const busy = useBusyElsewhere()
  const pid = useSystem()?.process.pid
  const [name, setName] = useState(failed?.chapter ?? session.journal?.chapter ?? '')
  const [starting, setStarting] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const open = unsettled(session)
  const number = (chapters?.chapters.length ?? 0) + 1
  const taken = chapters?.chapters.some((item) => item.name === name)
  const invalid = !CHAPTER_NAME.test(name)
  const blocked = open > 0 || busy.length > 0
  const start = async () => {
    setStarting(true)
    setRefusal(undefined)
    setRefusal(await fallAsleep(session.id, chapterLabel(number, name), name, pid))
    setStarting(false)
  }
  // Still deciding: one quiet line, the proposals above are what matters now.
  if (open > 0 && !failed)
    return (
      <p
        className="flex items-center gap-2 border-t border-border/60 px-4 py-2 text-[12px] text-muted-foreground"
        data-dream-sleep="waiting"
      >
        <MoonIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        <span>
          Once every proposal is settled, I can fall asleep into a fresh chapter
          {session.journal?.chapter && (
            <>
              {' '}
              — <span className="font-mono text-foreground/80">{session.journal.chapter}</span>
            </>
          )}
          .
        </span>
      </p>
    )
  return (
    <section className="border-t border-border/60 px-4 pt-3 pb-3.5" data-dream-sleep="ready">
      {failed && <Failed sleep={failed} />}
      <div className="flex items-start gap-3">
        <MoonIcon className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="space-y-0.5">
            <p className="text-[13px] text-foreground">
              {failed ? 'Try falling asleep again' : 'Fall asleep'}
            </p>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              I carry my memory and open work into a fresh chapter and wake up there. This one stays
              on disk; you can come back any time.
            </p>
          </div>
          <label className="flex max-w-full items-center rounded-md border border-border bg-background font-mono text-[12.5px] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30 sm:w-fit">
            <span className="shrink-0 border-r border-border/70 px-2 py-1 text-muted-foreground">
              Chapter {number} ·
            </span>
            <input
              aria-invalid={invalid || taken || undefined}
              aria-label="Name of the new chapter"
              className="min-w-0 flex-1 bg-transparent px-2 py-1 text-foreground outline-none placeholder:text-muted-foreground/60 sm:w-56 sm:flex-none"
              data-dream-chapter-name
              disabled={starting}
              maxLength={40}
              onChange={(event) => setName(event.target.value.toLowerCase().replaceAll(' ', '-'))}
              onKeyDown={(event) =>
                event.key === 'Enter' && !invalid && !taken && !blocked && !starting && start()
              }
              placeholder="two-or-three-words"
              spellCheck={false}
              value={name}
            />
          </label>
          {(taken || (invalid && name)) && (
            <p className="text-[11.5px] text-warning">
              {taken
                ? `There already is a chapter ${name}; pick another name, or switch to it from Chapters.`
                : 'Lowercase letters, digits and dashes, up to 40.'}
            </p>
          )}
          {open > 0 && (
            <p className="text-[12px] text-muted-foreground" data-dream-blocked="proposals">
              <span className="text-foreground">
                {open === 1 ? '1 proposal is' : `${open} proposals are`} still open or in progress.
              </span>{' '}
              Settle {open === 1 ? 'it' : 'them'} with @ultimate first.
            </p>
          )}
          {open === 0 && busy.length > 0 && <BusyBlocker busy={busy} />}
          {refusal && (
            <p className="text-[12px] leading-relaxed" role="alert">
              <span className="text-error">Didn't start.</span>{' '}
              <span className="text-muted-foreground">{refusal}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button
              className="border-brand/50 hover:border-brand"
              data-dream-asleep
              disabled={blocked || invalid || !!taken || starting || !chapters}
              onClick={() => void start()}
              size="sm"
              variant="outline"
            >
              {starting ? (
                <LoaderCircleIcon className="text-brand motion-safe:animate-spin" />
              ) : (
                <MoonIcon className="text-brand" />
              )}
              Fall asleep
            </Button>
            <span className="font-mono text-[11px] text-muted-foreground">
              a few minutes · no model · restarts the server
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

/** What a failed sleep stopped at: the failing checks, or the error; and that nothing moved. */
function Failed({ sleep }: { sleep: Sleep }) {
  const chapters = useChapters()
  const step = failedAt(sleep)
  const failing = sleep.checks?.filter((item) => !item.ok) ?? []
  return (
    <div
      className="mb-3 rounded-md border border-error/30 bg-error/5 px-3 py-2.5"
      data-dream-sleep="failed"
      role="alert"
    >
      <p className="flex items-center gap-2 text-[12.5px] text-foreground">
        <Moon status="failed" />
        {step === 'checking'
          ? `The new chapter failed ${failing.length === 1 ? 'a check' : `${failing.length} checks`}`
          : `${titles[step]} failed`}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {formatTime(sleep.at)}
        </span>
      </p>
      {failing.length > 0 && (
        <Checks checks={sleep.checks!.filter((item) => !item.ok)} className="mt-1.5" />
      )}
      {step !== 'checking' && sleep.checks && (
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {sleep.checks.length} checks passed
          {sleep.backup?.id && ` · backed up ${sleep.backup.id.slice(0, 12)}`}
          {sleep.backup?.skipped && ` · backup skipped: ${sleep.backup.skipped}`}
        </p>
      )}
      {sleep.error && step !== 'checking' && (
        <p className="mt-1.5 font-mono text-[11px] leading-relaxed break-words text-error/90">
          {sleep.error.replace(/^Error: /, '')}
        </p>
      )}
      {sleep.by && (
        <div className="mt-2">
          <Granted by={sleep.by} what="tried to fall asleep" />
        </div>
      )}
      <p className="mt-2 text-[12px] text-muted-foreground">
        Nothing moved: we're still in{' '}
        <span className="text-foreground">
          {chapters ? chapterLabel(chapters.number, chapters.active) : 'this chapter'}
        </span>
        {step === 'checking' && ', and the check was repaired once already'}.
      </p>
    </div>
  )
}

/** The four steps while a sleep runs, and the outcome once it switched (seen when this chapter is opened again). */
function Progress({ session, sleep }: { session: Session; sleep: Sleep }) {
  const chapters = useChapters()
  const actions = useUltimate()
  const running = sleep.phase !== 'asleep'
  const now = useNow(1000, running)
  const current = STEPS.indexOf(sleep.phase as Step)
  // The gate repairs once: back at seeding with the first attempt's checks.
  const repairing = sleep.phase === 'seeding' && !!sleep.checks?.some((item) => !item.ok)
  const target = chapters?.chapters.find((item) => item.name === sleep.chapter)
  // A running sleep makes the next chapter; a finished one names it as listed (by name alone if it is gone).
  const number = running ? (chapters?.chapters.length ?? 0) + 1 : target?.number
  const label = number ? chapterLabel(number, sleep.chapter) : sleep.chapter
  if (sleep.phase === 'waiting')
    return (
      <section
        className="border-t border-border/60 px-4 py-2.5 text-[12px]"
        data-dream-sleep="waiting"
        data-session={session.id}
      >
        <p className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin text-brand" />
          Waiting for every conversation to finish, then falling asleep into{' '}
          <span className="text-foreground">{label}</span>
        </p>
        {sleep.by && (
          <div className="mt-1.5">
            <Granted by={sleep.by} what="started this" />
          </div>
        )}
      </section>
    )
  if (!running)
    return (
      <section
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2.5 text-[12px]"
        data-dream-sleep="asleep"
      >
        <MoonIcon className="size-3.5 text-brand" />
        <span className="text-muted-foreground">
          Fell asleep into <span className="text-foreground">{label}</span> · {formatTime(sleep.at)}
        </span>
        {sleep.by && <Granted by={sleep.by} what="fell asleep" />}
        {chapters && chapters.active !== sleep.chapter && (
          <button
            className="ml-auto cursor-pointer font-mono text-[11px] text-foreground/85 hover:text-foreground"
            onClick={() => actions.open(chaptersDialog)}
            type="button"
          >
            Chapters…
          </button>
        )}
      </section>
    )
  return (
    <section
      aria-live="polite"
      className="border-t border-border/60 px-4 pt-3 pb-3.5"
      data-dream-sleep={sleep.phase}
      data-session={session.id}
    >
      <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-foreground">
        Falling asleep
        <span className="font-mono text-[11.5px] text-muted-foreground">into {label}</span>
      </p>
      {sleep.by && <Granted by={sleep.by} what="started this" />}
      <ol className="mt-2 space-y-1.5">
        {STEPS.map((step, index) => {
          const status =
            index < current ? 'done' : index === current ? 'running' : ('waiting' as const)
          return (
            <li data-status={status} data-step={step} key={step}>
              <div className="grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-baseline gap-x-2 text-[12px] leading-5">
                <Moon className="translate-y-0.5 self-start" status={status} />
                <span
                  className={status === 'waiting' ? 'text-muted-foreground' : 'text-foreground'}
                >
                  {titles[step]}
                  <span className="text-muted-foreground">
                    {' '}
                    {detail(step, status, sleep, repairing)}
                  </span>
                </span>
                {status === 'running' && (
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {elapsed(now, sleep.at)}
                  </span>
                )}
              </div>
              {step === 'checking' && status === 'done' && sleep.checks && (
                <Checks checks={sleep.checks} className="mt-1 ml-5" />
              )}
            </li>
          )
        })}
      </ol>
      <p className="mt-2.5 text-[11.5px] text-muted-foreground">
        Start no other work until I'm asleep — anything that starts now cancels the switch.
      </p>
    </section>
  )
}

/** One step's quiet second half: what it does while running, what it found once done. */
function detail(
  step: Step,
  status: 'waiting' | 'running' | 'done',
  sleep: Sleep,
  repairing: boolean,
) {
  if (step === 'seeding')
    return repairing
      ? '— the first check failed, packing again'
      : '— memories, open to-dos, questions, automations'
  if (step === 'checking')
    return status === 'done'
      ? `— ${sleep.checks?.length ?? 0} checks passed`
      : '— a preview boots on it, no model'
  if (step === 'backing up') {
    if (sleep.backup?.id) return `— backup ${sleep.backup.id.slice(0, 12)}`
    if (sleep.backup?.skipped) return `— skipped: ${sleep.backup.skipped}`
    return '— the last cloud backup of this chapter'
  }
  return '— the server restarts into the new chapter'
}

/** Gate checks as a compact grid: a mark, the check's name, what it found. */
function Checks({
  checks,
  className,
}: {
  checks: NonNullable<Sleep['checks']>
  className?: string
}) {
  return (
    <ul className={cn('space-y-0.5 font-mono text-[11px]', className)} data-dream-checks>
      {checks.map((item) => (
        <li
          className="grid grid-cols-[0.75rem_7rem_minmax(0,1fr)] items-baseline gap-x-2 max-sm:grid-cols-[0.75rem_minmax(0,1fr)]"
          data-check={item.name}
          data-ok={item.ok}
          key={item.name}
        >
          {item.ok ? (
            <CheckIcon className="size-3 translate-y-0.5 self-start text-success/80" />
          ) : (
            <XIcon className="size-3 translate-y-0.5 self-start text-error" />
          )}
          <span className={item.ok ? 'text-foreground/80' : 'text-error'}>{item.name}</span>
          <span className="min-w-0 break-words text-muted-foreground max-sm:col-start-2">
            {item.detail}
          </span>
        </li>
      ))}
    </ul>
  )
}
