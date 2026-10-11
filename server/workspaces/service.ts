import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import {
  AgentDoc,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  InboxDoc,
  LiveDoc,
} from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import type {
  ConversationId,
  Cursor,
  Harness,
  JsonObject,
  SubmissionDraft,
  TaskId,
  TaskOwnership,
  Tx,
} from '@earendil-works/pi-durable'
import type { Workspace } from '../../shared/protocol.ts'
import { WorkspaceDoc, LifecycleQueue } from './doc.ts'
import type { LifecycleResult } from './doc.ts'
import { lifecycle } from './lifecycle.ts'
import * as worktree from './worktree.ts'

async function records(tx: Tx) {
  const rows = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanConversations({}, 256, cursor)
    rows.push(...page.items)
    cursor = page.next
  } while (cursor !== undefined)
  return rows
}

function pathRelations() {
  const physical = new Map<string, Promise<string>>()
  const checkouts = new Map<string, Promise<string | undefined>>()
  const canonical = (path: string) => {
    let value = physical.get(path)
    if (!value) physical.set(path, (value = worktree.canonicalPath(path)))
    return value
  }
  const within = async (root: string, path: string) =>
    worktree.contains(await canonical(root), await canonical(path))
  return {
    canonical,
    within,
    async checkout(root: string, path: string) {
      if (!(await within(root, path))) return false
      const cwd = await canonical(path)
      const target = await canonical(root)
      if (cwd === target) return true
      let identity = checkouts.get(cwd)
      if (!identity) {
        identity = worktree
          .git(cwd, 'rev-parse', '--show-toplevel')
          .then(canonical)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' || Number(error.code) === 128) return undefined
            throw error
          })
        checkouts.set(cwd, identity)
      }
      const checkout = await identity
      return checkout === undefined || checkout === target
    },
  }
}

