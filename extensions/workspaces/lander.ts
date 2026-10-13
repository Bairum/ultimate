import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@earendil-works/chord'
import { withAbortSignal } from '@earendil-works/chord/context'
import { defineEntry, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { ConversationDocToken, ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { exclusiveSlot } from '../exclusive-commands/slot.ts'
import { git, setup } from './git.ts'
import type { LanderEntry, LanderOutcome, QueueEntry, WorkspaceIndex } from './types.ts'

const exec = promisify(execFile)
/** One line of the lander conversation's log; it carries no model message, so no model ever sees it. */
export const LanderLog = defineEntry<LanderEntry>('ultimate.lander')
/** Outcomes kept in the index for submit cards; older ones live on in the lander conversation. */
const kept = 50
/** The lander's own detached checkout of `source`, also its conversation's cwd. */
export async function landerPath(home: string, source: string) {
  await mkdir(join(home, 'lander'), { recursive: true })
  return join(
    await realpath(join(home, 'lander')),
    createHash('sha256').update(source).digest('hex').slice(0, 12),
  )
}
/** Append a log line about `entry` to the lander conversation `id`. */
export const log = (
  tx: Tx,
  id: ConversationId,
  entry: QueueEntry,
  data: Omit<LanderEntry, 'submission' | 'conversationId' | 'tip' | 'target' | 'at'>,
) =>
  tx.appendEntry(LanderLog, id, {
    data: {
      submission: entry.id,
      conversationId: entry.conversationId,
      tip: entry.tip,
      target: entry.target,
      at: Date.now(),
      ...data,
    },
  })
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
  flaky: string[]
}
/** What a submission's first fast-forward landed locally. */
type Landed = { sha: string; commits: string[]; paths: string[]; flaky: string[] }
const landedOutcome = (landed: Landed): LanderOutcome => ({
  outcome: 'landed',
  sha: landed.sha,
  commits: landed.commits,
  paths: landed.paths,
  flaky: landed.flaky,
})
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
    const path = await landerPath(host.home, source)
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
          await log(tx, runtime.conversationId, entry, { step: 'started' })
          return { status: 'running', checkpoint: { phase: 'land', id: entry.id, attempt: 1 } }
        }, context),
      land: async (task, runtime, context) => {
        const { id, attempt } = task.state.checkpoint
        const { signal } = runtime
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const entry = index.queue.find((item) => item.id === id)!
        const step = (text: string, result?: LanderEntry['check']) =>
          runtime.commit(async (tx) => {
            const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.find(
              (item) => item.id === id,
            )
            if (saved) saved.step = text
            await log(tx, runtime.conversationId, entry, {
              step: text,
              ...(result ? { check: result } : {}),
            })
          }, context)
        /** Record the outcome, log it and report it to the submitter, in one commit. */
        const finish = (text: string, outcome: LanderOutcome) =>
          runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            draft.queue = draft.queue.filter((item) => item.id !== id)
            if (outcome.sha) draft.items[String(entry.conversationId)].landed = outcome.sha
            draft.results[id] = { ...outcome, target: entry.target, lander: runtime.conversationId }
            for (const old of Object.keys(draft.results).slice(0, -kept)) delete draft.results[old]
            await log(tx, runtime.conversationId, entry, outcome)
            return {
              status: 'running',
              checkpoint: {
                phase: 'report',
                id,
                conversationId: entry.conversationId,
                text: `[lander] Submission ${id} (W${entry.conversationId}, ${entry.tip.slice(0, 7)}) ${text}\nLog: lander conversation #${runtime.conversationId}.`,
              },
            }
          }, context)
        const summary = (landed: Landed, sha: string, how = '') =>
          [
            landed.commits.length
              ? `landed${how} as ${sha.slice(0, 7)} on ${entry.target}.`
              : `had nothing new to land on ${entry.target}.`,
            ...(landed.commits.length ? [`Commits:\n${landed.commits.join('\n')}`] : []),
            ...landed.flaky.map((command) => `Flaky: ${command}`),
          ].join('\n')
        /**
         * Report `reason`, with `output` (conflicting paths, a check's output tail) and what to do next.
         * Once the submission landed locally, a later failure only means its push failed.
         */
        const fail = async (reason: string, output?: string, hint?: string) => {
          const landed = await runtime.memo<Landed>(`landed:${id}`, context)
          const detail = [output ? `${reason}:\n${output}` : reason, ...(hint ? [hint] : [])].join(
            '\n',
          )
          const facts = {
            reason: landed ? `Push failed: ${reason}` : reason,
            ...(output ? { output } : {}),
            ...(hint ? { hint } : {}),
          }
          return landed
            ? finish(`${summary(landed, landed.sha, ' locally')}\nPush failed: ${detail}`, {
                ...landedOutcome(landed),
                ...facts,
              })
            : finish(`was not landed: ${detail}`, { outcome: 'failed', ...facts })
        }
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
            // A crash after the merges resumes on the same merged commit instead of merging again.
            let merged = await runtime.memo<{ base: string; sha: string }>(
              `merged:${id}:${attempt}`,
              context,
            )
            const path = await checkout(
              source,
              merged?.sha ?? (await git(source, 'rev-parse', `refs/heads/${target}`)),
            )
            if (!merged) {
              await step('preparing')
              const base = await git(path, 'rev-parse', 'HEAD')
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
                      return fail(
                        `${settings.push}/${target} conflicts with local ${target} in`,
                        conflicts,
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
                return fail(
                  `it conflicts with ${target} in`,
                  conflicts,
                  `Merge ${target} into your workspace, resolve, verify and submit again.`,
                )
              }
              merged = await runtime.memo(
                `merged:${id}:${attempt}`,
                { base, sha: await git(path, 'rev-parse', 'HEAD') },
                context,
              )
            }
            const { base } = merged
            // Setup prepares the merged revision, for example installs its lockfile.
            await step('setting up')
            await setup(source, path, await host.projectSettings(), signal)
            const flaky: string[] = []
            for (const [position, command] of settings.checks.entries()) {
              // Outcomes are durable (memos are first-writer-wins, so the rerun has its own key): a resume
              // neither reruns a passed check nor grants another rerun, and keeps the flaky note.
              const key = `check:${id}:${attempt}:${position}`
              let first = await runtime.memo<'passed' | 'failed'>(key, context)
              if (!first) {
                await step(`checking: ${command}`)
                const failed = (await check(path, command, checkContext)) !== undefined
                // Logged before the memo: a crash in between reruns the check and logs it again, as it ran.
                await step(`checked: ${command}`, { command, result: failed ? 'failed' : 'passed' })
                first = await runtime.memo(key, failed ? 'failed' : 'passed', context)
              }
              if (first === 'passed') continue
              if (!(await runtime.memo<'passed'>(`${key}:rerun`, context))) {
                await step(`rerunning: ${command}`)
                const output = await check(path, command, checkContext)
                if (output !== undefined)
                  return fail(
                    `check failed twice: ${command}`,
                    output,
                    'Fix it, verify and submit again.',
                  )
                await step(`checked: ${command}`, { command, result: 'flaky' })
                await runtime.memo(`${key}:rerun`, 'passed', context)
              }
              flaky.push(command)
            }
            const integrated = await git(path, 'rev-parse', 'HEAD')
            prepared = await runtime.memo<Prepared>(
              `prepared:${id}:${attempt}`,
              {
                base,
                integrated,
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
            // A replay after the fast-forward finds exactly the integrated commit; anything else moved.
            if (current === integrated) return false
            if (current !== base) return true
            try {
              // Fast-forward the checkout that has the target checked out, so its files follow the branch.
              const worktree = (await git(source, 'worktree', 'list', '--porcelain'))
                .split('\n\n')
                .map((record) => record.split('\n'))
                .find((record) => record.includes(`branch refs/heads/${target}`))?.[0]
                .slice('worktree '.length)
              if (worktree) await git(worktree, 'merge', '-q', '--ff-only', integrated)
              else await git(source, 'update-ref', `refs/heads/${target}`, integrated, base)
            } catch (error) {
              refused = failure(error)
            }
            return false
          })
          if (refused)
            return fail(
              `the checkout of ${target} refused the fast-forward to ${integrated.slice(0, 7)}`,
              refused,
            )
          if (moved) {
            if (attempt < attempts) return retry()
            return fail(`${target} kept moving during ${attempts} attempts.`)
          }
          // The first fast-forward decides what the submission landed; a push retry integrates again from there.
          const landed = await runtime.memo<Landed>(
            `landed:${id}`,
            {
              sha: integrated,
              commits: lines(await git(source, 'log', '--oneline', `${base}..${integrated}`)),
              paths: lines(await git(source, 'diff', '--name-only', base, integrated)),
              flaky,
            },
            context,
          )
          await runtime.commit(async (tx) => {
            ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[
              String(entry.conversationId)
            ].landed = integrated
          }, context)
          let pushed = 'Not pushed.'
          let remoteBranch: string | undefined
          if (settings.push) {
            await step(`pushing to ${settings.push}`)
            try {
              // Push the checked commit, not whatever the branch points to by now.
              await remote(
                source,
                signal,
                'push',
                '-q',
                settings.push,
                `${integrated}:refs/heads/${target}`,
              )
              remoteBranch = `${settings.push}/${target}`
              pushed = `Pushed to ${remoteBranch}.`
            } catch (error) {
              if (signal.aborted) throw error
              if (!task.state.checkpoint.pushRetried) return retry(true)
              return fail(`${settings.push} rejected the push`, failure(error))
            }
          }
          const needsRestart =
            (await realpath(source)) === (await realpath(host.ultimateRoot)) &&
            landed.paths.some((path) => /^(server|shared)\//.test(path))
          return finish(
            [summary(landed, integrated), pushed, ...(needsRestart ? ['Needs restart.'] : [])].join(
              '\n',
            ),
            {
              ...landedOutcome(landed),
              ...(remoteBranch ? { pushed: remoteBranch } : {}),
              ...(needsRestart ? { needsRestart } : {}),
            },
          )
        } catch (error) {
          if (signal.aborted) throw error
          return fail('it failed', failure(error))
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
