import { realpath } from 'node:fs/promises'
import { defineTask } from '@earendil-works/pi-durable'
import type { ConversationId, TaskId, RunningTask, TaskRuntime } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import type { Workspace } from '../../shared/protocol.ts'
import { WorkspaceDoc, LifecycleQueue } from './doc.ts'
import type { LifecycleResult } from './doc.ts'
import * as worktree from './worktree.ts'

export type Input = {
  parent: ConversationId
  child: ConversationId
  operation: 'land' | 'discard'
  caller?: TaskId
}
type State =
  | { phase: 'queue' }
  | { phase: 'check'; cwd: string; previous?: TaskId }
  | { phase: 'merge'; cwd: string; head: string; result: LifecycleResult }
  | { phase: 'record'; cwd: string; head: string; result: LifecycleResult }
export type LifecycleHost = {
  projectRoot: string
  ultimateRoot: string
  guard(
    child: ConversationId,
    parent: ConversationId,
    operation: 'land' | 'discard',
    caller: TaskId | undefined,
    current: TaskId,
    context: Context,
  ): Promise<void>
}
function guarded<P extends State>(
  handler: (
    task: RunningTask<Input, P, LifecycleResult>,
    runtime: TaskRuntime<Input, State, LifecycleResult, object>,
    context: Context,
  ) => Promise<void>,
) {
  return async (
    task: RunningTask<Input, P, LifecycleResult>,
    runtime: TaskRuntime<Input, State, LifecycleResult, object>,
    context: Context,
  ) => {
    try {
      await handler(task, runtime, context)
    } catch (error) {
      if (runtime.signal.aborted) throw error
      await runtime.commit(
        () => ({
          status: 'terminal',
          outcome: {
            status: 'failed',
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          },
        }),
        context,
      )
    }
  }
}
async function checkout(workspace: Workspace) {
  const branch = await worktree.git(workspace.source, 'symbolic-ref', '--short', 'HEAD')
  if (branch !== workspace.targetBranch)
    throw new Error('Target branch changed; restore the saved target branch before landing')
  const dirty = await worktree.git(workspace.source, 'status', '--porcelain')
  if (dirty) throw new Error(`Target checkout is dirty:\n${dirty}`)
}
export function lifecycle(host: LifecycleHost) {
  return defineTask<Input, State, LifecycleResult>({
    name: 'ultimate.workspace-lifecycle',
    version: 1,
    initial: () => ({ phase: 'queue' }),
    phases: {
      queue: guarded(async (task, runtime, context) => {
        const workspace = (await runtime.snapshot(WorkspaceDoc, task.input.child, context))
          ?.workspace
        if (!workspace) throw new Error('Conversation has no workspace')
        const cwd = await realpath(workspace.source)
        await runtime.commit(async (tx) => {
          const queue = await tx.doc(LifecycleQueue)
          let previous = queue.checkouts[cwd]
          while (previous && (await tx.task(previous))?.state.status === 'terminal')
            previous = queue.predecessors[String(previous)]
          queue.checkouts[cwd] = task.id
          if (previous) queue.predecessors[String(task.id)] = previous
          return previous
            ? {
                status: 'waiting',
                on: [previous],
                policy: 'allSettled',
                checkpoint: { phase: 'check', cwd, previous },
              }
            : { status: 'running', checkpoint: { phase: 'check', cwd } }
        }, context)
      }),
      check: guarded(async (task, runtime, context) => {
        const { cwd, previous } = task.state.checkpoint
        if (previous) {
          let waiting = false
          await runtime.commit(async (tx) => {
            const queue = await tx.doc(LifecycleQueue)
            let ancestor: TaskId | undefined = previous
            while (ancestor && (await tx.task(ancestor))?.state.status === 'terminal')
              ancestor = queue.predecessors[String(ancestor)]
            waiting = !!ancestor
            return ancestor
              ? {
                  status: 'waiting',
                  on: [ancestor],
                  policy: 'allSettled',
                  checkpoint: { phase: 'check', cwd, previous: ancestor },
                }
              : undefined
          }, context)
          if (waiting) return
        }
        await host.guard(
          task.input.child,
          task.input.parent,
          task.input.operation,
          task.input.caller,
          task.id,
          context,
        )
        const workspace = (await runtime.snapshot(WorkspaceDoc, task.input.child, context))
          ?.workspace
        if (!workspace) throw new Error('Conversation has no workspace')
        if (task.input.operation === 'discard') {
          const result = await worktree.discard(cwd, workspace)
          await runtime.commit(async (tx) => {
            ;(await tx.doc(WorkspaceDoc, task.input.child)).workspace!.state = 'discarded'
            return { status: 'terminal', outcome: { status: 'completed', result } }
          }, context)
          return
        }
        if (workspace.state === 'discarded') throw new Error('Workspace is discarded')
        await checkout(workspace)
        const dirty = await worktree.git(workspace.path, 'status', '--porcelain')
        if (dirty) throw new Error(`Worktree is dirty:\n${dirty}`)
        const branch = await worktree.git(workspace.path, 'symbolic-ref', '--short', 'HEAD')
        if (branch !== workspace.branch) throw new Error('Workspace branch changed')
        const head = await worktree.git(cwd, 'rev-parse', 'HEAD')
        const tip = await worktree.git(workspace.path, 'rev-parse', 'HEAD')
        const integrated = await worktree.git(cwd, 'merge-base', '--is-ancestor', tip, head).then(
          () => true,
          () => false,
        )
        if (integrated) {
          await runtime.commit(async (tx) => {
            if (tip !== workspace.base)
              (await tx.doc(WorkspaceDoc, task.input.child)).workspace!.landed = tip
            return {
              status: 'terminal',
              outcome: {
                status: 'completed',
                result: {
                  text: 'Nothing to land.',
                  ...(tip !== workspace.base ? { landed: tip } : {}),
                },
              },
            }
          }, context)
          return
        }
        const contains = await worktree.git(cwd, 'merge-base', '--is-ancestor', head, tip).then(
          () => true,
          () => false,
        )
        if (!contains)
          throw new Error(
            'Target moved or diverged; update the workspace onto the target and reverify before landing. No automatic rebase.',
          )
        const commits = await worktree.git(workspace.path, 'log', '--oneline', `${head}..${tip}`)
        const paths = (await worktree.git(workspace.path, 'diff', '--name-only', head, tip))
          .split('\n')
          .filter(Boolean)
        const needsRestart =
          host.projectRoot === host.ultimateRoot &&
          workspace.source === host.projectRoot &&
          paths.some((path) => /^(server|shared)\//.test(path))
        const result = {
          text: `Landed commits:\n${commits}\nChanged paths:\n${paths.join('\n')}${needsRestart ? '\nNeeds restart.' : ''}`,
          paths,
          landed: tip,
          ...(needsRestart ? { needsRestart: true } : {}),
        }
        await runtime.commit(
          () => ({ status: 'running', checkpoint: { phase: 'merge', cwd, head, result } }),
          context,
        )
      }),
      merge: guarded(async (task, runtime, context) => {
        const state = task.state.checkpoint
        await host.guard(
          task.input.child,
          task.input.parent,
          task.input.operation,
          task.input.caller,
          task.id,
          context,
        )
        const workspace = (await runtime.snapshot(WorkspaceDoc, task.input.child, context))!
          .workspace!
        await checkout(workspace)
        const dirty = await worktree.git(workspace.path, 'status', '--porcelain')
        if (dirty) throw new Error(`Worktree is dirty:\n${dirty}`)
        if (
          (await worktree.git(workspace.path, 'symbolic-ref', '--short', 'HEAD')) !==
          workspace.branch
        )
          throw new Error('Workspace branch changed')
        if ((await worktree.git(workspace.path, 'rev-parse', 'HEAD')) !== state.result.landed)
          throw new Error('Workspace changed after verification; reverify before landing')
        const current = await worktree.git(state.cwd, 'rev-parse', 'HEAD')
        if (current !== state.result.landed) {
          if (current !== state.head)
            throw new Error('Target moved; update and reverify before landing')
          await worktree.git(state.cwd, 'merge', '--ff-only', state.result.landed)
        }
        await runtime.commit(
          () => ({ status: 'running', checkpoint: { ...state, phase: 'record' } }),
          context,
        )
      }),
      record: guarded(async (task, runtime, context) => {
        const result = task.state.checkpoint.result
        await runtime.commit(async (tx) => {
          ;(await tx.doc(WorkspaceDoc, task.input.child)).workspace!.landed = result.landed
          return { status: 'terminal', outcome: { status: 'completed', result } }
        }, context)
      }),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
}
