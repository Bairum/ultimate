import type { BoardMessage } from '../board/refs.ts'
import type { OverviewRow } from '../conversations/types.ts'

export type Sound = 'input' | 'finished' | 'failed'

export const sounds: { sound: Sound; label: string }[] = [
  { sound: 'input', label: 'Needs input' },
  { sound: 'finished', label: 'Finished' },
  { sound: 'failed', label: 'Failed' },
]

/**
 * What is due to sound: `key` names the event, so it sounds once. An answer without a question card is
 * `settled: false`: an extraction may still attach one, so it sounds as finished only once none can.
 */
export type Cue = { key: string; sound: Sound; settled: boolean }

/** What the cues read about the primary agent (@ultimate, or @sync in the machine home): only it talks to the user. */
export type Watched = {
  /** The primary agent's conversation id, once it exists. */
  agent?: number
  row?: OverviewRow
  messages: readonly Pick<BoardMessage, 'id' | 'from' | 'to' | 'reply'>[]
  /** The final answer carrying an open question card (`questions.board` reply). */
  asked?: { conversation: number; entry: number }
  /** Whether a question extraction for the agent's answer still runs. */
  extracting: boolean
}

/**
 * The agent's own news for the user: a failed run, an answer to the user's typed input (a question when a card asks
 * something), and each message to the user (a question when it expects a reply). Answers to other agents stay quiet.
 */
export function cuesOf({ agent, row, messages, asked }: Watched): Cue[] {
  if (agent === undefined) return []
  const cues = messages
    .filter((message) => message.from === agent && message.to === 'user')
    .map((message): Cue => ({
      key: `message:${message.id}`,
      sound: message.reply ? 'input' : 'finished',
      settled: true,
    }))
  if (row?.runState === 'error' && row.inputId !== undefined)
    cues.push({ key: `${agent}:${row.inputId}`, sound: 'failed', settled: true })
  else if (row?.runState === 'answered' && row.answerId !== undefined && !row.internalInput) {
    const card = asked?.conversation === agent && asked.entry === row.answerId
    cues.push({
      key: `${agent}:${row.answerId}`,
      sound: card ? 'input' : 'finished',
      settled: card,
    })
  }
  return cues
}

/** How long an unsettled answer waits for its question extraction to show up in the task graph. */
export const settle = 2000

/**
 * Follows the agent over time and says what is due to sound: whatever it shows at first was heard already, later news
 * is due once. `waiting` tells whether an answer still settles, to look again later.
 */
export function listener() {
  let heard: Set<string> | undefined
  let waiting = new Map<string, number>()
  return (watched: Watched, now: number) => {
    const cues = cuesOf(watched)
    const due: Cue[] = []
    if (!heard) {
      heard = new Set(cues.map((cue) => cue.key))
      return { due, waiting: false }
    }
    const still = new Map<string, number>()
    for (const cue of cues) {
      if (heard.has(cue.key)) continue
      const since = waiting.get(cue.key) ?? now
      if (!cue.settled && (watched.extracting || now - since < settle)) {
        still.set(cue.key, since)
        continue
      }
      heard.add(cue.key)
      due.push(cue)
    }
    waiting = still
    return { due, waiting: still.size > 0 }
  }
}
