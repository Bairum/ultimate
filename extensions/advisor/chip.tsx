import { ScanEyeIcon } from 'lucide-react'
import { cn, useNow, useUltimate } from '@/sdk'
import type { Severity } from './refs.ts'
import { openAdvisorPanel, openNotes, tones, useAdvisorState } from './parts.tsx'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The status-line chip for open advice across the project: concerns and blockers in their tone, open nits only as a
 * muted count. Snoozed and archived notes don't count, so clearing the panel empties it; it's hidden while nothing
 * counts, which includes every role being off.
 */
export function Chip() {
  const shell = useUltimate()
  // A minute is fine-grained enough for a snooze to wake.
  const open = openNotes(useAdvisorState(), useNow(60_000))
  const count = (severity: Severity) => open.filter((note) => note.severity === severity).length
  const blockers = count('blocker')
  const concerns = count('concern')
  const nits = count('nit')
  if (open.length === 0) return null
  const tone: Severity = blockers ? 'blocker' : concerns ? 'concern' : 'nit'
  const label =
    blockers || concerns
      ? [blockers && plural(blockers, 'blocker'), concerns && plural(concerns, 'concern')]
          .filter(Boolean)
          .join(' · ')
      : plural(nits, 'nit')
  const all = [
    blockers && plural(blockers, 'blocker'),
    concerns && plural(concerns, 'concern'),
    nits && plural(nits, 'nit'),
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <button
      aria-label={`Advisor: ${all} open`}
      className={cn(
        '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground',
        tone === 'nit' && 'text-muted-foreground/60',
      )}
      data-advisor-chip={tone}
      onClick={() => openAdvisorPanel(shell)}
      title={`Advisor: ${all} open`}
      type="button"
    >
      <ScanEyeIcon className={cn('size-3', tone !== 'nit' && tones[tone].text)} />
      {label}
    </button>
  )
}
