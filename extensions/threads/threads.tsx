import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Message } from '../messages/refs.ts'

/** One feature's thread in @ultimate's conversation: the branch it is about, and where it starts, ends and landed. */
export type Thread = {
  /** The branch conversation. */
  id: number
  /** Its first and last entry here. */
  first: number
  last: number
  /** The landing report that landed it, and the commit. */
  landed?: { entry: number; sha: string }
  /** Messages @ultimate sent the user about it, by message id: an open question among them waits on the user. */
  asks?: number[]
}
export type Threads = {
  /** The threads of each placed entry: most have one, a turn woken by several branches has each. */
  of: ReadonlyMap<number, readonly number[]>
  /** Every thread, by its first entry. */
  threads: readonly Thread[]
}

type Data = {
  from?: unknown
  id?: unknown
  outcome?: { outcome?: unknown; conversationId?: unknown; sha?: unknown }
  source?: unknown
}

const conversation = (value: unknown, self: number) =>
  typeof value === 'number' && value !== self ? [value] : []
const address = (value: unknown, self: number) => {
  const match = /^#?(\d+)$/.exec(String(value))
  return match ? conversation(Number(match[1]), self) : []
}
const union = (...lists: (readonly number[])[]) => [...new Set(lists.flat())]

/** How a reply typed in a thread starts, so it and the turn it wakes belong to that thread. */
export const REPLY = /^Re #(\d+): /
export const reply = (thread: number, text: string) => `Re #${thread}: ${text}`

/**
 * Which feature thread each entry of @ultimate's conversation (`self`) belongs to, from what the entries and the message
 * log (`messages`) already record; no model decides it.
 *
 * - What a branch sends, its landing report and its notes belong to that branch.
 * - The user's answer to a question belongs where the question came from: the call that asked it.
 * - A turn belongs to the inputs that woke it: a run of inputs with no response between them wakes one turn.
 * - A response's calls that start a branch or message one belong to that branch; its other calls and its answer
 *   belong to the turn. A turn nothing threaded woke takes the branches its calls address, from its first input on.
 * - A tool result belongs with its call.
 *
 * Everything else (the user's own prompts, notes about main, build and to-do notes, messages from other projects)
 * belongs to no thread.
 */
