/**
 * Dream: a working session in which Ultimate processes what it learned. The user starts it; @ultimate starts a dream
 * branch that runs five passes and files a journal here; the proposals go to the user as decisions, and the approved
 * ones are followed until their branches land. Nothing here changes code, memory or storage by itself.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  defineDoc,
  defineExtension,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { SubmissionLanded } from '../workspaces/api.ts'
import {
  DecideAction,
  DreamDoc,
  EndAction,
  JournalAction,
  PassAction,
  StartAction,
  StatsAction,
} from './refs.ts'
import type { PassState, Proposal, Session, ToolStats } from './refs.ts'
import { busyElsewhere, PASSES } from './types.ts'
import type { PassName } from './types.ts'

export const Sessions = defineDoc<{ next: number; sessions: Session[] }>({
  kind: DreamDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ next: 1, sessions: [] }),
})
export const docs = [Sessions]
export const userActions = ['start', 'end']

const LEARNED_LINES = 3
const LINE_CHARS = 200
const JOURNAL_CHARS = 20_000
const PROPOSALS = 40
const PROPOSAL_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const STATUSES = ['waiting', 'running', 'done', 'failed'] as const
const DECISIONS = ['approved', 'rejected', 'applied'] as const

const fields = (args: unknown) =>
  args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty text`)
  if (value.trim().length > max) throw new Error(`${name} must be at most ${max} characters`)
  return value.trim()
}
const optional = (value: unknown, name: string, max: number) =>
  value === undefined ? undefined : text(value, name, max)
const positive = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`${name} must be a positive integer`)
  return value as number
}

async function find(tx: Tx, id: unknown) {
  const found = (await tx.doc(Sessions, ROOT_CONVERSATION_ID)).sessions.find(
    (item) => item.id === id,
  )
  if (!found) throw new Error(`No dream session ${String(id)}`)
  return found
}

/** The open session `id`; an ended one refuses further changes. */
async function open(tx: Tx, id: unknown) {
  const found = await find(tx, id)
  if (found.endedAt !== undefined) throw new Error(`Dream session ${found.id} has ended`)
  return found
}

/** A session ends by itself once its journal is filed and every proposal is rejected, applied or landed. */
function settle(found: Session, now: number) {
  if (
    found.journal &&
    found.endedAt === undefined &&
    found.proposals.every((item) => item.status !== 'open' && item.status !== 'approved')
  )
    found.endedAt = now
}

/** Record a new session in `tx`; refuses while one is open. */
export async function startSession(tx: Tx, now: number) {
  const doc = await tx.doc(Sessions, ROOT_CONVERSATION_ID)
  const active = doc.sessions.find((item) => item.endedAt === undefined)
  if (active)
    throw new Error(
      `Dream session ${active.id} is still open; finish or end it before dreaming again`,
    )
  const passes = Object.fromEntries(PASSES.map((pass) => [pass, { status: 'waiting' }])) as Record<
    PassName,
    PassState
  >
  const created: Session = { id: doc.next++, startedAt: now, passes, proposals: [] }
  doc.sessions.push(created)
  return created.id
}

/** The dream branch reports pass `pass` of `session`; its first report names it the session's dreamer. */
export async function reportPass(tx: Tx, args: unknown, caller: number | undefined) {
  const input = fields(args)
  const found = await open(tx, input.session)
  if (!PASSES.includes(input.pass as PassName))
    throw new Error(`pass must be one of ${PASSES.join(', ')}`)
  if (!STATUSES.includes(input.status as PassState['status']))
    throw new Error(`status must be one of ${STATUSES.join(', ')}`)
  const note = optional(input.note, 'note', LINE_CHARS)
  found.passes[input.pass as PassName] = {
    status: input.status as PassState['status'],
    ...(note ? { note } : {}),
  }
  if (caller !== undefined) found.dreamer ??= caller
  return found
}

/**
 * File the journal of `session` once; `filed` says this call filed it. A repeated call, even after the session ended,
 * returns the journal already filed, unchanged.
 */
