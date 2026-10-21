import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { withCancel } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  defineExtension,
  defineTool,
  InboxDoc,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  wrapTool,
} from '@earendil-works/pi-durable'
import {
  type BashExecution,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools'
import { git } from '../../lib/git.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Committed } from './refs.ts'

function defaultBashTimeout() {
  const seconds = Number(process.env.ULTIMATE_BASH_TIMEOUT ?? 600)
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('ULTIMATE_BASH_TIMEOUT must be a positive finite number of seconds')
  return seconds
}

const bashTripwireMessage = (seconds: number) =>
  `Tripwire: bash ran past the ${seconds} s default limit and was stopped. Pass timeout for longer commands.`

/**
 * Process-local Git hooks for one bash call. Each appends tab-separated lines (kind, sha, branch, worktree, git common
 * dir, extra) to `$ULTIMATE_COMMIT_LOG` and swallows every failure, so it can never fail a commit; the trailing `#`
 * drops the arguments Git appends.
 */
const where = `"$(git symbolic-ref -q --short HEAD)" "$(git rev-parse --show-toplevel)" "$(git rev-parse --path-format=absolute --git-common-dir)"`
const logCommit = `printf 'commit\\t%s\\t%s\\t%s\\t%s\\n' "$(git rev-parse HEAD)" ${where} 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`
const hooks = (conversation: number) => ({
  'prepare-commit-msg': `git interpret-trailers --in-place --if-exists replace --trailer "Ultimate-Conversation: ${conversation}" "$1" #`,
  'post-commit': logCommit,
  // `git am` and the apply backend of rebase make commits without post-commit.
  'post-applypatch': logCommit,
  // Merges run no post-commit. Fast-forwards and squashes run post-merge too, so it also logs the HEAD before the
  // merge and the reflog's subject (`… Fast-forward` for one).
  'post-merge': `printf 'merge\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(git rev-parse HEAD)" ${where} "$(git rev-parse -q --verify ORIG_HEAD)" "$(git reflog -1 --format=%gs)" 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
  // Git's stdin holds `old new` pairs of amended or rebased commits.
  'post-rewrite': `while read -r old new rest; do printf 'rewrite\\t%s\\t\\t\\t%s\\t%s\\n' "$new" "$(git rev-parse --path-format=absolute --git-common-dir)" "$old"; done 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
})

/** Install the hooks for bash call `api` in `execution`; they log its commits to `log` when given. */
export function prepareBash(
  execution: BashExecution,
  api: Pick<ToolExecutionApi, 'conversationId'>,
  log?: string,
) {
  let count = Number(process.env.GIT_CONFIG_COUNT ?? 0)
  for (const [event, command] of Object.entries(hooks(api.conversationId))) {
    execution.env[`GIT_CONFIG_KEY_${count}`] = `hook.ultimate-${event}.event`
    execution.env[`GIT_CONFIG_VALUE_${count++}`] = event
    execution.env[`GIT_CONFIG_KEY_${count}`] = `hook.ultimate-${event}.command`
    execution.env[`GIT_CONFIG_VALUE_${count++}`] = command
  }
  execution.env.GIT_CONFIG_COUNT = String(count)
  if (log) execution.env.ULTIMATE_COMMIT_LOG = log
}

/** Why a command marked `interruptible` must not be cut mid-way, if it changes something; `undefined` when it only waits. */
export function changes(command: string) {
  return (
    /\bgit\b[^;&|\n]*?\b(push|commit|merge)\b/.exec(command)?.[0] ??
    /\b(install|migrate)\b/.exec(command)?.[0]
  )
}

/**
 * Run `run` until it finishes or a steer is queued in this call's conversation, whichever comes first. A steer joins a
 * run only after the tool round, so a wait would otherwise hold it; ending the command here lets the run go on and the
 * steer be placed at once. Follow-ups wait for the run's end anyway, so they never interrupt.
 */
async function untilSteered(
  run: (context: Context) => Promise<ToolExecutionResult>,
  api: ToolExecutionApi,
  context: Context,
): Promise<ToolExecutionResult> {
  const inbox = await api.watchDoc(InboxDoc, api.conversationId, context)
  if (!inbox) return run(context)
  const started = performance.now()
  const { context: command, cancel } = withCancel(context)
  let steered = false
  const inspect = (value: typeof inbox.value) => {
    if (steered || !value?.items.some((item) => item.mode === 'steer')) return
    steered = true
    cancel(new Error('Interrupted by a steering message'))
  }
  inbox.start(async (value) => inspect(value))
  try {
    inspect(inbox.value)
    return await run(command)
  } catch (error) {
    if (!steered || context.abortSignal?.aborted) throw error
    const retained = api.retainedOutput()
    const seconds = Math.round((performance.now() - started) / 1000)
    return {
      output: [
        {
          type: 'text',
          text: `Interrupted by a steering message after ${seconds}s. Last output:\n${retained.text || '(none)'}`,
        },
      ],
      structuredOutput: { output: retained.text, truncated: retained.truncated, exitCode: 130 },
    }
  } finally {
    await inbox.stop()
  }
}

type Made = {
  sha: string
  branch?: string
  toplevel: string
  common: string
  rewrittenFrom?: string
}

/**
 * The commits a bash call made, from its hook log at `path`, which this removes. Only a commit line, or a post-merge
 * line for a real merge commit (first parent the HEAD before it, not a fast-forward), records a commit; a rewrite line
 * only adds `rewrittenFrom` to one, since a resumed rebase also lists commits an earlier call made.
 */
async function madeCommits(path: string, conversation: number) {
  const log = await readFile(path, 'utf8').catch(() => '')
  await rm(path, { force: true })
  const made = new Map<string, Made>()
  const merges = new Map<string, string>()
  const rewrites: string[][] = []
  for (const line of log.split('\n')) {
    const [kind, sha, branch, toplevel, common, extra, reflog] = line.split('\t')
    if (!sha || !common) continue
    if (kind === 'rewrite') rewrites.push([sha, extra])
    else if (kind === 'merge' && reflog?.endsWith(': Fast-forward')) continue
    else if ((kind === 'commit' || kind === 'merge') && !made.has(sha)) {
      made.set(sha, { sha, ...(branch ? { branch } : {}), toplevel, common })
      if (kind === 'merge') merges.set(sha, extra ?? '')
    }
  }
  for (const [sha, old] of rewrites) {
    const commit = made.get(sha)
    if (commit && old) commit.rewrittenFrom = old
  }
  const byRepo = Map.groupBy(made.values(), (commit) => commit.common)
  const events = []
  for (const [common, commits] of byRepo) {
    // The commits stay readable from the repository after their worktree is gone.
    const shown = await git(
      common,
      'log',
      '--no-walk=unsorted',
      '--format=%H%x00%P%x00%s%x1e',
      ...commits.map((commit) => commit.sha),
    ).catch(() => '')
    const details = new Map(
      shown
        .split('\x1e')
        .map((record) => record.trim().split('\0'))
        .map(([sha, parents, subject]) => [sha, { parents, subject }]),
    )
    for (const commit of commits) {
      const found = details.get(commit.sha)
      if (!found) continue
      const parents = found.parents ? found.parents.split(' ') : []
      // A squash leaves HEAD where it was, which is no merge commit on the HEAD before it.
      const before = merges.get(commit.sha)
      if (before !== undefined && !(parents.length > 1 && parents[0] === before)) continue
      const repo = basename(common) === '.git' ? dirname(common) : common
      events.push({
        conversation,
        sha: commit.sha,
        parents,
        repo,
        ...(commit.toplevel && commit.toplevel !== repo ? { worktree: commit.toplevel } : {}),
        ...(commit.branch ? { branch: commit.branch } : {}),
        subject: found.subject,
        ...(commit.rewrittenFrom ? { rewrittenFrom: commit.rewrittenFrom } : {}),
      })
    }
  }
  return events
}

export default function codingTools(host: Pick<ExtensionHost, 'emit'>) {
  const shell = createBashTool()
  const parameters = Type.Object({
    ...shell.parameters.properties,
    interruptible: Type.Optional(
      Type.Boolean({
        description:
          'Only for commands that just wait or poll (CI checks, deploys, a file appearing): a steering message ends the command early. Never combine with commands that change things.',
      }),
    ),
  })
  // In the tool itself, not a wrap, so the events carry the call's trace and conversation.
  const bashTool = defineTool({
    ...shell,
    description: `${shell.description} Set interruptible for a command that only waits or polls, so a steering message can end it early.`,
    parameters,
    async execute({ interruptible, ...args }, api, context) {
      const change = interruptible ? changes(args.command) : undefined
      if (change)
        throw new Error(
          `An interruptible command must only wait, but this one changes things (${change}). Run the change in its own bash call, then wait in a separate interruptible one.`,
        )
      // One log per invocation: task ids repeat across projects and a retried call reruns its task.
      const log = join(tmpdir(), `ultimate-commits-${randomUUID()}.log`)
      const call = createBashTool({
        prepare: (execution) => prepareBash(execution, api, log),
      })
      const run = (command: Context) => call.execute(args, api, command)
      try {
        return interruptible ? await untilSteered(run, api, context) : await run(context)
      } finally {
        // A failed or stopped command may still have committed, so record what it made either way.
        const commits = await madeCommits(log, api.conversationId)
        if (commits.length)
          await api
            .commit(async (tx) => {
              for (const commit of commits) await host.emit(tx, Committed, commit)
            }, context)
            .catch((error: unknown) =>
              // Recording is history only; the command's own result must stand.
              console.error('coding-tools: recording commits failed:', error),
            )
      }
    },
  })
  return defineExtension({
    name: 'coding-tools',
    // Each tool keeps its own parameters; the list is only read through the base registration.
    tools: [createReadTool(), createWriteTool(), createEditTool(), bashTool] as ToolRegistration[],
    wraps: [
      wrapTool(createBashTool(), (bash) => ({
        ...bash,
        async execute(args, api, context) {
          if (args.timeout !== undefined) return bash.execute(args, api, context)
          const timeout = defaultBashTimeout()
          try {
            return await bash.execute({ ...args, timeout }, api, context)
          } catch (error) {
            if (
              error instanceof Error &&
              /^Command timed out after [\d.e+-]+ seconds$/.test(error.message)
            )
              throw new Error(bashTripwireMessage(timeout), { cause: error })
            throw error
          }
        },
      })),
    ],
  })
}
