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
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { git, setup } from './git.ts'
import type { LandResult, WorkspaceIndex, WorkspaceInfo } from './types.ts'

export const Workspaces = defineDoc<WorkspaceIndex>({
  kind: 'ultimate.workspaces',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ items: {} }),
})
type Host = Pick<
  ExtensionHost,
  'harness' | 'home' | 'ultimateRoot' | 'projectSettings' | 'resource' | 'extensions'
>
export function workspaces(host: Host) {
  const queues = host.resource('workspaces.land', () => new Map<string, Promise<unknown>>())
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
          await mkdir(join(host.home, 'worktrees'), { recursive: true })
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
            if (await git(workspace.source, 'branch', '--list', workspace.branch))
              throw new Error(`Workspace branch already exists: ${workspace.branch}`)
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
    const workspace = await get(id, context)
    if (!workspace) throw new Error('Conversation has no workspace')
    const source = workspace.source
    const previous = queues.get(source) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        await idle(id, context, own)
        if (workspace.state !== 'ready') throw new Error(`Workspace is ${workspace.state}`)
        const dirty = await git(workspace.path, 'status', '--porcelain')
        if (dirty) throw new Error(`Worktree is dirty:\n${dirty}`)
        const targetDirty = await git(source, 'status', '--porcelain')
        if (targetDirty) throw new Error(`Target checkout is dirty:\n${targetDirty}`)
        if (
          (await git(source, 'symbolic-ref', '--short', 'HEAD').catch(() => '')) !==
          workspace.target
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
    queues.set(source, operation)
    try {
      return await operation
    } finally {
      if (queues.get(source) === operation) queues.delete(source)
    }
  }
  return {
    Preparation,
    get,
    land,
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
      index.items[String(id)] = {
        path: join(host.home, 'worktrees', String(id)),
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
  }
}