export async function fileJournal(tx: Tx, args: unknown, now: number) {
  const input = fields(args)
  const found = await find(tx, input.session)
  if (found.journal) return { found, filed: false }
  if (found.endedAt !== undefined) throw new Error(`Dream session ${found.id} has ended`)
  if (!Array.isArray(input.learned) || input.learned.length !== LEARNED_LINES)
    throw new Error(`learned must be ${LEARNED_LINES} lines`)
  const learned = input.learned.map((line, index) => text(line, `learned[${index}]`, LINE_CHARS))
  const body = text(input.text, 'text', JOURNAL_CHARS)
  if (!Array.isArray(input.proposals) || input.proposals.length > PROPOSALS)
    throw new Error(`proposals must be a list of at most ${PROPOSALS}`)
  const seen = new Set<string>()
  const proposals = input.proposals.map((value, index): Proposal => {
    const item = fields(value)
    if (typeof item.id !== 'string' || !PROPOSAL_ID.test(item.id) || seen.has(item.id))
      throw new Error(`proposals[${index}].id must be a unique slug`)
    seen.add(item.id)
    if (!PASSES.includes(item.pass as PassName))
      throw new Error(`proposals[${index}].pass must be one of ${PASSES.join(', ')}`)
    const size = optional(item.size, `proposals[${index}].size`, 40)
    const risk = optional(item.risk, `proposals[${index}].risk`, LINE_CHARS)
    const retire = optional(item.retire, `proposals[${index}].retire`, 48)
    return {
      id: item.id,
      pass: item.pass as PassName,
      title: text(item.title, `proposals[${index}].title`, LINE_CHARS),
      ...(size ? { size } : {}),
      ...(risk ? { risk } : {}),
      ...(retire ? { retire } : {}),
      status: 'open',
    }
  })
  found.journal = { learned, text: body, at: now }
  found.proposals = proposals
  settle(found, now)
  return { found, filed: true }
}

/** @ultimate records the user's decision on one proposal; an approved one names its branch. */
export async function decide(tx: Tx, args: unknown, now: number) {
  const input = fields(args)
  const found = await open(tx, input.session)
  const proposal = found.proposals.find((item) => item.id === input.proposal)
  if (!proposal) throw new Error(`No proposal ${String(input.proposal)} in session ${found.id}`)
  if (proposal.status === 'landed') throw new Error(`Proposal ${proposal.id} already landed`)
  if (!DECISIONS.includes(input.status as (typeof DECISIONS)[number]))
    throw new Error(`status must be one of ${DECISIONS.join(', ')}`)
  proposal.status = input.status as Proposal['status']
  if (proposal.status === 'approved') proposal.branch = positive(input.branch, 'branch')
  else delete proposal.branch
  settle(found, now)
  return { ...proposal }
}

/** A landed branch lands the approved proposals it carries, in every open session. */
export async function landed(tx: Tx, branch: number, sha: string, now: number) {
  for (const found of (await tx.doc(Sessions, ROOT_CONVERSATION_ID)).sessions) {
    if (found.endedAt !== undefined) continue
    for (const proposal of found.proposals)
      if (proposal.status === 'approved' && proposal.branch === branch) {
        proposal.status = 'landed'
        proposal.sha = sha
      }
    settle(found, now)
  }
}

/** The model text of a filed journal: what @ultimate reads, with the proposal ids `decide` takes. */
export function journalText(found: Session) {
  return [
    `Dream session ${found.id} journal (the card above shows it to the user).`,
    ...found.journal!.learned.map((line) => `- ${line}`),
    '',
    found.proposals.length
      ? `Proposals (record each decision with ultimate.action('dream', 'decide', {session: ${found.id}, proposal, status, branch?})):`
      : 'No proposals.',
    ...found.proposals.map(
      (item) =>
        `- ${item.id} [${item.pass}]${item.size ? ` (${item.size})` : ''}: ${item.title}${item.retire ? ` — retires memory ${item.retire} once landed` : ''}`,
    ),
  ].join('\n')
}

/** Tool calls in `trace.sqlite`: per tool, the most frequent errors, and `enabled` tools never called in its window. */
export function toolStats(database: string, enabled: readonly string[]): ToolStats {
  if (!existsSync(database))
    return { calls: 0, tools: [], unused: [...enabled].toSorted(), errors: [] }
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const window = db
      .prepare("SELECT min(at) AS since, count(*) AS calls FROM calls WHERE kind = 'tool'")
      .get() as { since: number | null; calls: number }
    const tools = (
      db
        .prepare(
          "SELECT name, count(*) AS calls, sum(ok = 0) AS failed, avg(ms) AS avgMs FROM calls WHERE kind = 'tool' GROUP BY name ORDER BY calls DESC",
        )
        .all() as { name: string; calls: number; failed: number; avgMs: number }[]
    ).map((row) => ({ ...row, avgMs: Math.round(row.avgMs) }))
    const errors = db
      .prepare(
        "SELECT name, substr(error, 1, 160) AS error, count(*) AS count FROM calls WHERE kind = 'tool' AND ok = 0 GROUP BY name, substr(error, 1, 160) ORDER BY count DESC LIMIT 20",
      )
      .all() as { name: string; error: string; count: number }[]
    const used = new Set(tools.map((tool) => tool.name))
    return {
      ...(window.since === null ? {} : { since: window.since }),
      calls: window.calls,
      tools,
      unused: enabled.filter((name) => !used.has(name)).toSorted(),
      errors,
    }
  } finally {
    db.close()
  }
}

