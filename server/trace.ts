// The call trace: who called what, for how long, whether it failed, and the work it belongs to. Tool executions,
// extension actions, reactor handlers and service calls each run in a trace context (AsyncLocalStorage, which survives
// Pi Durable commits and its task runner); each call becomes the parent of the calls it makes, and events emitted
// inside carry the context, so a reaction continues the emitter's chain. Rows are buffered and written to
// `<home>/trace.sqlite` off the call path, never inside a Pi commit; tracing never changes or fails a call.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Extension, ToolRegistration, ToolTaskInput } from '@earendil-works/pi-durable'
import type { EventContext } from '../shared/events.ts'

export type TraceContext = EventContext & { traceId: string; parentCall: string }
export type CallKind = 'service' | 'action' | 'reactor' | 'tool'
/** What a traced call is; ids given here override those of the enclosing work. */
export interface Call {
  kind: CallKind
  caller: string
  callee: string
  name: string
  args?: unknown
  conversationId?: number
  taskId?: number
  entryId?: number
  /** Record neither arguments nor result (a tool's live in the transcript). */
  sealed?: boolean
}
export interface CallRow {
  id: string
  parent?: string
  trace: string
  at: string
  ms: number
  caller: string
  callee: string
  kind: CallKind
  name: string
  ok: boolean
  error?: string
  args?: string
  result?: string
  conversation?: number
  task?: number
  entry?: number
}
export type CallTree = CallRow & { children: CallTree[] }
export interface TraceQuery {
  trace?: string
  conversation?: number
  /** ISO time; only calls that started after it. */
  since?: string
  /** The newest calls, at most 1000; default 100. */
  limit?: number
}

const storage = new AsyncLocalStorage<TraceContext>()
/** The trace context of the running work, if any. */
export const traceContext = () => storage.getStore()

const LIMIT = 300
const SECRET = /secret|token|password|key|auth/i
// Calls into these extensions carry credentials (secret values; API keys and OAuth codes answering a model login), so
// they keep no arguments, results or error messages, which may echo them; only the error's class.
const SEALED = new Set(['secrets', 'models'])

/** What a failed call stored: the error message, or for a call carrying credentials only the error's class. */
function failure(error: unknown, credentials: boolean) {
  if (credentials) return error instanceof Error ? error.name : typeof error
  return error instanceof Error ? error.message : String(error)
}

/** JSON of `value`, cut at about 300 characters, with values under secret-looking keys replaced. */
export function summary(value: unknown) {
  if (value === undefined) return undefined
  let budget = LIMIT
  try {
    const text = JSON.stringify(value, (key, item: unknown) => {
      if (budget <= 0) return undefined
      if (key && SECRET.test(key)) item = '[redacted]'
      if (typeof item === 'string' && item.length > budget) item = item.slice(0, budget)
      budget -= key.length + (item && typeof item === 'object' ? 2 : String(item).length)
      return item
    })
    return text === undefined || text.length <= LIMIT ? text : text.slice(0, LIMIT) + '…'
  } catch {
    // A cycle or a BigInt: the summary says so instead of failing the call.
    return '[unserializable]'
  }
}

