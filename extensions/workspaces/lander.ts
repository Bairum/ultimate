import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@earendil-works/chord'
import { withAbortSignal } from '@earendil-works/chord/context'
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { ConversationDocToken, ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { exclusiveSlot } from '../exclusive-commands/slot.ts'
import { git, setup } from './git.ts'
import type { WorkspaceIndex } from './types.ts'

const exec = promisify(execFile)
type Host = Pick<ExtensionHost, 'home' | 'ultimateRoot' | 'projectSettings' | 'resource'>
type Settings = { checks: string[]; push?: string }
/** Bounded retries when the target moves while a submission is integrated. */
const attempts = 3
/** Seconds one check may run. */
const checkTimeout = 30 * 60

export const landerSettings = async (host: Pick<Host, 'projectSettings'>): Promise<Settings> => {
  const lander = (await host.projectSettings()).lander as
    | { checks?: unknown; push?: unknown }
    | undefined
  const checks = lander?.checks ?? []
  if (!Array.isArray(checks) || !checks.every((check) => typeof check === 'string'))
    throw new Error('lander.checks must be an array of command strings')
  if (lander?.push !== undefined && typeof lander.push !== 'string')
    throw new Error('lander.push must be a remote name')
  return { checks, ...(lander?.push ? { push: lander.push } : {}) }
}
const contains = (cwd: string, ancestor: string, descendant: string) =>
  git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant).then(
    () => true,
    () => false,
  )
const lines = (text: string) => text.split('\n').filter(Boolean)
const failure = (error: unknown) => {
  const output = error as Error & { stdout?: string; stderr?: string }
  return `${output.stdout ?? ''}${output.stderr ?? ''}${output.stdout || output.stderr ? '' : output.message}`
    .trim()
    .slice(-3000)
}
/** Run a network git command in `cwd`; longer than git()'s local timeout. */
const remote = (cwd: string, signal: AbortSignal, ...args: string[]) =>
  exec('git', args, { cwd, signal, timeout: 300000, maxBuffer: 1024 * 1024 })

type Prepared = {
  base: string
  integrated: string
  commits: string[]
  paths: string[]
  flaky: string[]
}
type State =
  | { phase: 'next' }
  | { phase: 'land'; id: string; attempt: number; pushRetried?: boolean }
  | { phase: 'report'; id: string; conversationId: number; text: string }