type Delivery = {
  to: number
  type: 'input' | 'write'
  session: number
  kind: 'dream.started' | 'dream.journal'
  content: string
}

/**
 * Submits one dream entry to @ultimate; created in the commit that records it, so a crash cannot lose it. The host's
 * conversation handle, not the task runtime's, admits a passive write.
 */
const deliverTask = (host: Pick<ExtensionHost, 'harness'>) =>
  defineTask<Delivery, { phase: 'submit' }, null>({
    name: 'dream.deliver',
    version: 1,
    initial: () => ({ phase: 'submit' }),
    phases: {
      submit: async (task, runtime, ctx) => {
        const { to, type, session, kind, content } = task.input
        const requestId = `${kind}:${session}`
        const data = { session }
        const target = (await host.harness().conversation(to as ConversationId, ctx))!
        if (type === 'input')
          await target.submit(
            { type: 'input', requestId, content, entry: { kind, data }, whenBusy: 'followUp' },
            ctx,
          )
        else
          await target.submit(
            {
              type: 'write',
              requestId,
              entry: { kind, data, model: [{ role: 'user', content, timestamp: Date.now() }] },
            },
            ctx,
          )
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

const deliver = (
  host: Pick<ExtensionHost, 'harness'>,
  tx: Tx,
  to: number,
  delivery: Omit<Delivery, 'to'>,
) =>
  tx.createTask(
    deliverTask(host),
    { to, ...delivery },
    { conversationId: to as ConversationId, ownership: { kind: 'conversation' }, background: true },
  )

const ultimateOf = async (tx: Tx) => (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate

export const actions = {
  start: implementAction(StartAction, async (_args, { host }) => {
    const ultimate = await host.need(SubagentsApi).standing('ultimate', context)
    const busy = busyElsewhere(host.conversations(), ultimate)
    if (busy.length)
      throw new Error(
        `Wait for these to finish before dreaming: ${busy.map((item) => `#${item.id} ${item.title}`).join(', ')}`,
      )
    const session = await host.harness().commit(async (tx) => {
      const id = await startSession(tx, Date.now())
      await deliver(host, tx, ultimate, {
        type: 'input',
        session: id,
        kind: 'dream.started',
        content: `The user started dream session ${id}. Follow "For @ultimate" in the clone's extensions/dream/DREAM.md: start the dream branch now.`,
      })
      return id
    }, context)
    host.harness().resume()
    return { session }
  }),
  end: implementAction(EndAction, async (args, { host }) =>
    host.harness().commit(async (tx) => {
      const found = await open(tx, fields(args).session)
      found.endedAt = Date.now()
      return { session: found.id }
    }, context),
  ),
  pass: implementAction(PassAction, async (args, { host, conversationId }) =>
    host.harness().commit(async (tx) => {
      const found = await reportPass(tx, args, conversationId)
      return { session: found.id }
    }, context),
  ),
  journal: implementAction(JournalAction, async (args, { host }) => {
    const result = await host.harness().commit(async (tx) => {
      const { found, filed } = await fileJournal(tx, args, Date.now())
      if (filed) {
        const ultimate = await ultimateOf(tx)
        if (ultimate === undefined) throw new Error('@ultimate has no conversation yet')
        // A passive write: @ultimate reads it with the dream branch's answer, which wakes it.
        await deliver(host, tx, ultimate, {
          type: 'write',
          session: found.id,
          kind: 'dream.journal',
          content: journalText(found),
        })
      }
      return { session: found.id, proposals: found.proposals.length }
    }, context)
    host.harness().resume()
    return result
  }),
  decide: implementAction(DecideAction, async (args, { host }) =>
    host.harness().commit((tx) => decide(tx, args, Date.now()), context),
  ),
  stats: implementAction(StatsAction, (_args, { host }) =>
    toolStats(
      join(host.home, 'trace.sqlite'),
      host
        .extensions()
        .filter((item) => item.enabled)
        .flatMap((item) => item.server?.tools.map((tool) => tool.name) ?? []),
    ),
  ),
}

export default function dream(host: ExtensionHost) {
  // Approved proposals are followed to landing: their branch's landing settles them.
  host.react('landed', [SubmissionLanded], (tx, { data }) =>
    landed(tx, data.conversationId, data.sha, Date.now()),
  )
  return defineExtension({ name: 'dream', tasks: [deliverTask(host)] })
}
