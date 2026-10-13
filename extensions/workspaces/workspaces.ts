import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord'
import {
  configure,
  defineDoc,
  defineTask,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, TaskId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { git, setup } from './git.ts'
import { createLander, landerAgent, landerPath, log } from './lander.ts'
import type { LandResult, SubmitResult, WorkspaceIndex, WorkspaceInfo } from './types.ts'

export const Workspaces = defineDoc<WorkspaceIndex>({
  kind: 'ultimate.workspaces',
  version: 4,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ items: {}, queue: [], landers: {}, landerConversations: {}, results: {} }),
  migrate: (value, from) => {
    if (from < 3)
      return {
        ...(from < 2
          ? { items: (value as Pick<WorkspaceIndex, 'items'>).items, queue: [], landers: {} }
          : (value as Pick<WorkspaceIndex, 'items' | 'queue' | 'landers'>)),
        landerConversations: {},
        results: {},
      }
    // Version 4 records each submission's steps; earlier ones start without.
    const index = value as WorkspaceIndex
    return {
      ...index,
      queue: index.queue.map((item) => ({ ...item, steps: [] })),
      results: Object.fromEntries(
        Object.entries(index.results).map(([id, result]) => [
          id,
          { ...result, tip: id.split('-')[1], steps: [] },
        ]),
      ),
    }
  },
})
/**
 * Lander tasks started by this version of the code. A reload that changes it imports this module anew with an empty
 * set, so a fault of a task outside it is the previous code's.
 */
const started = new Set<number>()
/** Whether `source` has no live lander task: none recorded, or one that ended (finished, faulted, aborted). */
async function landerIdle(tx: Tx, index: WorkspaceIndex, source: string) {
  const running = index.landers[source]
  const live = running === undefined ? undefined : await tx.task(running as TaskId)
  return !live || live.state.status === 'terminal' || live.state.status === 'completing'
}
type Host = Pick<
  ExtensionHost,
  | 'harness'
  | 'home'
  | 'ultimateRoot'
  | 'projectRoot'
  | 'userHome'
  | 'modelRuntime'
  | 'projectSettings'
  | 'resource'
  | 'extensions'
  | 'metadata'