export function createLander(
  host: Host,
  Workspaces: ConversationDocToken<WorkspaceIndex>,
  /** Serializes source checkout writes with synchronous landing. */
  serial: <T>(source: string, operation: () => Promise<T>) => Promise<T>,
) {
  const slot = exclusiveSlot(host)
  async function checkout(source: string, tip: string) {
    const name = createHash('sha256').update(source).digest('hex').slice(0, 12)
    await mkdir(join(host.home, 'lander'), { recursive: true })
    const path = join(await realpath(join(host.home, 'lander')), name)
    const registered = (await git(source, 'worktree', 'list', '--porcelain'))
      .split('\n\n')
      .some((entry) => entry.split('\n').includes(`worktree ${path}`))
    if (!registered) {
      // The directory is the lander's own; a crash may have left it half created.
      await rm(path, { recursive: true, force: true })
      await git(source, 'worktree', 'prune')
      await git(source, 'worktree', 'add', '--detach', path, tip)
    }
    // Every attempt starts from a clean checkout at the target tip; ignored files such as installs stay.
    await git(path, 'reset', '--hard', '-q')
    await git(path, 'checkout', '-q', '--detach', '--force', tip)
    await git(path, 'clean', '-fdq')
    return path
  }
  /** Run one check; returns its output tail on failure. Abort and timeout kill its whole process group. */
  async function check(path: string, command: string, context: Context) {
    await slot.acquire(`lander: ${command}`, context.abortSignal)
    try {
      let output = ''
      const result = await new NodeExecutionEnv({ cwd: path }).exec(
        command,
        {
          timeout: checkTimeout,
          onOutput: (text) => {
            output = (output + text).slice(-3000)
          },
        },
        context,
      )
      context.abortSignal?.throwIfAborted()
      if (!result.ok) return `${output}\n${result.error.message}`.trim()
      return result.value.exitCode === 0
        ? undefined
        : `${output}\nexit ${result.value.exitCode}`.trim()
    } finally {
      slot.release()
    }
  }

  const Lander = defineTask<{ source: string }, State, null>({
    name: 'workspaces.lander',
    version: 1,
    initial: () => ({ phase: 'next' }),
    phases: {
      next: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
          const entry = index.queue.find((item) => item.source === task.input.source)
          if (!entry) {
            delete index.landers[task.input.source]
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }
          entry.state = 'landing'
          return { status: 'running', checkpoint: { phase: 'land', id: entry.id, attempt: 1 } }
        }, context),
      land: async (task, runtime, context) => {
        const { id, attempt } = task.state.checkpoint
        const { signal } = runtime
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const entry = index.queue.find((item) => item.id === id)!
        const step = (text: string) =>
          runtime.commit(async (tx) => {
            const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.find(
              (item) => item.id === id,
            )
            if (saved) saved.step = text
          }, context)
        const finish = (text: string, landed?: string) =>
          runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            draft.queue = draft.queue.filter((item) => item.id !== id)
            if (landed) draft.items[String(entry.conversationId)].landed = landed
            return {
              status: 'running',
              checkpoint: {
                phase: 'report',
                id,
                conversationId: entry.conversationId,
                text: `[lander] Submission ${id} (W${entry.conversationId}, ${entry.tip.slice(0, 7)}) ${text}`,
              },
            }
          }, context)
        const retry = (pushRetried = task.state.checkpoint.pushRetried) =>
          runtime.commit(
            () => ({
              status: 'running',
              checkpoint: {
                phase: 'land',
                id,
                attempt: attempt + 1,
                ...(pushRetried ? { pushRetried } : {}),
              },
            }),
            context,
          )
        const { source, target } = entry
        const checkContext = withAbortSignal(signal, context)
        try {
          const settings = await landerSettings(host)
          // A crash after the checks keeps the integrated commit: go straight to fast-forwarding it.
          let prepared = await runtime.memo<Prepared>(`prepared:${id}:${attempt}`, context)
          if (!prepared) {
            await step('preparing')
            const base = await git(source, 'rev-parse', `refs/heads/${target}`)
            const path = await checkout(source, base)
            if (settings.push) {
              const { stdout } = await remote(
                path,
                signal,
                'ls-remote',
                settings.push,
                `refs/heads/${target}`,
              )
              if (stdout.trim()) {
                await remote(path, signal, 'fetch', '-q', settings.push, target)
                const fetched = await git(path, 'rev-parse', 'FETCH_HEAD')
                if (!(await contains(path, fetched, 'HEAD'))) {
                  await step(`merging ${settings.push}/${target}`)
                  try {
                    await git(
                      path,
                      'merge',
                      '--no-edit',
                      '-m',
                      `Merge ${settings.push}/${target}`,
                      fetched,
                    )
                  } catch {
                    const conflicts = await git(path, 'diff', '--name-only', '--diff-filter=U')
                    await git(path, 'merge', '--abort').catch(() => undefined)
                    return finish(
                      `was not landed: ${settings.push}/${target} conflicts with local ${target} in:\n${conflicts}`,
                    )
                  }
                }
              }
            }
            await step('merging')
            try {
              await git(
                path,
                'merge',
                '--no-edit',
                '-m',
                `Merge ${entry.tip.slice(0, 7)} from W${entry.conversationId} into ${target}`,
                entry.tip,
              )
            } catch {
              const conflicts = await git(path, 'diff', '--name-only', '--diff-filter=U')
              await git(path, 'merge', '--abort').catch(() => undefined)
              return finish(
                `was not landed: it conflicts with ${target} in:\n${conflicts}\nMerge ${target} into your workspace, resolve, verify and submit again.`,
              )
            }
            // Setup prepares the merged revision, for example installs its lockfile.
            await step('setting up')
            await setup(source, path, await host.projectSettings(), signal)
            const flaky: string[] = []
            for (const command of settings.checks) {
              await step(`checking: ${command}`)
              if ((await check(path, command, checkContext)) === undefined) continue
              const output = await check(path, command, checkContext)
              if (output !== undefined)
                return finish(
                  `was not landed: check failed twice: ${command}\n${output}\nFix it, verify and submit again.`,
                )
              flaky.push(command)
            }
            const integrated = await git(path, 'rev-parse', 'HEAD')
            prepared = await runtime.memo<Prepared>(
              `prepared:${id}:${attempt}`,
              {
                base,
                integrated,
                commits: lines(await git(path, 'log', '--oneline', `${base}..${integrated}`)),
                paths: lines(await git(path, 'diff', '--name-only', base, integrated)),
                flaky,
              },
              context,
            )
          }
          const { base, integrated, flaky } = prepared
          await step('fast-forwarding')
          let refused: string | undefined
          const moved = await serial(source, async () => {
            const current = await git(source, 'rev-parse', `refs/heads/${target}`)
            if (current !== base) return !(await contains(source, integrated, current))
            try {
              if (
                (await git(source, 'symbolic-ref', '-q', '--short', 'HEAD').catch(() => '')) ===
                target
              )
                await git(source, 'merge', '-q', '--ff-only', integrated)
              else await git(source, 'update-ref', `refs/heads/${target}`, integrated, base)
            } catch (error) {
              refused = failure(error)
            }
            return false
          })
          if (refused)
            return finish(
              `was integrated as ${integrated.slice(0, 7)} but ${target} in ${source} refused the fast-forward:\n${refused}`,
            )
          if (moved) {
            if (attempt < attempts) return retry()
            return finish(`was not landed: ${target} kept moving during ${attempts} attempts.`)
          }
          // The first fast-forward decides what landed; a push retry integrates again from there.
          const { commits, paths } = await runtime.memo(
            `landed:${id}`,
            { commits: prepared.commits, paths: prepared.paths },
            context,
          )
          let pushed = 'Not pushed.'
          if (settings.push) {
            await step(`pushing to ${settings.push}`)
            try {
              await remote(source, signal, 'push', '-q', settings.push, target)
              pushed = `Pushed to ${settings.push}/${target}.`
            } catch (error) {
              if (signal.aborted) throw error
              if (!task.state.checkpoint.pushRetried) return retry(true)
              pushed = `Push to ${settings.push} was rejected:\n${failure(error)}`
            }
          }
          const needsRestart =
            (await realpath(source)) === (await realpath(host.ultimateRoot)) &&
            paths.some((path) => /^(server|shared)\//.test(path))
          return finish(
            [
              commits.length
                ? `landed as ${integrated.slice(0, 7)} on ${target}.`
                : `had nothing new to land on ${target}.`,
              ...(commits.length ? [`Commits:\n${commits.join('\n')}`] : []),
              ...(paths.length ? [`Changed paths:\n${paths.join('\n')}`] : []),
              ...flaky.map((command) => `Flaky: ${command}`),
              pushed,
              ...(needsRestart ? ['Needs restart.'] : []),
            ].join('\n'),
            integrated,
          )
        } catch (error) {
          if (signal.aborted) throw error
          return finish(`was not landed: ${failure(error)}`)
        }
      },
      report: async (task, runtime, context) => {
        const { id, conversationId, text } = task.state.checkpoint
        await (
          await runtime.conversation(conversationId as ConversationId, context)
        )?.submit(
          { type: 'input', content: text, whenBusy: 'followUp', requestId: `lander:${id}` },
          context,
        )
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'next' } }), context)
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
        if (index.landers[task.input.source] === task.id) delete index.landers[task.input.source]
        for (const item of index.queue)
          if (item.source === task.input.source) {
            item.state = 'queued'
            delete item.step
          }
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  return Lander
}
