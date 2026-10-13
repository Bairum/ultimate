import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { copyJson } from '@earendil-works/chord'
import type { Context } from '@earendil-works/chord'
import { withAbortSignal } from '@earendil-works/chord/context'
import {
  AssistantEntry,
  configure,
  defineEntry,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type {
  AgentChange,
  ConversationDocToken,
  ConversationId,
  Tx,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { exclusiveSlot } from '../exclusive-commands/slot.ts'
import { definitionAgent, discoverAgents } from '../subagents/agents.ts'
import { git, setup } from './git.ts'
import type {
  Landed,
  LanderAsk,
  LanderEntry,
  LanderOutcome,
  QueueEntry,
  WorkspaceIndex,
} from './types.ts'

const exec = promisify(execFile)
/** One line of the lander conversation's log; it carries no model message, so no model ever sees it. */
export const LanderLog = defineEntry<LanderEntry>('ultimate.lander')
/** The entry kind of the lander task's question to its model; the model reads the prompt. */
export const LanderAskEntry = 'ultimate.lander-ask'
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
/**
 * The lander's checkout of `source`, created detached at `tip` when it is not a registered worktree yet; an existing one
 * stays as it is.
 */
export async function landerCheckout(home: string, source: string, tip = 'HEAD') {
  const path = await landerPath(home, source)
  const registered = (await git(source, 'worktree', 'list', '--porcelain'))
    .split('\n\n')
    .some((entry) => entry.split('\n').includes(`worktree ${path}`))
  if (!registered) {
    // The directory is the lander's own; a crash may have left it half created.
    await rm(path, { recursive: true, force: true })
    await git(source, 'worktree', 'prune')
    await git(source, 'worktree', 'add', '--detach', path, tip)
  }
  return path
}
/**
 * Append a log line about `entry`, a draft of its queue entry, to the lander conversation `id`; a step also joins the
 * entry's `steps`, which the submitter's cards show.
 */
export const log = (
  tx: Tx,
  id: ConversationId,
  entry: QueueEntry,
  data: Omit<LanderEntry, 'submission' | 'conversationId' | 'tip' | 'target' | 'at'>,
) => {
  const at = Date.now()
  if (data.step)
    entry.steps.push({ step: data.step, at, ...(data.check ? { check: data.check } : {}) })
  return tx.appendEntry(LanderLog, id, {
    data: {
      submission: entry.id,
      conversationId: entry.conversationId,
      tip: entry.tip,
      target: entry.target,
      at,
      ...data,
    },
  })
}
type Host = Pick<
  ExtensionHost,
  | 'home'
  | 'ultimateRoot'
  | 'projectRoot'
  | 'userHome'
  | 'modelRuntime'
  | 'harness'
  | 'projectSettings'
  | 'resource'
>
/**
 * The lander conversation's agent from the effective `lander` definition (model, thinking, tools, instructions) over
 * the main conversation's; without a definition only the main conversation's model, and no model work on failures.
 */
export async function landerAgent(
  host: Pick<Host, 'ultimateRoot' | 'projectRoot' | 'userHome' | 'modelRuntime' | 'harness'>,
  context: Context,
): Promise<{ onFailure?: 'fix' | 'diagnose'; change: AgentChange }> {
  const definition = (
    await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
  ).definitions.find((candidate) => candidate.name === 'lander')
  const main = await (await host.harness().conversation(ROOT_CONVERSATION_ID, context))!.agent(
    context,
  )
  if (!definition)
    return { change: { model: main.model ?? null, thinkingLevel: main.thinkingLevel } }
  const delegates = definition.tools?.includes('subagent')
  return {
    onFailure: definition.onFailure ?? 'diagnose',
    change: definitionAgent(definition, main, host.modelRuntime, {
      excludeTools: ['workspace', ...(delegates ? [] : ['subagent'])],
      excludeExtensions: delegates ? [] : ['subagents'],
    }),
  }
}
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

/** A failure the lander's model works on: the checkout stays as it failed, at `head` on top of target `base`. */
type Failure = {
  mode: 'fix' | 'diagnose'
  reason: string
  output?: string
  hint?: string
  base: string
  head: string
  prompt: string
  /** The model's final answer, once its run settled. */
  answer?: string
}
type Prepared = {
  base: string
  integrated: string
  flaky: string[]
}
const landedOutcome = (landed: Landed): LanderOutcome => ({
  outcome: 'landed',
  sha: landed.sha,
  commits: landed.commits,
  paths: landed.paths,
  flaky: landed.flaky,
})
/** Carried across attempts: a rejected push retries once, and a submission gets at most one fix by the model. */
type Carry = { pushRetried?: boolean; fixed?: { commits: string[]; head: string } }
type State =
  | { phase: 'next' }
  | ({ phase: 'land'; id: string; attempt: number; failure?: Failure } & Carry)
  | ({ phase: 'agent'; id: string; attempt: number; failure: Failure } & Carry)
  | { phase: 'report'; id: string; conversationId: number; text: string }
const textOf = (message: unknown) =>
  ((message as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [])
    .flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
    .join('')
    .trim()

export function createLander(
  host: Host,
  Workspaces: ConversationDocToken<WorkspaceIndex>,
  /** Serializes source checkout writes with synchronous landing. */
  serial: <T>(source: string, operation: () => Promise<T>) => Promise<T>,
) {
  const slot = exclusiveSlot(host)
  async function checkout(source: string, tip: string) {
    const path = await landerCheckout(host.home, source, tip)
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
        const { id, attempt, pushRetried, fixed } = task.state.checkpoint
        const carry: Carry = {
          ...(pushRetried ? { pushRetried } : {}),
          ...(fixed ? { fixed } : {}),
        }
        const { signal } = runtime
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const entry = index.queue.find((item) => item.id === id)!
        /** What this submission's fast-forward landed, if it happened yet. */
        const recorded = async () =>
          (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.queue.find(
            (item) => item.id === id,
          )?.landed
        const step = (text: string, result?: LanderEntry['check']) =>
          runtime.commit(async (tx) => {
            const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.find(
              (item) => item.id === id,
            )!
            saved.step = text
            await log(tx, runtime.conversationId, saved, {
              step: text,
              ...(result ? { check: result } : {}),
            })
          }, context)
        /** Record the outcome, log it and report it to the submitter, in one commit. */
        const finish = (text: string, outcome: LanderOutcome) =>
          runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            const steps = draft.queue.find((item) => item.id === id)!.steps
            draft.queue = draft.queue.filter((item) => item.id !== id)
            if (outcome.sha) draft.items[String(entry.conversationId)].landed = outcome.sha
            draft.results[id] = {
              ...outcome,
              target: entry.target,
              tip: entry.tip,
              lander: runtime.conversationId,
              steps,
            }
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
            ...(fixed ? [`Fixed by lander:\n${fixed.commits.join('\n')}`] : []),
            ...landed.flaky.map((command) => `Flaky: ${command}`),
          ].join('\n')
        /**
         * Report `reason`, with `output` (conflicting paths, a check's output tail) and what to do next.
         * Once the submission landed locally, a later failure only means its push failed.
         */
        const fail = async (reason: string, output?: string, hint?: string, diagnosis?: string) => {
          const landed = await recorded()
          const detail = [
            output ? `${reason}:\n${output}` : reason,
            ...(hint ? [hint] : []),
            ...(diagnosis ? [`Diagnosis by lander:\n${diagnosis}`] : []),
          ].join('\n')
          const facts = {
            reason: landed ? `Push failed: ${reason}` : reason,
            ...(output ? { output } : {}),
            ...(hint ? { hint } : {}),
            ...(diagnosis ? { diagnosis } : {}),
          }
          return landed
            ? finish(`${summary(landed, landed.sha, ' locally')}\nPush failed: ${detail}`, {
                ...landedOutcome(landed),
                ...facts,
              })
            : finish(`was not landed: ${detail}`, { outcome: 'failed', ...facts })
        }
        const retry = (retried = pushRetried) =>
          runtime.commit(
            () => ({
              status: 'running',
              checkpoint: {
                phase: 'land',
                id,
                attempt: attempt + 1,
                ...carry,
                ...(retried ? { pushRetried: retried } : {}),
              },
            }),
            context,
          )
        const integration = await landerPath(host.home, entry.source)
        /** Reset the lander's checkout after a failure the model looked at. */
        const reset = async () => {
          await git(integration, 'merge', '--abort').catch(() => undefined)
          await git(integration, 'reset', '--hard', '-q')
          await git(integration, 'clean', '-fdq')
        }
        /**
         * A conflict or a check that failed twice: the lander's model diagnoses or fixes it while the checkout stays as it
         * failed, once per submission; otherwise, or without a lander definition, report it.
         */
        const handOver = async (
          reason: string,
          output: string,
          hint: string,
          failing: { base: string; conflict: boolean },
        ) => {
          const { onFailure, change } = fixed
            ? { onFailure: undefined, change: undefined }
            : await landerAgent(host, context)
          if (!onFailure || !change) {
            await git(integration, 'merge', '--abort').catch(() => undefined)
            return fail(
              reason,
              output,
              fixed
                ? `The lander's fix (${fixed.commits.length} commit${fixed.commits.length === 1 ? '' : 's'}) did not land it either. ${hint}`
                : hint,
            )
          }
          const head = await git(integration, 'rev-parse', 'HEAD')
          const state = failing.conflict
            ? `Merging ${entry.tip} (W${entry.conversationId}) into ${target} at ${head} stopped with conflicts; the merge is in progress.`
            : `HEAD ${head} is the merge of ${entry.tip} (W${entry.conversationId}) into ${target}, set up as the checks run it.`
          const prompt = [
            `[lander] Submission ${id} failed: ${reason}`,
            output,
            '',
            `Your checkout ${integration} is left as it failed. ${state}`,
            onFailure === 'fix'
              ? 'Mode: fix. Resolve or fix it here with the smallest change and commit it (Conventional Commits). Leave the checkout clean. Never push or touch other checkouts. Every check then runs again before it lands. If it cannot be fixed safely, change nothing and explain why.'
              : `Mode: diagnose. Explain the cause and the smallest fix for the submitter. Change nothing.`,
          ].join('\n')
          return runtime.commit(async (tx) => {
            const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.find(
              (item) => item.id === id,
            )!
            saved.agent = onFailure
            saved.step = onFailure === 'fix' ? 'fixing' : 'diagnosing'
            await log(tx, runtime.conversationId, saved, { step: saved.step })
            // The definition as it is now: an edit applies to the next failure.
            await configure(tx, runtime.conversationId, change)
            return {
              status: 'running',
              checkpoint: {
                phase: 'agent',
                id,
                attempt,
                ...carry,
                failure: {
                  mode: onFailure,
                  reason,
                  ...(output ? { output } : {}),
                  ...(hint ? { hint } : {}),
                  base: failing.base,
                  head,
                  prompt,
                },
              },
            }
          }, context)
        }
        /** The model's run on a failure settled: report its diagnosis, or check its fix and run every check again. */
        const answered = async (handed: Failure) => {
          if (handed.mode === 'diagnose') {
            await reset()
            return fail(handed.reason, handed.output, handed.hint, handed.answer)
          }
          const head = await git(integration, 'rev-parse', 'HEAD')
          const problem = (await git(integration, 'status', '--porcelain'))
            ? 'left uncommitted changes'
            : (await git(integration, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').then(
                  () => true,
                  () => false,
                ))
              ? 'left the merge unfinished'
              : head === handed.head
                ? 'added no commits'
                : !(await contains(integration, handed.head, head)) ||
                    !(await contains(integration, entry.tip, head))
                  ? 'did not build on the failed merge'
                  : undefined
          if (problem) {
            await reset()
            return fail(
              handed.reason,
              handed.output,
              `The lander's fix ${problem}. ${handed.hint ?? ''}`.trim(),
              handed.answer,
            )
          }
          const commits = lines(
            // A resolved conflict is one merge commit; its second parent's commits are the submission's own.
            await git(integration, 'log', '--oneline', '--first-parent', `${handed.head}..${head}`),
          )
          // The next attempt starts from the fixed commit and runs every check on it.
          await runtime.memo(
            `merged:${id}:${attempt + 1}`,
            { base: handed.base, sha: head },
            context,
          )
          return runtime.commit(
            () => ({
              status: 'running',
              checkpoint: {
                phase: 'land',
                id,
                attempt: attempt + 1,
                ...(pushRetried ? { pushRetried } : {}),
                fixed: { commits, head },
              },
            }),
            context,
          )
        }
        const { source, target } = entry
        const checkContext = withAbortSignal(signal, context)
        /** Push `sha` when configured; on a rejection retry the integration once, then report it. */
        const push = async (settings: Settings, sha: string) => {
          if (!settings.push) return { text: 'Not pushed.' }
          await step(`pushing to ${settings.push}`)
          try {
            // Push the checked commit, not whatever the branch points to by now.
            await remote(source, signal, 'push', '-q', settings.push, `${sha}:refs/heads/${target}`)
            return {
              remote: `${settings.push}/${target}`,
              text: `Pushed to ${settings.push}/${target}.`,
            }
          } catch (error) {
            if (signal.aborted) throw error
            if (!pushRetried) return { retry: retry(true) }
            return { retry: fail(`${settings.push} rejected the push`, failure(error)) }
          }
        }
        /** Push what landed and report it: commits, flaky checks, push, restart hint. */
        const landedReport = async (settings: Settings, landed: Landed, sha: string) => {
          const pushed = await push(settings, sha)
          if (pushed.retry) return pushed.retry
          const needsRestart =
            (await realpath(source)) === (await realpath(host.ultimateRoot)) &&
            landed.paths.some((path) => /^(server|shared)\//.test(path))
          return finish(
            [summary(landed, sha), pushed.text, ...(needsRestart ? ['Needs restart.'] : [])].join(
              '\n',
            ),
            {
              ...landedOutcome(landed),
              ...(pushed.remote ? { pushed: pushed.remote } : {}),
              ...(needsRestart ? { needsRestart } : {}),
              ...(fixed ? { fixed: fixed.commits } : {}),
            },
          )
        }
        try {
          const settings = await landerSettings(host)
          if (task.state.checkpoint.failure) return await answered(task.state.checkpoint.failure)
          // An earlier lander task fast-forwarded this submission and then ended (a reload or fault before its push):
          // nothing to merge or check again, push exactly what landed and report that landing.
          if (
            entry.landed &&
            attempt === 1 &&
            !pushRetried &&
            (await contains(source, entry.landed.sha, `refs/heads/${target}`))
          )
            return await landedReport(settings, entry.landed, entry.landed.sha)
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
                  // After a fix, a retry onto a moved target brings the fixed merge along.
                  fixed?.head ?? entry.tip,
                )
              } catch {
                return handOver(
                  `it conflicts with ${target} in`,
                  await git(path, 'diff', '--name-only', '--diff-filter=U'),
                  `Merge ${target} into your workspace, resolve, verify and submit again.`,
                  { base, conflict: true },
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
                  return handOver(
                    `check failed twice: ${command}`,
                    output,
                    'Fix it, verify and submit again.',
                    { base, conflict: false },
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
          // The first fast-forward decides what the submission landed, durably on its queue entry with the target's
          // new tip, so any later lander task reports that landing; a push retry integrates again from there.
          const candidate: Landed = {
            sha: integrated,
            base,
            commits: lines(await git(source, 'log', '--oneline', `${base}..${integrated}`)),
            paths: lines(await git(source, 'diff', '--name-only', base, integrated)),
            flaky,
          }
          let landed = candidate
          await runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            const saved = draft.queue.find((item) => item.id === id)!
            saved.landed ??= candidate
            // A copy: the draft is gone once the commit settles.
            landed = copyJson(saved.landed) as Landed
            draft.items[String(entry.conversationId)].landed = integrated
          }, context)
          return await landedReport(settings, landed, integrated)
        } catch (error) {
          if (signal.aborted) throw error
          return fail('it failed', failure(error))
        }
      },
      agent: async (task, runtime, context) => {
        const { id, failure: handed } = task.state.checkpoint
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const entry = index.queue.find((item) => item.id === id)!
        const ask: LanderAsk = {
          submission: id,
          conversationId: entry.conversationId,
          tip: entry.tip,
          target: entry.target,
          at: Date.now(),
          mode: handed.mode,
          reason: handed.reason,
        }
        const conversation = (await runtime.conversation(runtime.conversationId, context))!
        // One request per submission and attempt: a resume waits for the same run.
        const settled = await (
          await conversation.submit(
            {
              type: 'input',
              content: handed.prompt,
              entry: { kind: LanderAskEntry, data: ask },
              whenBusy: 'followUp',
              requestId: `lander-agent:${id}:${task.state.checkpoint.attempt}`,
            },
            context,
          )
        ).wait(context)
        const answer =
          settled.status === 'done' && settled.type === 'input'
            ? textOf((await runtime.entry(AssistantEntry, settled.answer, context))?.model?.[0])
            : `The lander's model did not answer (${settled.status === 'unanswered' ? settled.reason : settled.status}).`
        await runtime.commit(async (tx) => {
          const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.find(
            (item) => item.id === id,
          )!
          delete saved.agent
          return {
            status: 'running',
            checkpoint: {
              ...task.state.checkpoint,
              phase: 'land',
              failure: { ...handed, answer },
            },
          }
        }, context)
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
            delete item.agent
          }
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  return Lander
}
