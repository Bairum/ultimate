import { realpath, access } from 'node:fs/promises'
import { join } from 'node:path'
import { defineDoc, defineTask, LiveDoc } from '@earendil-works/pi-durable'
import type { ConversationId, TaskId, RunningTask, TaskRuntime } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { Subagents } from '../server.ts'
import * as worktree from './worktree.ts'

export type LifecycleResult = {
  text: string
  landed?: string
  paths?: string[]
  needsRestart?: boolean
  state?: 'discarded'
}
export const LifecycleQueue = defineDoc<{
  checkouts: Record<string, TaskId>
  predecessors: Record<string, TaskId>
  children: Record<string, TaskId[]>
  requests: Record<string, TaskId<LifecycleResult>>
}>({
  kind: 'ultimate.isolate-queue',
  version: 1,
  scope: 'session',
  initial: () => ({ checkouts: {}, predecessors: {}, children: {}, requests: {} }),
})
type Input = { parent: ConversationId; child: ConversationId; operation: 'land' | 'discard' }
type State =
  | { phase: 'queue' }
  | { phase: 'check'; cwd: string; previous?: TaskId }
  | {
      [P in 'rebase' | 'merge' | 'record']: {
        phase: P
        cwd: string
        head: string
        result: LifecycleResult
      }
    }['rebase' | 'merge' | 'record']
async function abortRebase(path: string) {
  const directory = await worktree
    .git(path, 'rev-parse', '--absolute-git-dir')
    .catch(() => undefined)
  if (!directory) return
  const active = await Promise.all(
    ['rebase-merge', 'rebase-apply'].map((name) =>
      access(join(directory, name)).then(
        () => true,
        () => false,
      ),
    ),
  )
  if (active.some(Boolean)) await worktree.git(path, 'rebase', '--abort')
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
            error: { message: error instanceof Error ? error.message : String(error) },
          },
        }),
        context,
      )
    }
  }
}
export function lifecycle(host: Pick<ExtensionHost, 'projectRoot' | 'ultimateRoot'>) {
  return defineTask<Input, State, LifecycleResult>({
    name: 'ultimate.isolate-lifecycle',
    version: 1,
    initial: () => ({ phase: 'queue' }),
    phases: {
      queue: guarded(async (task, runtime, context) => {
        const cwd = await realpath(
          await worktree.git(
            (await runtime.agent(context)).cwd ?? host.projectRoot,
            'rev-parse',
            '--show-toplevel',
          ),
        )
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
        const child = (await runtime.snapshot(Subagents, task.input.parent, context))?.agents[
          String(task.input.child)
        ]
        if (!child?.isolate)
          throw new Error('id must identify a worktree child of this conversation')
        if ((await runtime.snapshot(LiveDoc, task.input.child, context))?.run)
          throw new Error('Child is running; wait or stop it first')
        const isolate = child.isolate
        if (task.input.operation === 'discard') {
          const result = await worktree.discard(cwd, isolate)
          await runtime.commit(async (tx) => {
            ;(await tx.doc(Subagents, task.input.parent)).agents[
              String(task.input.child)
            ].isolate!.state = 'discarded'
            return { status: 'terminal', outcome: { status: 'completed', result } }
          }, context)
          return
        }
        if (isolate.state === 'discarded') throw new Error('Isolate is discarded')
        const head = await worktree.git(cwd, 'rev-parse', 'HEAD')
        const dirty = await worktree.git(isolate.path, 'status', '--porcelain')
        if (dirty) throw new Error(`Worktree is dirty:\n${dirty}`)
        if (!Number(await worktree.git(cwd, 'rev-list', '--count', `${head}..${isolate.branch}`))) {
          const tip = await worktree.git(cwd, 'rev-parse', isolate.branch)
          await runtime.commit(async (tx) => {
            if (tip !== isolate.base)
              (await tx.doc(Subagents, task.input.parent)).agents[
                String(task.input.child)
              ].isolate!.landed = tip
            return {
              status: 'terminal',
              outcome: {
                status: 'completed',
                result: {
                  text: 'Nothing to land.',
                  ...(tip === isolate.base ? {} : { landed: tip }),
                },
              },
            }
          }, context)
          return
        }
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: { phase: 'rebase', cwd, head, result: { text: '' } },
          }),
          context,
        )
      }),
      rebase: guarded(async (task, runtime, context) => {
        const { cwd, head } = task.state.checkpoint
        const isolate = (await runtime.snapshot(Subagents, task.input.parent, context))!.agents[
          String(task.input.child)
        ].isolate!
        // A crash can leave Git between commands; restart that rebase from its original tip.
        await abortRebase(isolate.path)
        const contains = await worktree
          .git(cwd, 'merge-base', '--is-ancestor', head, isolate.branch)
          .then(
            () => true,
            () => false,
          )
        if (!contains) {
          try {
            await worktree.git(isolate.path, 'rebase', head)
          } catch (error) {
            const conflicts = await worktree.git(
              isolate.path,
              'diff',
              '--name-only',
              '--diff-filter=U',
            )
            await abortRebase(isolate.path)
            throw new Error(
              `Rebase failed: ${conflicts || String(error)}. Message the child to rebase onto ${head} and resolve these files before landing.`,
              { cause: error },
            )
          }
        }
        const commits = await worktree.git(isolate.path, 'log', '--oneline', `${head}..HEAD`)
        const paths = (await worktree.git(isolate.path, 'diff', '--name-only', head, 'HEAD'))
          .split('\n')
          .filter(Boolean)
        const landed = await worktree.git(isolate.path, 'rev-parse', 'HEAD')
        const needsRestart =
          host.projectRoot === host.ultimateRoot &&
          paths.some((path) => /^(server|shared)\//.test(path))
        const result = {
          text: `Landed commits:\n${commits}\nChanged paths:\n${paths.join('\n')}${needsRestart ? '\nNeeds restart.' : ''}`,
          paths,
          landed,
          ...(needsRestart ? { needsRestart: true } : {}),
        }
        await runtime.commit(
          () => ({ status: 'running', checkpoint: { phase: 'merge', cwd, head, result } }),
          context,
        )
      }),
      merge: guarded(async (task, runtime, context) => {
        const state = task.state.checkpoint
        const isolate = (await runtime.snapshot(Subagents, task.input.parent, context))!.agents[
          String(task.input.child)
        ].isolate!
        if ((await worktree.git(state.cwd, 'rev-parse', 'HEAD')) !== state.result.landed)
          await worktree.git(state.cwd, 'merge', '--ff-only', isolate.branch)
        await runtime.commit(
          () => ({ status: 'running', checkpoint: { ...state, phase: 'record' } }),
          context,
        )
      }),
      record: guarded(async (task, runtime, context) => {
        const result = task.state.checkpoint.result
        await runtime.commit(async (tx) => {
          ;(await tx.doc(Subagents, task.input.parent)).agents[
            String(task.input.child)
          ].isolate!.landed = result.landed
          return { status: 'terminal', outcome: { status: 'completed', result } }
        }, context)
      }),
    },
    abort: async (task, runtime, context) => {
      const isolate = (await runtime.snapshot(Subagents, task.input.parent, context))?.agents[
        String(task.input.child)
      ]?.isolate
      if (isolate && task.state.checkpoint.phase === 'rebase') await abortRebase(isolate.path)
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
    },
  })
}
