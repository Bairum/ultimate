// Faux only: the agents of a busy half hour in the call trace, to preview the System surface's Agent Lanes. Rows go
// straight into `<home>/trace.sqlite` with past start times, which the live trace cannot record, in finish order as
// the trace writes them; one worker keeps working in the present. Their `subagents.started` and `board.sent` events
// go straight into the event log for the same reason: with past times, and the spawning call as their context.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { EventContext } from '../../shared/events.ts'
import { MessageSent } from '../messages/api.ts'
import { Started, SubagentsApi } from '../subagents/api.ts'

const OPUS = 'anthropic/claude-opus-4-5'
const CODEX = 'openai/gpt-5.1-codex'

type Row = {
  id?: string
  at: number
  ms: number
  kind: 'tool' | 'model' | 'action'
  name: string
  conversation: number
  error?: string
  args?: string
  children?: Row[]
}

/**
 * A run of `tools` from `start` (minutes before now): a model call of 6–14 s before each tool, under the 20 s of quiet
 * that ends a run, so each step takes 15–25 s.
 */
function run(
  conversation: number,
  start: number,
  tools: (string | [string, string])[],
  model = OPUS,
) {
  const rows: Row[] = []
  let at = Date.now() - start * 60_000
  for (const step of tools) {
    const [name, error] = typeof step === 'string' ? [step, undefined] : step
    const thinking = 6000 + ((rows.length * 3) % 5) * 2000
    rows.push({ at, ms: thinking, kind: 'model', name: model, conversation })
    at += thinking + 400
    const ms = name === 'bash' ? 7000 : 400 + (rows.length % 4) * 300
    rows.push({
      id: randomUUID(),
      at,
      ms,
      kind: 'tool',
      name,
      conversation,
      ...(error ? { error } : {}),
    })
    at += ms + 1500
  }
  return rows
}

/** `count` tools cycling through `names`, for a long run. */
const cycle = (names: string[], count: number) =>
  Array.from({ length: count }, (_, index) => names[index % names.length])