export function threadsOf(
  entries: readonly EntryRecord[],
  messages: readonly Message[],
  self: number,
): Threads {
  const of = new Map<number, readonly number[]>()
  const threads = new Map<number, Thread>()
  const calls = new Map<string, readonly number[]>()
  const byId = new Map(messages.map((message) => [message.id, message]))
  // Branches a call reached: its own messages, a script's nested ones, and the branch it started.
  const reached = new Map<string, number[]>()
  for (const message of messages) {
    if (message.call === undefined || typeof message.to !== 'number' || message.to === self)
      continue
    const call = message.call.split('/')[0]
    reached.set(call, union(reached.get(call) ?? [], [message.to]))
  }
  const results = new Map<string, number[]>()
  // Who sent each delivered message, from its entry: the log is bounded, the transcript is not.
  const senders = new Map<unknown, unknown>()
  for (const entry of entries) {
    const data = (entry.data ?? {}) as Data
    if (entry.kind === 'board.message' || entry.kind === 'board.reply')
      senders.set(data.id, data.from)
    const result = entry.model?.[0]
    if (result?.role !== 'toolResult' || result.toolName !== 'branch' || result.isError) continue
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    const started = /^Branch #(\d+) started/.exec(text)
    if (started) results.set(result.toolCallId, [Number(started[1])])
  }

  const place = (entry: number, ids: readonly number[]) => {
    if (!ids.length) return
    of.set(entry, union(of.get(entry) ?? [], ids))
    for (const id of ids) {
      const thread = threads.get(id)
      if (thread) thread.last = Math.max(thread.last, entry)
      else threads.set(id, { id, first: entry, last: entry })
    }
  }
  const input = (entry: EntryRecord): readonly number[] => {
    const data = (entry.data ?? {}) as Data
    switch (entry.kind) {
      case 'board.message':
      case 'board.reply': {
        if (data.from !== 'user') return conversation(data.from, self)
        const question = byId.get(byId.get(data.id as number)?.re ?? -1)
        return question?.call === undefined ? [] : (calls.get(question.call.split('/')[0]) ?? [])
      }
      case 'workspaces.lander-report':
        return conversation(data.outcome?.conversationId, self)
      // Retired: older transcripts woke a turn with a pointer to the message.
      case 'board.wake':
        return conversation(senders.get(data.id), self)
      // Typed in a thread: the thread's composer starts it with `Re #<branch>:`.
      case 'pi.user': {
        const content = entry.model?.[0]?.content
        const text =
          typeof content === 'string'
            ? content
            : (content?.find((block) => block.type === 'text')?.text ?? '')
        const re = REPLY.exec(text)
        return re ? conversation(Number(re[1]), self) : []
      }
      default:
        return []
    }
  }

  const asked = new Map<number, number[]>()
  let wake: readonly number[] = []
  let turn: EntryRecord[] = []
  let answered = true
  for (const entry of entries) {
    const data = (entry.data ?? {}) as Data
    const message = entry.model?.[0]
    const ids = input(entry)
    place(entry.id, ids)
    const outcome = data.outcome
    if (
      entry.kind === 'workspaces.lander-report' &&
      outcome?.outcome === 'landed' &&
      typeof outcome.sha === 'string' &&
      ids.length
    )
      threads.get(ids[0])!.landed = { entry: entry.id, sha: outcome.sha }
    if (entry.input) {
      if (answered) {
        wake = ids
        turn = []
      } else wake = union(wake, ids)
      answered = false
      turn.push(entry)
      continue
    }
    if (message?.role === 'assistant') {
      answered = true
      turn.push(entry)
      const own = message.content.filter((block) => block.type === 'toolCall')
      const targets = own.map((call) =>
        union(
          reached.get(call.id) ?? [],
          results.get(call.id) ?? [],
          call.name === 'message' ? address((call.arguments as { to?: unknown }).to, self) : [],
        ),
      )
      if (!wake.length && targets.some((reach) => reach.length)) {
        // Nothing threaded woke this turn: it was about the branches it starts or messages.
        wake = union(...targets)
        for (const earlier of turn) place(earlier.id, wake)
      }
      own.forEach((call, index) => {
        const reach = targets[index].length ? targets[index] : wake
        calls.set(call.id, reach)
        // What it told the user about these threads.
        for (const sent of messages)
          if (sent.to === 'user' && sent.call?.split('/')[0] === call.id)
            for (const thread of reach) asked.set(thread, [...(asked.get(thread) ?? []), sent.id])
      })
      place(entry.id, own.length ? union(...own.map((call) => calls.get(call.id)!)) : wake)
      continue
    }
    if (message?.role === 'toolResult') {
      place(entry.id, calls.get(message.toolCallId) ?? [])
      continue
    }
    // A note from a branch, or the lander's note about its landing.
    if (entry.kind === 'lineage.note' && data.source !== 'main')
      place(entry.id, conversation(data.from, self))
    if (entry.kind === 'lineage.finished') place(entry.id, conversation(data.from, self))
  }
  for (const [id, asks] of asked) {
    const thread = threads.get(id)
    if (thread) thread.asks = asks
  }
  return { of, threads: [...threads.values()].toSorted((a, b) => a.first - b.first) }
}

/**
 * How the main stream shows `threads`. The turn a thread began in stays (the user's ask and @ultimate's answer that
 * started it), and the thread's root row follows that answer. After it, an entry of one thread leaves the stream for that
 * thread; one of several (a turn that answered several branches at once) stays.
 */
export function threading(entries: readonly EntryRecord[], { of, threads }: Threads) {
  const answers = entries.filter((entry) => {
    const message = entry.model?.[0]
    return message?.role === 'assistant' && message.stopReason !== 'toolUse'
  })
  const roots = new Map(
    threads.map((thread) => [
      thread.id,
      answers.find((entry) => entry.id >= thread.first)?.id ?? thread.first,
    ]),
  )
  // What the user typed in the main stream stays there, in their own words, even when it is about one thread.
  const typed = new Set<number>(
    entries
      .filter((entry) => {
        if (entry.kind !== 'pi.user') return false
        const content = entry.model?.[0]?.content
        const text =
          typeof content === 'string'
            ? content
            : (content?.find((block) => block.type === 'text')?.text ?? '')
        return !REPLY.test(text)
      })
      .map((entry) => entry.id),
  )
  const hidden = new Set<number>()
  for (const [entry, ids] of of)
    if (ids.length === 1 && entry > roots.get(ids[0])! && !typed.has(entry)) hidden.add(entry)
  return { of, hidden, roots }
}
