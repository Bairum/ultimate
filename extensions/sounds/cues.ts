import type { OverviewRow } from '../conversations/types.ts'

export type Sound = 'input' | 'finished' | 'failed'

export const sounds: { sound: Sound; label: string }[] = [
  { sound: 'input', label: 'Needs input' },
  { sound: 'finished', label: 'Finished' },
  { sound: 'failed', label: 'Failed' },
]

/**
 * What a conversation's overview row has to announce: `key` names the event, so it sounds once. A reply waits for
 * its assessment, which tells a question from a finished task; a reply without one in flight is `settled: false`,
 * and sounds as finished once it stays that way (the overview can briefly lag behind a starting assessment).
 */
export type Cue = { key: string; sound: Sound; settled: boolean }

export function cueOf(id: string, row: OverviewRow): Cue | undefined {
  if (row.runState === 'error' && row.inputId !== undefined)
    return { key: `${id}:${row.inputId}`, sound: 'failed', settled: true }
  if (row.runState !== 'answered' || row.answerId === undefined) return undefined
  if (row.assessmentStatus === 'pending') return undefined
  const key = `${id}:${row.answerId}`
  if (row.assessment)
    return {
      key,
      sound: row.assessment.value === 'needs_input' ? 'input' : 'finished',
      settled: true,
    }
  return { key, sound: 'finished', settled: row.assessmentStatus === 'error' }
}

/** How long a reply without an assessment in flight stays that way before it sounds as finished. */
export const settle = 2000

/**
 * Follows the overview over time and says what is due to sound: whatever it shows at first was heard already, later
 * news of a top-level conversation is due once. `waiting` tells whether a reply still settles, to look again later.
 */
export function listener() {
  let heard: Set<string> | undefined
  let waiting = new Map<string, number>()
  return (rows: Record<string, OverviewRow>, top: ReadonlySet<number>, now: number) => {
    const cues = Object.entries(rows).flatMap(([id, row]) => {
      const cue = cueOf(id, row)
      return cue ? [[Number(id), cue] as const] : []
    })
    const due: Cue[] = []
    if (!heard) {
      heard = new Set(cues.map(([, cue]) => cue.key))
      return { due, waiting: false }
    }
    const still = new Map<string, number>()
    for (const [id, cue] of cues) {
      if (heard.has(cue.key) || !top.has(id)) continue
      if (!cue.settled) {
        const since = waiting.get(cue.key) ?? now
        if (now - since < settle) {
          still.set(cue.key, since)
          continue
        }
      }
      heard.add(cue.key)
      due.push(cue)
    }
    waiting = still
    return { due, waiting: still.size > 0 }
  }
}
