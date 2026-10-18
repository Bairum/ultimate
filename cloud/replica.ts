import type { ConversationRecord, EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import type {
  CloudInfo,
  CloudMessage,
  Hello,
  MachineMessage,
  OutboxItem,
  Transition,
  TransitionStep,
} from './protocol.ts'

type Role = Extract<CloudMessage, { type: 'role' }>
/** A machine that said hello: how to reach it should it claim the lease, and when it was last seen. */
export type MachineRecord = Pick<Hello, 'root' | 'port' | 'secrets'> & { lastSeen: number }
import type { ConversationSummary } from '../shared/protocol.ts'

/** The repository a replica belongs to, fixed by the first hello. */
export interface ProjectRecord {
  key: string
  rootCommit: string
  /** The registering machine's absolute project root. */
  root: string
  /** The repository name. */
  name: string
}

/** The writer's lease and what the replica needs to reach the writer. */
export interface LeaseRecord {
  /** Null while the lease is free; root, port and secrets then stay the last writer's. */
  machine: string | null
  epoch: number
  root: string
  port: number
  uiBuild?: string
  secrets: string[]
  /** The snapshot the last release uploaded, and the epoch it was taken at. */
  snapshot?: { id: string; epoch: number }
}

/** The common subset of Durable Object SQL and a node:sqlite adapter. */
export interface Sql {
  exec<T extends Record<string, unknown>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): Iterable<T>
  transaction<T>(run: () => T): T
}