>
export function workspaces(host: Host) {
  const queues = host.resource('workspaces.land', () => new Map<string, Promise<unknown>>())
  /** Runs writes to one source checkout one at a time, across synchronous landing and the lander. */
  async function serial<T>(source: string, operation: () => Promise<T>): Promise<T> {
    const queued = (queues.get(source) ?? Promise.resolve()).catch(() => undefined).then(operation)
    queues.set(source, queued)
    try {
      return await queued
    } finally {
      if (queues.get(source) === queued) queues.delete(source)
    }
  }
  const Lander = createLander(host, Workspaces, serial)
  /** Start the lander task of `source` in its lander conversation. Call only after `landerIdle`, before any write. */
  const startLander = async (tx: Tx, index: WorkspaceIndex, source: string) => {
    // Not background: the task is the lander conversation's work, so it shows as working while it lands.
    index.landers[source] = await tx.createTask(
      Lander,
      { source },
      {
        conversationId: index.landerConversations[source] as ConversationId,
        ownership: { kind: 'conversation' },
      },
    )
    started.add(index.landers[source])
  }
  /**
   * The lander conversation of `source`, created once with title "Lander · <target>" and label `lander`; its cwd is the
   * lander's checkout. Reads before writes, as a transaction requires: call it before anything else writes.
   */
  async function ensureLander(
    tx: Tx,
    index: WorkspaceIndex,
    source: string,
    target: string,
    /** `landerPath()` of `source`, resolved before the transaction. */
    path: string,
  ) {
    const known = index.landerConversations[source] as ConversationId | undefined
    if (known !== undefined && (await tx.conversation(known))) return known
    const lander = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id
    await configure(tx, lander, { cwd: path })
    Object.assign(await tx.doc(host.metadata, lander), {
      title: `Lander · ${target}`,
      label: 'lander',
    })
    index.landerConversations[source] = lander
    return lander
  }
  /**
   * Make sure the project's checkout has its lander conversation, configured from the effective `lander` definition;
   * every lander conversation follows the definition as it is now. Idempotent; a project outside git has none.
   */
  async function standLander(context: Context) {
    const source = await git(host.projectRoot, 'rev-parse', '--show-toplevel')
      .then((path) => realpath(path))
      .catch(() => undefined)
    const target =
      source && (await git(source, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''))
    const { change } = await landerAgent(host, context)
    const path = source && (await landerPath(host.home, source))
    await host.harness().commit(async (tx) => {
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      const landers: ConversationId[] = []
      for (const id of Object.values(index.landerConversations) as ConversationId[])
        if (await tx.conversation(id)) landers.push(id)
      if (source && target && path) {
        const own = await ensureLander(tx, index, source, target, path)
        if (!landers.includes(own)) landers.push(own)
      }
      for (const id of landers) await configure(tx, id, change)
    }, context)
  }
  /**
   * Restart the lander of every source whose queue holds submissions but whose task ended without draining it, as a
   * task faulted by a reload of this code does. Idempotent: a source with a live task keeps it.
   */
  async function resume(context: Context) {
    const restarted = await host.harness().commit(async (tx) => {
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      const sources = [...new Set(index.queue.map((item) => item.source))].filter(
        (source) => index.landerConversations[source] !== undefined,
      )
      const stopped: string[] = []
      for (const source of sources) if (await landerIdle(tx, index, source)) stopped.push(source)
      for (const source of stopped) {
        for (const item of index.queue)
          if (item.source === source) {
            item.state = 'queued'
            delete item.step
          }
        await startLander(tx, index, source)
      }
      return stopped.length
    }, context)
    if (restarted) host.harness().resume()
  }
  const get = async (id: ConversationId, context: Context) =>
    (await host.harness().snapshot(Workspaces, ROOT_CONVERSATION_ID, context))?.items[String(id)]
  const Preparation = defineTask<{ id: ConversationId }, { phase: 'prepare' }, null>({
    name: 'workspaces.prepare',
    version: 1,
    initial: () => ({ phase: 'prepare' }),
    phases: {
      prepare: async (task, runtime, context) => {
        const workspace = (await get(task.input.id, context))!
        let created = false
        try {
          const registered = (await git(workspace.source, 'worktree', 'list', '--porcelain'))
            .split('\n\n')
            .find((entry) => entry.split('\n').includes(`worktree ${workspace.path}`))
          const resumed = await runtime.memo<boolean>('started', context)
          if (registered) {
            if (
              !resumed ||
              !registered.split('\n').includes(`branch refs/heads/${workspace.branch}`)
            )
              throw new Error(`Workspace path already exists: ${workspace.path}`)
          } else {
            if (
              await lstat(workspace.path).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error
                return undefined
              })
            )
              throw new Error(`Workspace path already exists: ${workspace.path}`)
            if (await git(workspace.source, 'branch', '--list', workspace.branch)) {
              if (
                !resumed ||
                (await git(workspace.source, 'rev-parse', workspace.branch)) !== workspace.base
              )
                throw new Error(`Workspace branch already exists: ${workspace.branch}`)
              await git(workspace.source, 'branch', '-D', workspace.branch)
            }
            await runtime.memo('started', true, context)
            created = true
            await git(
              workspace.source,
              'worktree',
              'add',
              '-b',
              workspace.branch,
              workspace.path,
              workspace.base,
            )
          }
          created = true
          await setup(
            workspace.source,
            workspace.path,
            await host.projectSettings(),
            runtime.signal,
          )
          await runtime.commit(async (tx) => {
            ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(task.input.id)].state =
              'ready'
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          // Remove only the registered checkout created for this record, never an existing path.
          const registered = (await git(workspace.source, 'worktree', 'list', '--porcelain'))
            .split('\n\n')
            .find(
              (entry) =>
                entry.split('\n').includes(`worktree ${workspace.path}`) &&
                entry.split('\n').includes(`branch refs/heads/${workspace.branch}`),
            )
          if (created) {
            if (registered)
              await git(workspace.source, 'worktree', 'remove', workspace.path).catch(
                () => undefined,
              )
            if (
              (await git(workspace.source, 'rev-parse', workspace.branch).catch(() => '')) ===
              workspace.base
            )
              await git(workspace.source, 'branch', '-D', workspace.branch).catch(() => undefined)
          }
          await runtime.commit(async (tx) => {
            const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[
              String(task.input.id)
            ]
            saved.state = 'failed'
            saved.error = (error instanceof Error ? error.message : String(error)).slice(-4000)
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, context)
        }
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(task.input.id)]
        saved.state = 'failed'
        saved.error = 'Workspace preparation aborted'
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  async function idle(id: ConversationId, context: Context, own = false) {
    if (own) return
    if ((await host.harness().snapshot(LiveDoc, id, context))?.run)
      throw new Error('Conversation is running; wait or stop it before landing or removal')
    if ((await host.harness().snapshot(InboxDoc, id, context))?.items.length)
      throw new Error('Conversation has queued input; wait or cancel it first')
  }
  async function land(id: ConversationId, context: Context, own = false): Promise<LandResult> {
    const record = await get(id, context)
    if (!record) throw new Error('Conversation has no workspace')
    return serial(record.source, async () => {
      const workspace = (await get(id, context))!
      const source = workspace.source
      await idle(id, context, own)
      if (workspace.state !== 'ready') throw new Error(`Workspace is ${workspace.state}`)
      const dirty = await git(workspace.path, 'status', '--porcelain')
      if (dirty) throw new Error(`Worktree is dirty:\n${dirty}`)
      if (
        (await git(source, 'symbolic-ref', '--short', 'HEAD').catch(() => '')) !== workspace.target
      )
        throw new Error(`Target branch changed; check out ${workspace.target} first`)
      if ((await git(workspace.path, 'symbolic-ref', '--short', 'HEAD')) !== workspace.branch)
        throw new Error('Workspace branch changed')
      const tip = await git(workspace.path, 'rev-parse', 'HEAD')
      const head = await git(source, 'rev-parse', 'HEAD')
      const integrated = await git(source, 'merge-base', '--is-ancestor', tip, head).then(
        () => true,
        () => false,
      )
      let result: LandResult = { text: 'Nothing to land.', landed: tip, commits: [], paths: [] }
      if (!integrated) {
        if (
          !(await git(source, 'merge-base', '--is-ancestor', head, tip).then(
            () => true,
            () => false,
          ))
        )
          throw new Error(
            `Target moved or diverged; update the workspace onto ${workspace.target} and verify again`,
          )
        const commits = (await git(workspace.path, 'log', '--oneline', `${head}..${tip}`))
          .split('\n')
          .filter(Boolean)
        const paths = (await git(workspace.path, 'diff', '--name-only', head, tip))
          .split('\n')
          .filter(Boolean)
        const needsRestart =
          (await realpath(source)) === (await realpath(host.ultimateRoot)) &&
          paths.some((path) => /^(server|shared)\//.test(path))
        await git(source, 'merge', '--ff-only', tip)
        result = {
          text: `Landed commits:\n${commits.join('\n')}\nChanged paths:\n${paths.join('\n')}${needsRestart ? '\nNeeds restart.' : ''}`,
          landed: tip,
          commits,
          paths,
          ...(needsRestart ? { needsRestart: true } : {}),
        }
      }
      await host.harness().commit(async (tx) => {
        ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].landed = tip
      }, context)
      return result
    })
  }
  async function submit(id: ConversationId, context: Context): Promise<SubmitResult> {
    const workspace = await get(id, context)
    if (!workspace) throw new Error('Conversation has no workspace')
    if (workspace.state !== 'ready') throw new Error(`Workspace is ${workspace.state}`)
    const dirty = await git(workspace.path, 'status', '--porcelain')
    if (dirty) throw new Error(`Worktree is dirty:\n${dirty}`)
    if ((await git(workspace.path, 'symbolic-ref', '--short', 'HEAD')) !== workspace.branch)
      throw new Error('Workspace branch changed')
    const tip = await git(workspace.path, 'rev-parse', 'HEAD')
    const path = await landerPath(host.home, workspace.source)
    const { change } = await landerAgent(host, context)
    const result = await host.harness().commit(async (tx) => {
      const row = await tx.conversation(id)
      if (!row || row.owner || row.parent)
        throw new Error('Only a top-level main conversation submits its own workspace')
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      const { source, target } = index.items[String(id)]
      // Reads first: a transaction cannot read tables after its first write.
      const stopped = await landerIdle(tx, index, source)
      const lander = await ensureLander(tx, index, source, target, path)
      const queued = index.queue.find(
        (item) => item.conversationId === id && item.tip === tip && item.state === 'queued',
      )
      const entry = queued ?? {
        id: `${id}-${tip.slice(0, 7)}-${Date.now().toString(36)}`,
        conversationId: id,
        source,
        target,
        tip,
        at: Date.now(),
        state: 'queued' as const,
        steps: [],
      }
      await configure(tx, lander, change)
      if (!queued) {
        await log(tx, lander, entry, { step: 'queued' })
        index.queue.push(entry)
      }
      if (stopped) await startLander(tx, index, source)
      const position = index.queue
        .filter((item) => item.source === source)
        .findIndex((item) => item.id === entry.id)
      return {
        id: entry.id,
        position: position + 1,
        lander,
        text: `Submitted ${tip.slice(0, 7)} as ${entry.id}, position ${position + 1} in the ${target} queue. The lander (conversation #${lander}) reports back here when it lands or fails; keep working.`,
      }
    }, context)
    host.harness().resume()
    return result
  }
  return {
    Preparation,
    Lander,
    resume,
    standLander,
    started,
    get,
    land,
    submit,
    async create(tx: Tx, id: ConversationId, cwd: string) {
      if (
        !host.extensions().some((extension) => extension.name === 'workspaces' && extension.enabled)
      )
        throw new Error('Enable workspaces to create an isolated conversation')
      const source = await realpath(await git(cwd, 'rev-parse', '--show-toplevel'))
      const target = await git(source, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
      if (!target) throw new Error('Check out a branch first')
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      if (index.items[String(id)]) throw new Error('Conversation already has a workspace')
      await mkdir(join(host.home, 'worktrees'), { recursive: true })
      const parent = await realpath(join(host.home, 'worktrees'))
      index.items[String(id)] = {
        path: join(parent, String(id)),
        branch: `ultimate/${createHash('sha256').update(host.home).digest('hex').slice(0, 6)}-${id}`,
        base: await git(source, 'rev-parse', 'HEAD'),
        source,
        target,
        state: 'preparing',
      }
      await configure(tx, id, { cwd: index.items[String(id)].path })
      await tx.createTask(
        Preparation,
        { id },
        { conversationId: id, ownership: { kind: 'conversation' }, background: true },
      )
      return index.items[String(id)]
    },
    async ready(id: ConversationId, context: Context) {
      if ((await get(id, context))?.state !== 'preparing') return
      const harness = host.harness()
      const task = await harness.commit(
        async (tx) =>
          (await tx.scanTasks({ conversationId: id, kind: Preparation.definition.name }, 1))
            .items[0],
        context,
      )
      if (task) await harness.waitForTask(task.id, context)
    },
    async info(id: ConversationId, context: Context): Promise<WorkspaceInfo | null> {
      const workspace = await get(id, context)
      if (!workspace) return null
      return {
        ...workspace,
        ahead: await git(workspace.source, 'rev-list', '--count', `HEAD..${workspace.branch}`).then(
          Number,
          () => null,
        ),
        tip: await git(workspace.path, 'rev-parse', 'HEAD').catch(() => null),
        sourceTip: await git(workspace.source, 'rev-parse', 'HEAD').catch(() => null),
        currentBranch: await git(workspace.path, 'symbolic-ref', '--short', 'HEAD').catch(
          () => null,
        ),
        sourceBranch: await git(workspace.source, 'symbolic-ref', '--short', 'HEAD').catch(
          () => null,
        ),
      }
    },
    async discard(id: ConversationId, context: Context) {
      await idle(id, context)
      const workspace = await get(id, context)
      if (!workspace) throw new Error('Conversation has no workspace')
      if (workspace.state === 'preparing') throw new Error('Workspace is preparing')
      if (workspace.state !== 'removed') {
        if (await lstat(workspace.path).catch(() => undefined))
          await git(workspace.source, 'worktree', 'remove', workspace.path)
        await host.harness().commit(async (tx) => {
          ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'removed'
        }, context)
      }
      return { text: `Discarded isolate; kept branch ${workspace.branch}.` }
    },
    /** Discard every clean, idle, ready checkout with its own commits that its target branch already contains. */
    async removeLanded(context: Context) {
      const index = await host.harness().snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
      const removed: number[] = []
      for (const [key, workspace] of Object.entries(index?.items ?? {})) {
        const id = Number(key) as ConversationId
        if (workspace.state !== 'ready') continue
        if (index!.queue.some((item) => item.conversationId === id)) continue
        const tip = await git(workspace.path, 'rev-parse', 'HEAD').catch(() => '')
        // A checkout without commits of its own is not landed; its conversation may still start work.
        if (
          !tip ||
          tip === workspace.base ||
          !(await git(
            workspace.source,
            'merge-base',
            '--is-ancestor',
            tip,
            `refs/heads/${workspace.target}`,
          ).then(
            () => true,
            () => false,
          )) ||
          (await git(workspace.path, 'status', '--porcelain'))
        )
          continue
        try {
          await this.discard(id, context)
          removed.push(id)
        } catch {
          // Running or queued conversations keep their checkout.
        }
      }
      return {
        removed,
        text: removed.length
          ? `Removed ${removed.map((id) => `W${id}`).join(', ')}.`
          : 'No landed checkouts to remove.',
      }
    },
  }
}
