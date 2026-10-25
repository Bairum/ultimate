import { ScanEyeIcon } from 'lucide-react'
import { cn, useUltimate } from '@/sdk'
import type { Severity } from './refs.ts'
import { openAdvisorPanel, openNotes, tones, useAdvisorState } from './parts.tsx'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The status-line chip for open advice across the project: concerns and blockers in their tone, open nits only as a
 * muted count. It's hidden while nothing is open, which includes every role being off.
 */
export function Chip() {
  const shell = useUltimate()
  const open = openNotes(useAdvisorState())
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