export class ReplicaStore {
  readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
    for (const table of ['conversations', 'metadata', 'summaries'])
      sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`)
    sql.exec(
      'CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, value TEXT NOT NULL)',
    )
    sql.exec('CREATE INDEX IF NOT EXISTS entries_conversation ON entries (conversation_id, id)')
    sql.exec(
      'CREATE INDEX IF NOT EXISTS entry_heads_conversation ON entries (conversation_id, id) WHERE head IS NOT NULL',
    )
    sql.exec(
      'CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, value TEXT NOT NULL)',
    )
    sql.exec('CREATE INDEX IF NOT EXISTS docs_conversation_kind ON docs (conversation_id, kind)')
    sql.exec(
      'CREATE TABLE IF NOT EXISTS outbox (submissionId INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id INTEGER NOT NULL, value TEXT NOT NULL)',
    )
    sql.exec(
      'CREATE INDEX IF NOT EXISTS outbox_conversation ON outbox (conversation_id, submissionId)',
    )
  }

  private put(table: string, id: number, value: unknown) {
    this.sql.exec(
      `INSERT INTO ${table} (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`,
      id,
      JSON.stringify(value),
    )
  }
  private get(table: string, id: number): unknown {
    const row = [
      ...this.sql.exec<{ value: string }>(`SELECT value FROM ${table} WHERE id=?`, id),
    ][0]
    return row ? JSON.parse(row.value) : undefined
  }
  metadata(id: number): unknown {
    return this.get('metadata', id)
  }
  project(): ProjectRecord | undefined {
    return this.metadata(4) as ProjectRecord | undefined
  }
  lease(): LeaseRecord | undefined {
    return this.metadata(5) as LeaseRecord | undefined
  }
  /** Every machine that said hello, by name. */
  machines(): Record<string, MachineRecord> {
    return (this.metadata(6) as Record<string, MachineRecord> | undefined) ?? {}
  }
  seen(machine: string, hello?: Hello) {
    const machines = this.machines()
    const known = hello
      ? { root: hello.root, port: hello.port, secrets: hello.secrets }
      : machines[machine]
    if (known)
      this.put('metadata', 6, { ...machines, [machine]: { ...known, lastSeen: Date.now() } })
  }
  role(role: Role['role'], online: boolean): Role {
    const { machine, root, epoch, secrets, snapshot } = this.lease()!
    const transition = this.transition()
    return {
      type: 'role',
      role,
      // The key the project registered with, which a relinked machine does not connect with.
      project: { key: this.project()!.key },
      epoch,
      free: machine === null,
      ...(snapshot ? { snapshot } : {}),
      writer: { machine, root, epoch, online: machine !== null && online, secrets },
      ...(transition ? { transition } : {}),
    }
  }
  /** The latest transition a machine reported, running or ended. */
  transition(): Transition | undefined {
    return (this.metadata(7) as Transition | null | undefined) ?? undefined
  }
  /**
   * Store the transition `machine` reports; only its target reports it, and only the target of the stored one clears
   * it. False: refused.
   */
  report(machine: string, value: Transition | null): boolean {
    if (value === null ? this.transition()?.target !== machine : !validTransition(value, machine))
      return false
    this.put('metadata', 7, value)
    return true
  }
  /**
   * End a running transition `machine` takes part in as failed with "<machine> disconnected", unless it is `keep`, the
   * one its hello says it still takes part in. Its target closing its last socket ends it (`closing`). So does a hello
   * from either end without it: the target, or the writer it waits for while that still holds the lease (a releasing
   * writer reconnects naming it; a restarted one does not). True when it ended one.
   */
  abandon(machine: string, keep?: string, closing = false): boolean {
    const transition = this.transition()
    const involved =
      transition?.target === machine ||
      (!closing && transition?.from === machine && this.lease()?.machine === machine)
    if (
      !transition ||
      !involved ||
      transition.id === keep ||
      transition.error ||
      // A claim that won is no stale transition, even when its reply was lost.
      this.lease()?.machine === transition.target
    )
      return false
    const error = `${machine} disconnected`
    const step = transition.steps.find((item) => item.state === 'running')
    if (step) Object.assign(step, { state: 'failed', detail: error })
    this.put('metadata', 7, { ...transition, error, cancellable: false })
    return true
  }
  /** The writer's drain progress shows as the handover step's detail of the transition to `by`. */
  draining(by: string, tasks: number): boolean {
    const transition = this.transition()
    const handover = transition?.steps.find((step) => step.name === 'handover')
    if (transition?.target !== by || !handover) return false
    handover.detail = `finishing ${tasks} ${tasks === 1 ? 'run' : 'runs'}`
    this.put('metadata', 7, transition)
    return true
  }
  /** `GET /api/cloud`: every machine, the lease and the latest transition. */
  cloud(connected: Set<string>, online: boolean): CloudInfo {
    const lease = this.lease()
    const writer = lease?.machine ?? null
    return {
      machines: Object.entries(this.machines()).map(([machine, known]) => ({
        machine,
        role: machine === writer ? ('writer' as const) : ('standby' as const),
        connected: connected.has(machine),
        root: known.root,
        lastSeen: known.lastSeen,
        missingSecrets:
          machine === writer
            ? []
            : (lease?.secrets ?? []).filter((name) => !known.secrets.includes(name)),
      })),
      lease: lease
        ? {
            machine: writer,
            epoch: lease.epoch,
            root: lease.root,
            online: writer !== null && online,
            ...(lease.snapshot ? { snapshot: lease.snapshot } : {}),
          }
        : null,
      transition: this.transition() ?? null,
    }
  }
  private admitted(): CloudMessage[] {
    return [this.role('writer', true), this.cursor(), { type: 'outbox', items: this.outbox() }]
  }
  /** The writer frees its lease at its epoch after uploading a snapshot. False: not the current lease. */
  release(epoch: number, id: string): boolean {
    return this.sql.transaction(() => {
      const lease = this.lease()
      if (lease?.machine == null || lease.epoch !== epoch) return false
      this.put('metadata', 5, { ...lease, machine: null, snapshot: { id, epoch } })
      return true
    })
  }
  /** Take the free lease at its epoch, raising it by one. Undefined: taken, or another epoch. */
  claim(machine: string, epoch: number): CloudMessage[] | undefined {
    return this.sql.transaction(() => {
      const lease = this.lease()
      const claimant = this.machines()[machine]
      if (!lease || !claimant || lease.machine !== null || lease.epoch !== epoch) return undefined
      this.put('metadata', 5, {
        ...lease,
        machine,
        epoch: epoch + 1,
        root: claimant.root,
        port: claimant.port,
        secrets: claimant.secrets,
      } satisfies LeaseRecord)
      return this.admitted()
    })
  }
  /**
   * Admit a hello: the first registers its project with that machine as the writer at epoch 1. The writer machine is
   * the writer again with the stored epoch or none; everyone else is a standby. Undefined: another repository.
   */
  hello(message: Hello, writerOnline: boolean): CloudMessage[] | undefined {
    return this.sql.transaction(() => {
      const project = this.project()
      if (!project) {
        const name = message.key.split('/').at(-1)!
        this.put('metadata', 4, {
          key: message.key,
          rootCommit: message.rootCommit,
          root: message.root,
          name,
        })
        this.put('metadata', 5, { machine: message.machine, epoch: 1, root: message.root })
      } else if (project.key !== message.key || project.rootCommit !== message.rootCommit)
        return undefined
      this.seen(message.machine, message)
      const lease = this.lease()!
      // The writer is one checkout: another one on the same machine (its own home, another root) is a standby.
      if (
        lease.machine !== message.machine ||
        lease.root !== message.root ||
        (message.epoch !== undefined && message.epoch !== lease.epoch)
      )
        return [this.role('standby', writerOnline)]
      this.put('metadata', 5, {
        ...lease,
        root: message.root,
        port: message.port,
        uiBuild: message.uiBuild ?? lease.uiBuild,
        secrets: message.secrets,
      } satisfies LeaseRecord)
      return this.admitted()
    })
  }
  hasEntries(): boolean {
    return [...this.sql.exec('SELECT id FROM entries LIMIT 1')].length > 0
  }
  summaryCount(): number {
    return [...this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM summaries')][0].count
  }
  summaries(): ConversationSummary[] {
    return [...this.sql.exec<{ value: string }>('SELECT value FROM summaries ORDER BY id')].map(
      (row) => JSON.parse(row.value) as ConversationSummary,
    )
  }
  conversation(id: number): ConversationRecord | undefined {
    return this.get('conversations', id) as ConversationRecord | undefined
  }
  root() {
    return (
      [...this.sql.exec<{ id: number | null }>('SELECT MIN(id) AS id FROM conversations')][0].id ??
      1
    )
  }
  doc(conversationId: number, kind: string): JsonObject | null {
    const row = [
      ...this.sql.exec<{ value: string }>(
        'SELECT value FROM docs WHERE conversation_id=? AND kind=? ORDER BY id LIMIT 1',
        conversationId,
        kind,
      ),
    ][0]
    return row ? (JSON.parse(row.value) as JsonObject) : null
  }
  cursor(): Extract<CloudMessage, { type: 'cursor' }> {
    const entries = this.sql.exec<{ conversation_id: number; id: number }>(
      'SELECT conversation_id, MAX(id) AS id FROM entries GROUP BY conversation_id',
    )
    return {
      type: 'cursor',
      entries: Object.fromEntries([...entries].map((row) => [row.conversation_id, row.id])),
      docs: Object.fromEntries(
        [...this.sql.exec<{ id: number; hash: string }>('SELECT id, hash FROM docs')].map((doc) => [
          doc.id,
          doc.hash,
        ]),
      ),
    }
  }
  outbox(): OutboxItem[] {
    return [
      ...this.sql.exec<{ value: string }>('SELECT value FROM outbox ORDER BY submissionId'),
    ].map((row) => JSON.parse(row.value) as OutboxItem)
  }
  enqueue(conversationId: number, text: string, whenBusy?: OutboxItem['whenBusy']) {
    const item: OutboxItem = {
      id: crypto.randomUUID(),
      conversationId,
      text,
      whenBusy,
      createdAt: Date.now(),
    }
    this.sql.exec(
      'INSERT INTO outbox (id, conversation_id, value) VALUES (?, ?, ?)',
      item.id,
      conversationId,
      JSON.stringify(item),
    )
    const row = [
      ...this.sql.exec<{ submissionId: number }>(
        'SELECT submissionId FROM outbox WHERE id=?',
        item.id,
      ),
    ][0]
    // Negative IDs distinguish cloud queue items from the machine's positive Pi submission IDs.
    return { item, submissionId: -row.submissionId }
  }
  /**
   * Apply data from the writer's socket. The lease changes through `hello`, `release` and `claim`; the socket layer
   * forwards `request-release` and `release-waiting` between machines.
   */
  receive(
    message: Exclude<
      MachineMessage,
      {
        type: 'hello' | 'release' | 'claim' | 'request-release' | 'release-waiting' | 'transition'
      }
    >,
  ): CloudMessage[] {
    switch (message.type) {
      case 'uiBuild':
        if (/^[a-f0-9]{12}$/.test(message.value) && this.lease())
          this.put('metadata', 5, { ...this.lease(), uiBuild: message.value })
        return []
      case 'batch':
        this.sql.transaction(() => {
          for (const record of message.conversations) this.put('conversations', record.id, record)
          for (const entry of message.entries)
            this.sql.exec(
              'INSERT INTO entries (id, conversation_id, head, value) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id, head=excluded.head, value=excluded.value',
              entry.id,
              entry.conversationId,
              entry.head ?? null,
              JSON.stringify(entry),
            )
          for (const doc of message.docs) {
            if (doc.value === null) this.sql.exec('DELETE FROM docs WHERE id=?', doc.id)
            else
              this.sql.exec(
                'INSERT INTO docs (id, conversation_id, kind, hash, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id, kind=excluded.kind, hash=excluded.hash, value=excluded.value',
                doc.id,
                doc.conversationId,
                doc.kind,
                doc.hash,
                JSON.stringify(doc.value),
              )
          }
        })
        return [{ type: 'ack', batch: message.batch }]
      case 'summaries':
        this.sql.transaction(() => {
          if (message.full) this.sql.exec('DELETE FROM summaries')
          for (const id of message.removed) this.sql.exec('DELETE FROM summaries WHERE id=?', id)
          for (const summary of message.value) this.put('summaries', summary.id, summary)
        })
        break
      case 'system':
        this.put('metadata', 2, message.value)
        break
      case 'models':
        this.put('metadata', 3, message.value)
        break
      case 'delivered':
        this.sql.exec('DELETE FROM outbox WHERE id=?', message.id)
        break
    }
    return []
  }
  /** Each ancestor inherits the tighter of its fork point and the descendant's visible bound. */
  private segments(id: number, record = this.conversation(id)) {
    const segments: { conversationId: number; maxId: number }[] = []
    let maxId = Number.MAX_SAFE_INTEGER
    while (record) {
      segments.push({ conversationId: record.id, maxId })
      const parent = record.parent
      if (!parent) break
      maxId = Math.min(maxId, parent.at)
      record = this.conversation(parent.conversationId)
    }
    return segments
  }
  private entries(query: string, ...bindings: number[]): EntryRecord[] {
    return [...this.sql.exec<{ value: string }>(query, ...bindings)].map(
      (row) => JSON.parse(row.value) as EntryRecord,
    )
  }
  view(id: number) {
    const conversation = this.conversation(id)
    if (!conversation) return null
    const segments = this.segments(id, conversation)
    let marker: EntryRecord | undefined
    for (const segment of segments) {
      const candidate = this.entries(
        'SELECT value FROM entries WHERE conversation_id=? AND id<=? AND head IS NOT NULL ORDER BY id DESC LIMIT 1',
        segment.conversationId,
        segment.maxId,
      )[0]
      if (candidate && (!marker || candidate.id > marker.id)) marker = candidate
    }
    const active = segments
      .flatMap((segment) =>
        this.entries(
          'SELECT value FROM entries WHERE conversation_id=? AND id<=? AND id>=? AND head IS NULL ORDER BY id',
          segment.conversationId,
          segment.maxId,
          marker?.head ?? 0,
        ),
      )
      .toSorted((a, b) => a.id - b.id)
    const entries = marker ? [marker, ...active] : active
    const docs: Record<string, JsonObject> = {}
    for (const doc of this.sql.exec<{ kind: string; value: string }>(
      "SELECT kind, value FROM docs WHERE conversation_id=? AND kind GLOB 'pi.*' AND kind!='pi.live' ORDER BY id",
      id,
    ))
      docs[doc.kind] = JSON.parse(doc.value) as JsonObject
    const queued = [
      ...this.sql.exec<{ submissionId: number; value: string }>(
        'SELECT submissionId, value FROM outbox WHERE conversation_id=? ORDER BY submissionId',
        id,
      ),
    ].flatMap((row) => {
      const item = JSON.parse(row.value) as OutboxItem
      return [{ id: -row.submissionId, mode: item.whenBusy ?? 'followUp', content: item.text }]
    })
    docs['pi.inbox'] = {
      items: [...(Array.isArray(docs['pi.inbox']?.items) ? docs['pi.inbox'].items : []), ...queued],
    }
    return { conversation, entries, docs }
  }
  history(id: number, before: number) {
    const all = this.segments(id)
      .flatMap((segment) =>
        this.entries(
          'SELECT value FROM entries WHERE conversation_id=? AND id<=? AND id<? ORDER BY id DESC LIMIT 65',
          segment.conversationId,
          segment.maxId,
          before,
        ),
      )
      .toSorted((a, b) => b.id - a.id)
    const entries = all.slice(0, 64)
    return { entries, ...(all.length > 64 ? { before: entries.at(-1)!.id } : {}) }
  }
}

const STEPS: TransitionStep['name'][] = [
  'fetch',
  'install',
  'checks',
  'handover',
  'download',
  'branches',
  'claim',
]
const STATES: TransitionStep['state'][] = ['pending', 'running', 'done', 'failed', 'skipped']
const text = (value: unknown, max = 2000) =>
  value === undefined || (typeof value === 'string' && value.length <= max)
const count = (value: unknown) =>
  value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0)
/** A transition `machine` may report: its own, well formed and bounded. */
function validTransition(value: Transition, machine: string) {
  return (
    !!value &&
    typeof value.id === 'string' &&
    /^[\w-]{1,64}$/.test(value.id) &&
    value.target === machine &&
    (value.from === null || typeof value.from === 'string') &&
    STEPS.includes(value.step) &&
    Array.isArray(value.steps) &&
    value.steps.length <= STEPS.length &&
    value.steps.every(
      (step) =>
        STEPS.includes(step?.name) &&
        STATES.includes(step.state) &&
        text(step.detail) &&
        count(step.done) &&
        count(step.total),
    ) &&
    text(value.error) &&
    typeof value.cancellable === 'boolean' &&
    Number.isSafeInteger(value.startedAt)
  )
}

/** Check the browser's original authority before rewriting headers for the machine's loopback gate. */
export function admitsRequest(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site')
  const origin = request.headers.get('Origin')
  return (
    (site === null || site === 'same-origin' || site === 'none') &&
    (origin === null || origin === new URL(request.url).origin)
  )
}

/** Strip edge/browser forwarding metadata before passing the request to Ultimate's loopback admission gate. */
export function proxyRequest(request: Request, origin: string): Request {
  if (!admitsRequest(request)) throw new Error('Forbidden')
  const url = new URL(request.url)
  const target = new URL(origin)
  const headers = new Headers(request.headers)
  // Snapshot the keys: deleting while iterating Headers skips adjacent fields.
  const keys = [...headers.keys()]
  for (const key of keys)
    if (/^(x-forwarded-|cf-|sec-fetch-)/i.test(key) || key === 'forwarded') headers.delete(key)
  headers.set('Host', target.host)
  if (headers.has('Origin')) headers.set('Origin', target.origin)
  return new Request(new URL(url.pathname + url.search, target), {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
    ...(request.body ? { duplex: 'half' } : {}),
  })
}