/** The call trace of one home: open while the harness is, a no-op recorder otherwise. */
export function callTrace(file: string, retention = { rows: 200_000, days: 7 }) {
  let database: DatabaseSync | undefined
  let insert: ReturnType<DatabaseSync['prepare']> | undefined
  let buffer: unknown[][] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let pruning: ReturnType<typeof setInterval> | undefined
  let reported = false
  const failed = (error: unknown) => {
    if (reported) return
    reported = true
    console.error('Call trace failed; dropping trace records:', error)
  }
  /** Running tool calls by call id, so the tools they call continue their trace. */
  const tools = new Map<string, { context: TraceContext; extension: string; taskId: number }>()

  function flush() {
    clearTimeout(timer)
    timer = undefined
    const rows = buffer
    buffer = []
    if (!database || !rows.length) return
    try {
      database.exec('BEGIN')
      for (const row of rows) insert!.run(...(row as never[]))
      database.exec('COMMIT')
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK')
      failed(error)
    }
  }
  function prune() {
    try {
      flush()
      database?.prepare('DELETE FROM calls WHERE at < ?').run(Date.now() - retention.days * 864e5)
      database
        ?.prepare(
          'DELETE FROM calls WHERE rowid <= (SELECT rowid FROM calls ORDER BY rowid DESC LIMIT 1 OFFSET ?)',
        )
        .run(retention.rows)
    } catch (error) {
      failed(error)
    }
  }
  const row = (value: Record<string, unknown>): CallRow => {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value))
      if (item !== null)
        result[key] =
          key === 'ok' ? item === 1 : key === 'at' ? new Date(item as number).toISOString() : item
    return result as unknown as CallRow
  }
  const select = (where: string, order: string, ...values: (string | number)[]) => {
    flush()
    if (!database) return []
    return database
      .prepare(`SELECT ${COLUMNS.join(', ')} FROM calls ${where} ORDER BY ${order}`)
      .all(...values)
      .map((value) => row(value as Record<string, unknown>))
  }

  /**
   * Run `work` as traced call `call`, a child of `parent`: the enclosing call by default, `null` for a new trace. A
   * value or throw passes through; a promise is returned as one settling with the same value or error, and the row is
   * recorded once it settles.
   */
  function run<T>(
    call: Call,
    work: () => T,
    parent: EventContext | null = traceContext() ?? null,
  ): T {
    const id = randomUUID()
    const context: TraceContext = { traceId: parent?.traceId ?? id, parentCall: id }
    for (const key of ['conversationId', 'taskId', 'entryId'] as const) {
      const value = call[key] ?? parent?.[key]
      if (value !== undefined) context[key] = value
    }
    const started = performance.now()
    // Epoch milliseconds with a fraction, so a parent sorts before the child it started in the same millisecond.
    const at = performance.timeOrigin + started
    const finish = (ok: boolean, value: unknown) => {
      if (!database) return
      try {
        const credentials = SEALED.has(call.callee)
        const sealed = call.sealed || credentials
        buffer.push([
          id,
          parent?.parentCall ?? null,
          context.traceId,
          at,
          Math.round((performance.now() - started) * 100) / 100,
          call.caller,
          call.callee,
          call.kind,
          call.name,
          ok ? 1 : 0,
          ok ? null : failure(value, credentials),
          (!sealed && summary(call.args)) || null,
          (ok && !sealed && summary(value)) || null,
          context.conversationId ?? null,
          context.taskId ?? null,
          context.entryId ?? null,
        ])
        timer ??= setTimeout(flush, 200).unref()
      } catch (error) {
        failed(error)
      }
    }
    let result: T
    try {
      result = storage.run(context, work)
    } catch (error) {
      finish(false, error)
      throw error
    }
    if (!(result instanceof Promise)) {
      finish(true, result)
      return result
    }
    // A promise that settles the same way, so a rejection nobody handles still surfaces as unhandled.
    return result.then(
      (value: unknown) => {
        finish(true, value)
        return value
      },
      (error: unknown) => {
        finish(false, error)
        throw error
      },
    ) as T
  }

  return {
    run,
    /** Open `<home>/trace.sqlite` and apply retention, then hourly; a failure leaves tracing off. */
    open() {
      if (database) return
      try {
        database = new DatabaseSync(file)
        database.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, parent TEXT, trace TEXT NOT NULL, at REAL NOT NULL,
  ms REAL NOT NULL, caller TEXT NOT NULL, callee TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  ok INTEGER NOT NULL, error TEXT, args TEXT, result TEXT, conversation INTEGER, task INTEGER, entry INTEGER);
CREATE INDEX IF NOT EXISTS calls_trace ON calls (trace);
CREATE INDEX IF NOT EXISTS calls_conversation ON calls (conversation);
CREATE INDEX IF NOT EXISTS calls_at ON calls (at);`)
        insert = database.prepare(
          `INSERT OR IGNORE INTO calls (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
        )
        prune()
        pruning = setInterval(prune, 36e5).unref()
      } catch (error) {
        database?.close()
        database = undefined
        failed(error)
      }
    },
    /** Write what is buffered and close; calls go on untraced until the next open. */
    close() {
      flush()
      clearInterval(pruning)
      database?.close()
      database = undefined
    },
    /** Every tool of `extension` runs traced, linked to its conversation, task and tool-call entry. */
    tools(extension: Extension): Extension {
      if (!extension.tools?.length) return extension
      const traced = (tool: ToolRegistration): ToolRegistration => ({
        ...tool,
        execute: async (args, api, context) => {
          let input: ToolTaskInput | undefined
          try {
            input = (await api.getTask(api.taskId, context))?.input as ToolTaskInput | undefined
          } catch {
            // The task read only labels the row (a test double may not offer it); the call runs regardless.
          }
          // A Pi nested call continues its calling tool's trace. So does a tool another running tool calls directly, as
          // codemode does; any other context (left by a timer or a commit) does not make it a child.
          const current = traceContext()
          const enclosing =
            input?.kind === 'nested'
              ? tools.get(input.parentCallId)
              : current && [...tools.values()].find((running) => running.taskId === current.taskId)
          const parent =
            input?.kind === 'nested' ? enclosing?.context : enclosing ? current : undefined
          const call: Call = {
            kind: 'tool',
            caller: enclosing?.extension ?? 'agent',
            callee: extension.name,
            name: tool.name,
            conversationId: api.conversationId,
            taskId: api.taskId,
            entryId: input?.kind === 'model' ? input.assistant : undefined,
            sealed: true,
          }
          return run(
            call,
            async () => {
              tools.set(api.callId, {
                context: traceContext()!,
                extension: extension.name,
                taskId: api.taskId,
              })
              try {
                return await tool.execute(args, api, context)
              } finally {
                tools.delete(api.callId)
              }
            },
            parent ?? null,
          )
        },
      })
      return { ...extension, tools: extension.tools.map(traced) }
    },
    /** Read side, offered to extensions as `host.trace`. */
    reader: {
      /** The newest matching calls, oldest first. */
      query(query: TraceQuery = {}): CallRow[] {
        const since = query.since === undefined ? undefined : Date.parse(query.since)
        if (Number.isNaN(since)) throw new Error(`Invalid since: ${query.since}`)
        const filters = [
          ['trace', query.trace],
          ['conversation', query.conversation],
        ] as const
        const where = filters.flatMap(([column, value]) =>
          value === undefined ? [] : [{ sql: `${column} = ?`, value }],
        )
        if (since !== undefined) where.push({ sql: 'at > ?', value: since })
        const limit = Math.min(Math.max(1, Math.trunc(Number(query.limit) || 100)), 1000)
        return select(
          where.length ? 'WHERE ' + where.map((filter) => filter.sql).join(' AND ') : '',
          `at DESC, rowid DESC LIMIT ${limit}`,
          ...where.map((filter) => filter.value),
        ).toReversed()
      },
      /** The first 5000 calls of trace `traceId` nested under their parents, in start order. */
      tree(traceId: string): CallTree[] {
        const nodes = select('WHERE trace = ?', 'at, rowid LIMIT 5000', traceId).map(
          (call): CallTree => ({
            ...call,
            children: [],
          }),
        )
        const byId = new Map(nodes.map((node) => [node.id, node]))
        const roots: CallTree[] = []
        for (const node of nodes) {
          const parent = node.parent === undefined ? undefined : byId.get(node.parent)
          if (parent) parent.children.push(node)
          else roots.push(node)
        }
        return roots
      },
    },
  }
}
const COLUMNS = [
  'id',
  'parent',
  'trace',
  'at',
  'ms',
  'caller',
  'callee',
  'kind',
  'name',
  'ok',
  'error',
  'args',
  'result',
  'conversation',
  'task',
  'entry',
]
export type CallTrace = ReturnType<typeof callTrace>
export type TraceReader = CallTrace['reader']
