import type { Message } from '../messages/refs.ts'
import type { OverviewRow } from '../conversations/types.ts'

export type Sound = 'input' | 'finished' | 'failed'

export const sounds: { sound: Sound; label: string }[] = [
  { sound: 'input', label: 'Needs input' },
  { sound: 'finished', label: 'Finished' },
  { sound: 'failed', label: 'Failed' },
]

/** What is due to sound: `key` names the event, so it sounds once. */
export type Cue = { key: string; sound: Sound }

/** What the cues read about the primary agent (@ultimate): only it talks to the user. */
export type Watched = {
  /** The primary agent's conversation id, once it exists. */
  agent?: number
  row?: OverviewRow
  messages: readonly Pick<Message, 'id' | 'from' | 'to' | 'reply'>[]
}

/**
 * The agent's own news for the user: a failed run, an answer to the user's typed input, and each message to the user
 * (a question when it expects a reply). Answers to other agents stay quiet.
 */
export function cuesOf({ agent, row, messages }: Watched): Cue[] {
  if (agent === undefined) return []
  const cues = messages
    .filter((message) => message.from === agent && message.to === 'user')
    .map((message): Cue => ({
      key: `message:${message.id}`,
      sound: message.reply ? 'input' : 'finished',
    }))
  if (row?.runState === 'error' && row.inputId !== undefined)
    cues.push({ key: `${agent}:${row.inputId}`, sound: 'failed' })
  else if (row?.runState === 'answered' && row.answerId !== undefined && !row.internalInput)
    cues.push({ key: `${agent}:${row.answerId}`, sound: 'finished' })
  return cues
}

/**
 * Follows the agent over time and says what is due to sound: whatever it shows at first was heard already, later news
 * is due once.
 */
export function listener() {
  let heard: Set<string> | undefined
  return (watched: Watched) => {
    const cues = cuesOf(watched)
    if (!heard) {
      heard = new Set(cues.map((cue) => cue.key))
      return []
    }
    const due = cues.filter((cue) => !heard!.has(cue.key))
    for (const cue of due) heard.add(cue.key)
    return due
  }
}