function insert(database: DatabaseSync, rows: Row[]) {
  const statement = database.prepare(
    `INSERT INTO calls (id, parent, trace, at, ms, caller, callee, kind, name, ok, error, args, result, conversation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const flat: { row: Row; id: string; parent: string | null; trace: string }[] = []
  const walk = (row: Row, parent: { id: string; trace: string } | undefined) => {
    const id = row.id ?? randomUUID()
    flat.push({ row, id, parent: parent?.id ?? null, trace: parent?.trace ?? id })
    for (const child of row.children ?? []) walk(child, { id, trace: parent?.trace ?? id })
  }
  for (const row of rows) walk(row, undefined)
  // The trace writes a call when it settles, so its position is finish order.
  flat.sort((a, b) => a.row.at + a.row.ms - (b.row.at + b.row.ms))
  database.exec('BEGIN')
  for (const { row, id, parent, trace } of flat) {
    const model = row.kind === 'model'
    statement.run(
      id,
      parent,
      trace,
      row.at,
      row.ms,
      model ? 'pi' : row.kind === 'action' ? 'codemode' : 'agent',
      model
        ? row.name.split('/')[0]
        : row.kind === 'action'
          ? row.name.split('/')[0]
          : 'coding-tools',
      row.kind,
      row.name,
      row.error ? 0 : 1,
      row.error ?? null,
      row.args ?? null,
      model
        ? JSON.stringify({ input: 18_420, output: 612, cacheRead: 14_100, stopReason: 'toolUse' })
        : null,
      row.conversation,
    )
  }
  database.exec('COMMIT')
}

/** Write `rows` into the trace at `file`, closing it whatever happens. */
function write(file: string, rows: Row[]) {
  const database = new DatabaseSync(file)
  try {
    database.exec('PRAGMA busy_timeout = 2000')
    insert(database, rows)
  } finally {
    database.close()
  }
}

let ticker: ReturnType<typeof setInterval> | undefined

/** Stop the calls `keepCalling` writes; the faux extension calls it when it closes or reloads. */
export function stopCalling() {
  clearInterval(ticker)
  ticker = undefined
}

/**
 * Conversation `conversation` keeps working: a tool or model call every 3 s for an hour, written into the trace at
 * `file`, replacing the calls of an earlier seed.
 */
export function keepCalling(file: string, conversation: number) {
  stopCalling()
  const until = Date.now() + 60 * 60_000
  let step = 0
  const names = ['edit', 'bash', 'read', 'edit', 'screenshot']
  ticker = setInterval(() => {
    if (Date.now() > until) return stopCalling()
    const at = Date.now() - 2000
    write(file, [
      step++ % 2
        ? { at, ms: 1800, kind: 'model', name: CODEX, conversation }
        : { at, ms: 600, kind: 'tool', name: names[step % names.length], conversation },
    ])
  }, 3000).unref()
}

/** The `nth` (from 0) tool call named `name` among `rows`. */
function pick(rows: Row[], name: string, nth = 0) {
  const found = rows.filter((row) => row.kind === 'tool' && row.name === name)[nth]
  if (!found?.id) throw new Error(`No ${name} call #${nth} in the seed`)
  return found as Row & { id: string }
}

/** The context an event emitted inside tool call `call` carries. */
const inside = (call: Row & { id: string }): EventContext => ({
  traceId: call.id,
  parentCall: call.id,
  conversationId: call.conversation,
})

/**
 * Append `event` with `data` to the event log as if emitted at `at` (epoch ms) in `context`. `host.emit` stamps the
 * present and the running call, which a seed of the past has neither of.
 */
async function append(
  tx: Tx,
  log: ConversationId,
  event: { kind: string; version: number },
  data: JsonValue,
  at: number,
  context?: EventContext,
) {
  await tx.appendEntry(log, {
    kind: event.kind,
    data: {
      v: event.version,
      at: new Date(at).toISOString(),
      data,
      ...(context ? { context } : {}),
    },
  })
}

/**
 * Creates a small team next to @ultimate and the lander and writes the last 30 minutes of its tool and model calls
 * (one failing) into the trace, with the events that tie it together. @ultimate branched two coordinators. Coordinator
 * A started two workers and a reviewer, which started two sub-reviewers; coordinator B started one worker, forked
 * from it without an event, so its spawn is inferred, as is that of the sub-reviewers (events without a call). The
 * agents message each other. A's second worker keeps calling every few seconds for an hour, so its run stays open and
 * grows into now.
 */
export async function seedLanes(host: ExtensionHost) {
  const ultimate = await host.need(SubagentsApi).standing('ultimate', BACKGROUND_CONTEXT)
  const ids = await host.harness().commit(async (tx) => {
    // A faux home has a handful of conversations; the first page holds the lander and the event log, which exists
    // since the server's start. Reads come before any write.
    let lander: ConversationId | undefined
    let log: ConversationId | undefined
    for (const record of (await tx.scanConversations({}, 100)).items) {
      const { label } = await tx.doc(host.metadata, record.id)
      if (label === 'lander') lander = record.id
      if (label === 'events') log = record.id
    }
    if (log === undefined) throw new Error('No event log to seed')
    const create = async (title: string, label?: string) => {
      const { id } = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      Object.assign(await tx.doc(host.metadata, id), { title, ...(label ? { label } : {}) })
      return id
    }
    const b = await create('Faster model picker', 'coordinator')
    const prompt = await tx.appendEntry(b, {
      kind: 'pi.user',
      model: [{ role: 'user', content: 'Make the model picker open instantly.', timestamp: 0 }],
    })
    return {
      log,
      lander,
      a: await create('System surface: a live stream of everything', 'coordinator'),
      b,
      prompt: prompt.id,
      finished: await create('T2: paged, filterable stream action', 'worker'),
      running: await create('T3: the System surface', 'worker'),
      reviewer: await create('Review: the System surface', 'reviewer'),
      correctness: await create('Review correctness: lanes and links', 'reviewer'),
      ux: await create('Review UX: the lane tree', 'reviewer'),
    }
  }, BACKGROUND_CONTEXT)
  // B's worker is a fork of B's prompt, as a subagent with `fork` is: its parent shows as `branchOf`. A conversation
  // forks only once it is committed.
  const bWorker = await host.harness().commit(async (tx) => {
    const forked = await tx.forkConversation(ids.b, ids.prompt, {
      ownership: { kind: 'ownerless' },
    })
    Object.assign(await tx.doc(host.metadata, forked.id), {
      title: 'T1: cache the model list',
      label: 'worker',
    })
    return forked.id
  }, BACKGROUND_CONTEXT)

  const lanes = {
    ultimate: [
      ...run(ultimate, 29, ['read', 'branch', 'read', 'branch', 'message']),
      ...run(ultimate, 12.5, ['message', 'read']),
    ],
    a: [
      ...run(ids.a, 27.5, cycle(['read', 'grep', 'read', 'plan'], 10)),
      ...run(ids.a, 19.5, ['plan', 'subagent']),
      ...run(ids.a, 15.5, cycle(['read', 'bash', 'workspace'], 7)),
      ...run(ids.a, 10, ['plan', 'subagent', 'message']),
      ...run(ids.a, 8.3, ['subagent', 'plan']),
    ],
    b: [
      ...run(ids.b, 26, ['read', 'read', 'plan', 'subagent', 'read']),
      ...run(ids.b, 14, ['read', 'plan']),
    ],
    finished: [
      ...run(
        ids.finished,
        18.5,
        [
          ...cycle(['read', 'edit', 'edit', 'bash'], 12),
          ['bash', 'exit 1: 2 tests failed'],
          ...cycle(['edit', 'bash'], 8),
        ],
        CODEX,
      ),
      ...run(ids.finished, 10.8, ['edit', 'bash', 'workspace', 'message'], CODEX),
    ],
    running: run(
      ids.running,
      7.5,
      [...cycle(['read', 'grep'], 6), ...cycle(['edit', 'edit', 'bash', 'screenshot'], 15)],
      CODEX,
    ),
    reviewer: [
      ...run(ids.reviewer, 9.3, ['read', 'subagent', 'subagent', 'read']),
      ...run(ids.reviewer, 4.5, ['read', 'message']),
    ],
    correctness: run(ids.correctness, 8, [...cycle(['read', 'grep'], 8), 'message']),
    ux: run(ids.ux, 7.6, [...cycle(['screenshot', 'read'], 6), 'message']),
    bWorker: [
      ...run(bWorker, 24.5, cycle(['read', 'edit', 'bash'], 18), CODEX),
      ...run(bWorker, 13.5, ['bash', 'message'], CODEX),
    ],
  }

  await host.harness().commit(async (tx) => {
    const started = (id: number, agent: string, kind: 'standing' | 'branch' | 'child') => ({
      id,
      agent,
      model: agent === 'worker' ? CODEX : OPUS,
      kind,
    })
    const event = (
      token: { kind: string; version: number },
      data: JsonValue,
      at: number,
      context?: EventContext,
    ) => append(tx, ids.log, token, data, at, context)
    const exact = (data: JsonValue, call: Row & { id: string }) =>
      event(Started, data, call.at + call.ms / 2, inside(call))
    await event(Started, started(ultimate, 'ultimate', 'standing'), Date.now() - 31 * 60_000)
    // Lineage names the root a branch forked from as its parent; the call that branched names who asked.
    await exact(
      { ...started(ids.a, 'coordinator', 'branch'), parent: 1 },
      pick(lanes.ultimate, 'branch'),
    )
    await exact(
      { ...started(ids.b, 'coordinator', 'branch'), parent: 1 },
      pick(lanes.ultimate, 'branch', 1),
    )
    await exact(
      { ...started(ids.finished, 'worker', 'child'), parent: ids.a },
      pick(lanes.a, 'subagent'),
    )
    await exact(
      { ...started(ids.reviewer, 'reviewer', 'child'), parent: ids.a },
      pick(lanes.a, 'subagent', 1),
    )
    await exact(
      { ...started(ids.running, 'worker', 'child'), parent: ids.a },
      pick(lanes.a, 'subagent', 2),
    )
    // The sub-reviewers' events carry no call, as events from before calls were recorded did.
    for (const [nth, id] of [ids.correctness, ids.ux].entries()) {
      const call = pick(lanes.reviewer, 'subagent', nth)
      await event(
        Started,
        { ...started(id, 'reviewer', 'child'), parent: ids.reviewer },
        call.at + call.ms,
      )
    }
    const messages: [Row[], number, number, number][] = [
      [lanes.ultimate, 0, ultimate, ids.b],
      [lanes.ultimate, 1, ultimate, ids.a],
      [lanes.finished, 0, ids.finished, ids.a],
      [lanes.a, 0, ids.a, ultimate],
      [lanes.correctness, 0, ids.correctness, ids.reviewer],
      [lanes.ux, 0, ids.ux, ids.reviewer],
      [lanes.reviewer, 0, ids.reviewer, ids.a],
      [lanes.bWorker, 0, bWorker, ids.b],
    ]
    for (const [[rows, nth, from, to], index] of messages.map((item, n) => [item, n] as const)) {
      const call = pick(rows, 'message', nth)
      const data = { message: 9000 + index, from, to, reply: false, steer: false }
      await event(MessageSent, data, call.at + call.ms, inside(call))
    }
  }, BACKGROUND_CONTEXT)

  // @ultimate's latest step: a codemode script calling an action, a trace of its own with a child call.
  const [thinking, script] = run(ultimate, 3.4, ['codemode'])
  const codemode: Row[] = [
    thinking,
    {
      ...script,
      children: [
        {
          at: script.at + 80,
          ms: 38,
          kind: 'action',
          name: 'system/lanes',
          conversation: ultimate,
        },
      ],
    },
  ]
  const rows = [
    ...Object.values(lanes).flat(),
    ...codemode,
    ...(ids.lander === undefined
      ? []
      : [...run(ids.lander, 14, cycle(['bash'], 6)), ...run(ids.lander, 5, cycle(['bash'], 4))]),
  ]
  const file = join(host.home, 'trace.sqlite')
  write(file, rows)
  keepCalling(file, ids.running)
  return {
    ultimate,
    coordinators: [ids.a, ids.b],
    workers: [ids.finished, ids.running, bWorker],
    reviewers: [ids.reviewer, ids.correctness, ids.ux],
    lander: ids.lander ?? null,
    calls: rows.length,
  }
}
