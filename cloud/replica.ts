import { applyWaiting, bounded, handoverDetail, MOVE_BY } from './protocol.ts'
import type { CloudInfo, CloudMessage, Hello, Transition, TransitionStep } from './protocol.ts'

type Role = Extract<CloudMessage, { type: 'role' }>
/** A machine that said hello: how to reach it should it claim the lease, and when it was last seen. */
export type MachineRecord = Pick<
  Hello,
  'root' | 'port' | 'secrets' | 'secretsComplete' | 'tailnet'
> & {
  lastSeen: number
  /** When this machine last finished a backup as the writer, as it reported. */
  lastBackupAt?: number
}

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
  secrets: string[]
  secretsComplete: boolean
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

/** Tables of the retired conversation copy, dropped whenever a replica wakes. */
export const RETIRED_TABLES = ['entries', 'docs', 'outbox', 'summaries', 'conversations']

export class ReplicaStore {
  readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
    // Rows by id: 4 the project, 5 the lease, 6 the machines, 7 the latest transition.
    sql.exec('CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    // Replicas once kept a copy of every conversation, and the machine's system info (2) and models (3). Dropping
    // that on wake reclaims the storage; a table already gone costs nothing.
    for (const table of RETIRED_TABLES) sql.exec(`DROP TABLE IF EXISTS ${table}`)
    sql.exec('DELETE FROM metadata WHERE id IN (2, 3)')
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
    // A hello without a backup time keeps the one recorded: it may come from a process that has not read it yet.
    const lastBackupAt = hello?.lastBackupAt ?? machines[machine]?.lastBackupAt
    const known = hello
      ? {
          root: hello.root,
          port: hello.port,
          secrets: hello.secrets,
          secretsComplete: hello.secretsComplete,
          ...(hello.tailnet ? { tailnet: hello.tailnet } : {}),
          ...(lastBackupAt ? { lastBackupAt } : {}),
        }
      : machines[machine]
    if (known)
      this.put('metadata', 6, { ...machines, [machine]: { ...known, lastSeen: Date.now() } })
  }
  role(role: Role['role'], online: boolean): Role {
    const { machine, root, epoch, secrets, secretsComplete, snapshot } = this.lease()!
    const transition = this.transition()
    const tailnet = this.tailnet()
    return {
      type: 'role',
      role,
      // The key the project registered with, which a relinked machine does not connect with.
      project: { key: this.project()!.key },
      epoch,
      free: machine === null,
      ...(snapshot ? { snapshot } : {}),
      writer: {
        machine,
        root,
        epoch,
        online: machine !== null && online,
        secrets,
        secretsComplete,
        ...(tailnet ? { tailnet } : {}),
      },
      ...(transition ? { transition } : {}),
    }
  }
  /** The writer's tailnet address, when the machine holding the lease reported one from the writing checkout. */
  tailnet(): string | undefined {
    const lease = this.lease()
    const known = lease?.machine ? this.machines()[lease.machine] : undefined
    return known?.root === lease?.root ? known?.tailnet : undefined
  }
  /**
   * The tailnet address `machine`'s checkout at `root` reported after its hello. False: nothing changed, as for an
   * unknown machine or another checkout of it.
   */
  setTailnet(machine: string, root: string, url: string | null): boolean {
    const machines = this.machines()
    const known = machines[machine]
    if (!known || known.root !== root || (known.tailnet ?? null) === url) return false
    const { tailnet: _, ...rest } = known
    this.put('metadata', 6, { ...machines, [machine]: url ? { ...rest, tailnet: url } : rest })
    return true
  }
  /** The writer's last backup, when the machine holding the lease reported one. */
  lastBackupAt(): number | undefined {
    const lease = this.lease()
    return lease?.machine ? this.machines()[lease.machine]?.lastBackupAt : undefined
  }
  /** `machine` finished a backup at `at`. False: it is no known machine. */
  backedUp(machine: string, at: number): boolean {
    const machines = this.machines()
    if (!machines[machine]) return false
    this.put('metadata', 6, { ...machines, [machine]: { ...machines[machine], lastBackupAt: at } })
    return true
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
  /**
   * The writer `from`'s drain progress shows as the handover step's detail of the transition to `by`, with the
   * conversations it waits for (`runs`, kept as `waiting`) and the worktrees with uncommitted changes it waits for
   * (`held`) or leaves behind (`dirty`, kept as `left`).
   */
  draining({
    by,
    tasks,
    from,
    dirty,
    runs,
    held = false,
    unchecked,
  }: {
    by: string
    tasks: number
    from: string
    dirty?: string[]
    runs?: string[]
    held?: boolean
    unchecked?: string
  }): boolean {
    const transition = this.transition()
    const handover = transition?.steps.find((step) => step.name === 'handover')
    if (transition?.target !== by || !handover) return false
    applyWaiting(transition, { tasks, dirty, runs })
    handover.detail = handoverDetail(from, tasks, transition.left?.length, held, unchecked)
    this.put('metadata', 7, transition)
    return true
  }
  /**
   * Secret names `machine` reported after its hello. They replace its record, and the lease's when they come from the
   * writer's checkout at `root`.
   */
  secrets(
    machine: string,
    root: string,
    writer: boolean,
    names: Pick<Hello, 'secrets' | 'secretsComplete'>,
  ) {
    this.sql.transaction(() => {
      const machines = this.machines()
      if (machines[machine])
        this.put('metadata', 6, { ...machines, [machine]: { ...machines[machine], ...names } })
      const lease = this.lease()
      if (writer && lease?.machine === machine && lease.root === root)
        this.put('metadata', 5, { ...lease, ...names } satisfies LeaseRecord)
    })
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
        ...(known.tailnet ? { tailnet: known.tailnet } : {}),
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
    return [this.role('writer', true)]
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
  /**
   * Take the free lease at its epoch for the claiming socket's checkout, raising the epoch by one. Undefined: taken, or
   * another epoch.
   */
  claim(
    machine: string,
    claimant: { root: string; port: number; secrets: string[]; secretsComplete: boolean },
    epoch: number,
  ): CloudMessage[] | undefined {
    return this.sql.transaction(() => {
      const lease = this.lease()
      if (!lease || lease.machine !== null || lease.epoch !== epoch) return undefined
      this.put('metadata', 5, {
        ...lease,
        machine,
        epoch: epoch + 1,
        root: claimant.root,
        port: claimant.port,
        secrets: claimant.secrets,
        secretsComplete: claimant.secretsComplete,
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
        secrets: message.secrets,
        secretsComplete: message.secretsComplete,
      } satisfies LeaseRecord)
      return this.admitted()
    })
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
    (value.by === undefined || MOVE_BY.includes(value.by)) &&
    STEPS.includes(value.step) &&
    Array.isArray(value.steps) &&
    value.steps.length <= STEPS.length &&
    value.steps.every(
      (step) =>
        STEPS.includes(step?.name) &&
        STATES.includes(step.state) &&
        text(step.detail) &&
        count(step.done) &&
        count(step.total) &&
        count(step.commits),
    ) &&
    text(value.error) &&
    bounded(value.left) &&
    bounded(value.waiting) &&
    typeof value.cancellable === 'boolean' &&
    Number.isSafeInteger(value.startedAt)
  )
}
