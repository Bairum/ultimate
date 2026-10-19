// Faux only: the agents of a busy half hour in the call trace, to preview the System surface's Agent Lanes. Rows go
// straight into `<home>/trace.sqlite` with past start times, which the live trace cannot record, in finish order as
// the trace writes them; one worker keeps working in the present.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ConversationId } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import { defineEvent } from '../../shared/events.ts'
import { SubagentsApi } from '../subagents/api.ts'

/** The agent facts the System surface reads; subagents emits these for real agents. */
const Started = defineEvent<{
  id: number
  agent: string
  model: string
  kind: 'standing' | 'branch' | 'child'
  parent?: number
}>('subagents.started')

const OPUS = 'anthropic/claude-opus-4-5'
const CODEX = 'openai/gpt-5.1-codex'

type Row = {
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
    rows.push({ at, ms, kind: 'tool', name, conversation, ...(error ? { error } : {}) })
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
    const id = randomUUID()
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

/**
 * Creates a coordinator branch and two workers next to @ultimate and the lander, emits their `subagents.started`, and
 * writes the last 30 minutes of their tool and model calls (one failing) into the trace. The second worker keeps
 * calling every few seconds for an hour, so its run stays open and grows into now.
 */
export async function seedLanes(host: ExtensionHost) {
  const ultimate = await host.need(SubagentsApi).standing('ultimate', BACKGROUND_CONTEXT)
  const ids = await host.harness().commit(async (tx) => {
    // A faux home has a handful of conversations; the first page holds the lander. Reads come before any write.
    let lander: ConversationId | undefined
    for (const record of (await tx.scanConversations({}, 100)).items)
      if ((await tx.doc(host.metadata, record.id)).label === 'lander') lander = record.id
    const create = async (title: string, label?: string) => {
      const { id } = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      Object.assign(await tx.doc(host.metadata, id), { title, ...(label ? { label } : {}) })
      return id
    }
    const coordinator = await create('System surface: a live stream of everything')
    const finished = await create('T2: paged, filterable stream action', 'worker')
    const running = await create('T3: the System surface', 'worker')
    await host.emit(tx, Started, { id: ultimate, agent: 'ultimate', model: OPUS, kind: 'standing' })
    await host.emit(tx, Started, {
      id: coordinator,
      agent: 'coordinator',
      model: OPUS,
      kind: 'branch',
      parent: ultimate,
    })
    for (const id of [finished, running])
      await host.emit(tx, Started, {
        id,
        agent: 'worker',
        model: CODEX,
        kind: 'child',
        parent: coordinator,
      })
    return { coordinator, finished, running, lander }
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
    ...run(ultimate, 29, ['read', 'read', 'subagent', 'branch', 'message', 'message']),
    ...run(ultimate, 12.5, ['message', 'read']),
    ...codemode,
    ...run(ids.coordinator, 27, cycle(['read', 'grep', 'read', 'plan'], 14)),
    ...run(ids.coordinator, 19, ['plan', 'subagent', 'subagent']),
    ...run(ids.coordinator, 15.5, cycle(['read', 'bash', 'workspace'], 7)),
    ...run(ids.coordinator, 7, ['plan', 'message', 'message']),
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
    ...run(ids.finished, 9.5, ['edit', 'bash', 'bash', 'workspace'], CODEX),
    ...run(
      ids.running,
      7.5,
      [...cycle(['read', 'grep'], 6), ...cycle(['edit', 'edit', 'bash', 'screenshot'], 15)],
      CODEX,
    ),
    ...(ids.lander === undefined
      ? []
      : [...run(ids.lander, 14, cycle(['bash'], 6)), ...run(ids.lander, 5, cycle(['bash'], 4))]),
  ]
  const file = join(host.home, 'trace.sqlite')
  write(file, rows)
  keepCalling(file, ids.running)
  return {
    ultimate,
    coordinator: ids.coordinator,
    workers: [ids.finished, ids.running],
    lander: ids.lander ?? null,
    calls: rows.length,
  }
}