export function createWorkspaces(host: {
  home: string
  projectRoot: string
  ultimateRoot: string
  projectSettings(): Promise<JsonObject>
  harness(): Harness
}) {
  const holds = new Map<ConversationId, number>()
  const admissions = new Map<ConversationId, number>()
  const snapshot = async (id: ConversationId, context: Context) =>
    (await host.harness().snapshot(WorkspaceDoc, id, context))?.workspace
  async function assertAdmission(tx: Tx, id: ConversationId) {
    if (!(await tx.conversation(id))) throw new Error('Unknown conversation')
    const workspace = (await tx.doc(WorkspaceDoc, id)).workspace
    if (workspace?.state === 'discarded')
      throw new Error("Child's worktree was discarded; start a new child")
    if (workspace && workspace.preparation !== 'ready')
      throw new Error(
        `Workspace preparation is ${workspace.preparation}${workspace.error ? `: ${workspace.error}` : ''}`,
      )
    const cwd = (await tx.doc(AgentDoc, id)).cwd ?? host.projectRoot
    const paths = pathRelations()
    if (workspace && !(await paths.within(workspace.path, cwd)))
      throw new Error(
        'Workspace cwd changed; restore the authoritative workspace path before submitting',
      )
    const queue = await tx.doc(LifecycleQueue)
    for (const child of Object.keys(queue.children)) {
      const other = (await tx.doc(WorkspaceDoc, Number(child) as ConversationId)).workspace
      const inside = other && (await paths.within(other.path, cwd))
      if (inside && other.state === 'discarded')
        throw new Error('Workspace was discarded; create a new conversation in an active checkout')
      if (inside && other.preparation !== 'ready')
        throw new Error(`Workspace preparation is ${other.preparation}`)
    }
    if ((await blockingLifecycle(tx, id)).length)
      throw new Error('Child worktree lifecycle operation is in progress')
  }
  async function blockingLifecycle(tx: Tx, id: ConversationId) {
    const paths = pathRelations()
    const cwd = (await tx.doc(AgentDoc, id)).cwd ?? host.projectRoot
    const workspace = (await tx.doc(WorkspaceDoc, id)).workspace
    const queue = await tx.doc(LifecycleQueue)
    const blocked: TaskId[] = []
    for (const [child, tasks] of Object.entries(queue.children)) {
      if (!tasks.length) continue
      const other = (await tx.doc(WorkspaceDoc, Number(child) as ConversationId)).workspace
      const related =
        Number(child) === id ||
        (other &&
          ((await paths.checkout(other.source, cwd)) ||
            (await paths.within(other.path, cwd)) ||
            (workspace && (await paths.within(other.path, workspace.source)))))
      if (!related) continue
      for (const task of tasks)
        if ((await tx.task(task))?.state.status !== 'terminal') blocked.push(task)
    }
    return [...new Set(blocked)]
  }
  async function guardTx(
    tx: Tx,
    child: ConversationId,
    parent: ConversationId,
    operation: 'land' | 'discard',
    caller?: TaskId,
    current?: TaskId,
  ) {
    const allowed = new Set<TaskId>()
    let ancestor = caller
    while (ancestor) {
      const task = await tx.task(ancestor)
      if (!task || task.conversationId !== parent || task.state.status === 'terminal')
        throw new Error('Invalid workspace lifecycle caller')
      allowed.add(ancestor)
      ancestor = task.owner
    }
    const workspace = (await tx.doc(WorkspaceDoc, child)).workspace
    if (!workspace) throw new Error('Conversation has no workspace')
    if (
      workspace.preparation !== 'ready' &&
      (operation === 'land' || workspace.preparation === 'pending')
    )
      throw new Error(`Workspace preparation is ${workspace.preparation}`)
    const rows = await records(tx)
    const paths = pathRelations()
    if (operation === 'discard') {
      for (const row of rows) {
        const dependent = (await tx.doc(WorkspaceDoc, row.id)).workspace
        if (
          row.id !== child &&
          dependent?.state === 'active' &&
          ((await paths.within(workspace.path, dependent.source)) ||
            (await paths.within(workspace.path, dependent.path)))
        )
          throw new Error(
            'Workspace has an active dependent workspace; discard it explicitly first',
          )
      }
    }
    const lifecycleAllowed = new Set<TaskId>(current ? [current] : [])
    let taskCursor: Cursor | undefined
    do {
      const page = await tx.scanTasks({}, 256, taskCursor)
      for (const task of page.items) {
        if (
          task.state.status === 'terminal' ||
          task.kind !== 'ultimate.workspace-lifecycle' ||
          task.id === current
        )
          continue
        const input = task.input as { child: ConversationId }
        const other = (await tx.doc(WorkspaceDoc, input.child)).workspace
        if (
          other &&
          (await paths.canonical(other.source)) === (await paths.canonical(workspace.source))
        ) {
          lifecycleAllowed.add(task.id)
          continue
        }
        if (
          other &&
          ((await paths.within(workspace.path, other.source)) ||
            (await paths.within(other.path, workspace.source)) ||
            (await paths.within(workspace.path, other.path)) ||
            (await paths.within(other.path, workspace.path)))
        )
          throw new Error('Dependent workspace lifecycle operation is in progress')
      }
      taskCursor = page.next
    } while (taskCursor !== undefined)
    const descendants = new Set<ConversationId>([child])
    const descendantPaths = new Set([await paths.canonical(workspace.path)])
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        const owner = row.owner?.conversationId ?? row.parent?.conversationId
        const dependent = (await tx.doc(WorkspaceDoc, row.id)).workspace
        if (
          !descendants.has(row.id) &&
          ((owner && descendants.has(owner)) ||
            (dependent?.state === 'active' &&
              descendantPaths.has(await paths.canonical(dependent.source))))
        ) {
          descendants.add(row.id)
          if (dependent) descendantPaths.add(await paths.canonical(dependent.path))
          changed = true
        }
      }
    }
    for (const row of rows.toSorted(
      (a, b) => Number(descendants.has(b.id)) - Number(descendants.has(a.id)),
    )) {
      const cwd = (await tx.doc(AgentDoc, row.id)).cwd ?? host.projectRoot
      if (
        !descendants.has(row.id) &&
        !(await paths.within(workspace.path, cwd)) &&
        !(await paths.checkout(workspace.source, cwd))
      )
        continue
      if (holds.has(row.id)) throw new Error('Workspace has an active preview hold')
      if (admissions.has(row.id))
        throw new Error('Workspace execution admission is in progress; retry')
      const run = (await tx.doc(LiveDoc, row.id)).run
      if (run && !allowed.has(run.taskId))
        throw new Error('Child is running; wait or stop it first')
      if ((await tx.doc(InboxDoc, row.id)).items.length)
        throw new Error('Workspace has queued input; cancel or finish it first')
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks({ conversationId: row.id }, 256, cursor)
        if (
          page.items.some(
            (task) =>
              task.state.status !== 'terminal' &&
              task.kind !== 'ultimate.automation-scheduler' &&
              !lifecycleAllowed.has(task.id) &&
              !allowed.has(task.id),
          )
        )
          throw new Error('Workspace has running or queued descendant work; wait or stop it first')
        cursor = page.next
      } while (cursor !== undefined)
    }
  }
  const lifecycleTask = lifecycle({
    ...host,
    guard: (child, parent, operation, caller, current, context) =>
      host
        .harness()
        .commit((tx) => guardTx(tx, child, parent, operation, caller, current), context),
  })
  const Preparation = defineTask<
    { id: ConversationId; request: string; agent: string },
    { phase: 'prepare' },
    null
  >({
    name: 'ultimate.workspace-prepare',
    version: 1,
    initial: () => ({ phase: 'prepare' }),
    phases: {
      prepare: async (task, runtime, context) => {
        const workspace = (await runtime.snapshot(WorkspaceDoc, task.input.id, context))!.workspace!
        try {
          await worktree.create(
            workspace.source,
            host.home,
            task.input.agent,
            task.input.request,
            () => host.projectSettings(),
            runtime.signal,
            workspace,
          )
          await runtime.commit(async (tx) => {
            ;(await tx.doc(WorkspaceDoc, task.input.id)).workspace!.preparation = 'ready'
            await configure(tx, task.input.id, { cwd: workspace.path })
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          await runtime.commit(async (tx) => {
            const saved = (await tx.doc(WorkspaceDoc, task.input.id)).workspace!
            saved.preparation = 'error'
            saved.error = error instanceof Error ? error.message : String(error)
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, context)
        }
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(async (tx) => {
        const saved = (await tx.doc(WorkspaceDoc, runtime.conversationId)).workspace!
        saved.preparation = 'error'
        saved.error = 'Workspace preparation aborted'
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  return {
    doc: WorkspaceDoc,
    extension: defineExtension({
      name: 'ultimate-workspaces',
      tasks: [Preparation, lifecycleTask],
    }),
    snapshot,
    dirty: (cwd: string) => worktree.git(cwd, 'status', '--porcelain'),
    async info(id: ConversationId, context: Context) {
      const workspace = await snapshot(id, context)
      if (!workspace) return null
      const ahead = await worktree
        .git(workspace.source, 'rev-list', '--count', `HEAD..${workspace.branch}`)
        .then(Number, () => null)
      return { ...workspace, ahead }
    },
    async describe(source: string, agent: string, request: string): Promise<Workspace> {
      const key = createHash('sha256').update(request).digest('hex')
      return {
        kind: 'worktree',
        path: await worktree.worktreePath(host.home, key),
        branch: `ultimate/${agent}-${key.slice(0, 16)}`,
        base: await worktree.git(source, 'rev-parse', 'HEAD'),
        source: await realpath(await worktree.git(source, 'rev-parse', '--show-toplevel')),
        ...(await worktree.target(source)),
        state: 'active',
        preparation: 'pending',
      }
    },
    async prepare(
      tx: Tx,
      id: ConversationId,
      workspace: Workspace,
      agent: string,
      request: string,
    ) {
      const doc = await tx.doc(WorkspaceDoc, id)
      if (doc.workspace) throw new Error('Workspace opt-in is new-conversation only')
      doc.workspace = workspace
      ;(await tx.doc(LifecycleQueue)).children[String(id)] = []
      doc.preparationTask = await tx.createTask(
        Preparation,
        { id, agent, request },
        {
          conversationId: id,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
      return doc.preparationTask
    },
    async ready(id: ConversationId, context: Context) {
      const doc = await host.harness().snapshot(WorkspaceDoc, id, context)
      if (doc?.preparationTask) await host.harness().waitForTask(doc.preparationTask, context)
      await host.harness().commit((tx) => assertAdmission(tx, id), context)
      return snapshot(id, context)
    },
    assertAdmission,
    blockingLifecycle,
    async withAdmission<T>(
      id: ConversationId,
      operation: (cwd: string) => Promise<T>,
      context: Context,
    ): Promise<T> {
      const harness = host.harness()
      const cwd = await harness.commit(async (tx) => {
        await assertAdmission(tx, id)
        const executionCwd = (await tx.doc(AgentDoc, id)).cwd ?? host.projectRoot
        admissions.set(id, (admissions.get(id) ?? 0) + 1)
        return executionCwd
      }, context)
      try {
        return await operation(cwd)
      } finally {
        const count = admissions.get(id)! - 1
        if (count) admissions.set(id, count)
        else admissions.delete(id)
      }
    },
    async submit(id: ConversationId, draft: SubmissionDraft, context: Context) {
      return this.withAdmission(
        id,
        async () => (await host.harness().conversation(id, context))!.submit(draft, context),
        context,
      )
    },
    async createLifecycle(
      tx: Tx,
      parent: ConversationId,
      child: ConversationId,
      operation: 'land' | 'discard',
      ownership: TaskOwnership,
      request?: string,
    ) {
      const queue = await tx.doc(LifecycleQueue)
      if (request && queue.requests[request]) return queue.requests[request]
      const caller = ownership.kind === 'task' ? ownership.taskId : undefined
      if (caller && parent === child && operation === 'discard')
        throw new Error('Cannot discard the active caller workspace')
      await guardTx(tx, child, parent, operation, caller)
      const tasks = queue.children[String(child)] ?? []
      const live: TaskId[] = []
      for (const id of tasks) if ((await tx.task(id))?.state.status !== 'terminal') live.push(id)
      const task = await tx.createTask(
        lifecycleTask,
        { parent, child, operation, ...(caller ? { caller } : {}) },
        {
          conversationId: parent,
          ownership,
          ...(ownership.kind === 'conversation' ? { background: true } : {}),
        },
      )
      queue.children[String(child)] = [...live, task]
      if (request) queue.requests[request] = task
      return task
    },
    async runLifecycle(
      parent: ConversationId,
      child: ConversationId,
      operation: 'land' | 'discard',
      context: Context,
    ): Promise<LifecycleResult> {
      const harness = host.harness()
      const task = await harness.commit(
        (tx) => this.createLifecycle(tx, parent, child, operation, { kind: 'conversation' }),
        context,
      )
      const outcome = (await harness.waitForTask(task, context)).state.outcome
      if (outcome.status === 'completed') return outcome.result
      if (outcome.status === 'failed' || outcome.status === 'faulted')
        throw new Error(outcome.error.message)
      throw new Error('Child worktree lifecycle operation was aborted')
    },
    async hold(id: ConversationId, context: Context) {
      await host.harness().commit(async (tx) => {
        await assertAdmission(tx, id)
        const workspace = (await tx.doc(WorkspaceDoc, id)).workspace
        if (!workspace) throw new Error('Conversation has no workspace')
        holds.set(id, (holds.get(id) ?? 0) + 1)
      }, context)
      let released = false
      return () => {
        if (released) return
        released = true
        const count = holds.get(id)! - 1
        if (count) holds.set(id, count)
        else holds.delete(id)
      }
    },
    async migrate(context: Context) {
      // This token is used only to remove actual legacy copies, never to serve runtime reads.
      const LegacySubagents = defineDoc<{
        agents: Record<
          string,
          { isolate?: Omit<Workspace, 'source' | 'targetBranch' | 'preparation'> }
        >
      }>({
        kind: 'ultimate.subagents',
        version: 1,
        scope: 'conversation',
        history: 'latest',
        fork: 'initial',
        initial: () => ({ agents: {} }),
      })
      const harness = host.harness()
      const parents = await harness.commit(records, context)
      const legacyParents: typeof parents = []
      for (const parent of parents) {
        const legacy = await harness.snapshot(LegacySubagents, parent.id, context)
        if (legacy && Object.values(legacy.agents).some((child) => child.isolate))
          legacyParents.push(parent)
      }
      await harness.commit(async (tx) => {
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanTasks({}, 256, cursor)
          if (
            page.items.some(
              (task) =>
                task.kind === 'ultimate.isolate-lifecycle' && task.state.status !== 'terminal',
            )
          )
            throw new Error(
              'Active legacy isolate lifecycle tasks must finish before workspace migration; resume the previous core first',
            )
          cursor = page.next
        } while (cursor !== undefined)
        for (const parent of legacyParents) {
          const source = (await tx.doc(AgentDoc, parent.id)).cwd ?? host.projectRoot
          const canonical = await realpath(
            await worktree.git(source, 'rev-parse', '--show-toplevel'),
          )
          const target = await worktree.target(canonical)
          const index = await tx.doc(LegacySubagents, parent.id)
          for (const [id, child] of Object.entries(index.agents)) {
            if (!child.isolate) continue
            const saved = await tx.doc(WorkspaceDoc, Number(id) as ConversationId)
            if (saved.workspace) throw new Error(`Conflicting legacy workspace identity: ${id}`)
            saved.workspace = {
              ...child.isolate,
              source: canonical,
              ...target,
              preparation: 'ready',
            }
            ;(await tx.doc(LifecycleQueue)).children[id] = []
            delete child.isolate
          }
        }
      }, context)
    },
  }
}
export type Workspaces = ReturnType<typeof createWorkspaces>
