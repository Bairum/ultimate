import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { defineExtension, type ToolExecutionApi, wrapTool } from '@earendil-works/pi-durable'
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
const hooks = (conversation: number) => ({
  'prepare-commit-msg': `git interpret-trailers --in-place --if-exists replace --trailer "Ultimate-Conversation: ${conversation}" "$1" #`,
  'post-commit': `printf 'commit\\t%s\\t%s\\t%s\\t%s\\n' "$(git rev-parse HEAD)" ${where} 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
  // Merges run no post-commit. Fast-forwards and squashes run post-merge too, so it also logs the HEAD before the merge.
  'post-merge': `printf 'merge\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(git rev-parse HEAD)" ${where} "$(git rev-parse -q --verify ORIG_HEAD)" 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
  // Git's stdin holds `old new` pairs; an apply-backend rebase runs no post-commit, so each pair is a commit too.
  'post-rewrite': `while read -r old new rest; do printf 'rewrite\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$new" ${where} "$old"; done 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
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

type Made = {
  sha: string
  branch?: string
  toplevel: string
  common: string
  /** Logged by post-merge: the HEAD before it, to tell a real merge from a fast-forward or squash. */
  merged?: string
  rewrittenFrom?: string
}

/**
 * The commits a bash call that started at `started` (ms) made, from its hook log at `path`, which this removes. A
 * commit or rewrite line confirms a commit; a post-merge line only proposes one.
 */
async function madeCommits(path: string, conversation: number, started: number) {
  const log = await readFile(path, 'utf8').catch(() => '')
  await rm(path, { force: true })
  const made = new Map<string, Made>()
  for (const line of log.split('\n')) {
    const [kind, sha, branch, toplevel, common, extra] = line.split('\t')
    if (!sha || !common || !['commit', 'merge', 'rewrite'].includes(kind)) continue
    const known = made.get(sha)
    if (kind === 'merge' && known) continue
    made.set(sha, {
      sha,
      ...(branch ? { branch } : {}),
      toplevel,
      common,
      ...(kind === 'merge' ? { merged: extra ?? '' } : {}),
      ...(kind === 'rewrite' && extra ? { rewrittenFrom: extra } : {}),
      ...(kind !== 'rewrite' && known?.rewrittenFrom ? { rewrittenFrom: known.rewrittenFrom } : {}),
    })
  }
  const byRepo = Map.groupBy(made.values(), (commit) => commit.common)
  const events = []
  for (const [common, commits] of byRepo) {
    // The commits stay readable from the repository after their worktree is gone.
    const shown = await git(
      common,
      'log',
      '--no-walk=unsorted',
      '--format=%H%x00%P%x00%s%x00%(trailers:key=Ultimate-Conversation,valueonly,separator=%x2C)%x00%ct%x1e',
      ...commits.map((commit) => commit.sha),
    ).catch(() => '')
    const details = new Map(
      shown
        .split('\x1e')
        .map((record) => record.trim().split('\0'))
        .map(([sha, parents, subject, trailer, time]) => [
          sha,
          { parents, subject, trailer, time: Number(time) },
        ]),
    )
    for (const commit of commits) {
      const found = details.get(commit.sha)
      if (!found) continue
      const parents = found.parents ? found.parents.split(' ') : []
      // A merge commit on the HEAD it started from, with this conversation's trailer, made during this call: not a
      // fast-forward or squash, nor a fast-forward onto an older merge.
      if (
        commit.merged !== undefined &&
        !(
          parents.length > 1 &&
          parents[0] === commit.merged &&
          found.trailer.trim() === String(conversation) &&
          found.time >= Math.floor(started / 1000)
        )
      )
        continue
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
  // In the tool itself, not a wrap, so the events carry the call's trace and conversation.
  const bashTool: typeof shell = {
    ...shell,
    async execute(args, api, context) {
      // One log per invocation: task ids repeat across projects and a retried call reruns its task.
      const log = join(tmpdir(), `ultimate-commits-${randomUUID()}.log`)
      const started = Date.now()
      const call = createBashTool({
        prepare: (execution) => prepareBash(execution, api, log),
      })
      try {
        return await call.execute(args, api, context)
      } finally {
        // A failed or stopped command may still have committed, so record what it made either way.
        const commits = await madeCommits(log, api.conversationId, started)
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
  }
  return defineExtension({
    name: 'coding-tools',
    tools: [createReadTool(), createWriteTool(), createEditTool(), bashTool],
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
