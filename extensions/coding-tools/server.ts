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

/** The file the commit hooks of bash call `api` append to, one line per commit or rewrite. */
const commitLog = (api: Pick<ToolExecutionApi, 'taskId'>) =>
  join(tmpdir(), `ultimate-commits-${encodeURIComponent(api.taskId)}.log`)

/**
 * Process-local Git hooks for one bash call. Each appends a line to `$ULTIMATE_COMMIT_LOG` and swallows every failure, so
 * it can never fail a commit; the trailing `#` drops the arguments Git appends.
 */
const where = `"$(git rev-parse --show-toplevel)" "$(git rev-parse --path-format=absolute --git-common-dir)"`
const hooks = (conversation: number) => ({
  'prepare-commit-msg': `git interpret-trailers --in-place --if-exists replace --trailer "Ultimate-Conversation: ${conversation}" "$1" #`,
  'post-commit': `printf 'commit\\t%s\\t%s\\t%s\\t%s\\n' "$(git rev-parse HEAD)" "$(git symbolic-ref -q --short HEAD)" ${where} 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
  // Merges run no post-commit. Fast-forwards and squashes run post-merge too, so it also logs the HEAD before the merge.
  'post-merge': `printf 'merge\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(git rev-parse HEAD)" "$(git symbolic-ref -q --short HEAD)" ${where} "$(git rev-parse -q --verify ORIG_HEAD)" 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
  'post-rewrite': `awk '{ print "rewrite\\t" $1 "\\t" $2 }' 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
})

export function prepareBash(
  execution: BashExecution,
  api: Pick<ToolExecutionApi, 'conversationId' | 'taskId'>,
) {
  let count = Number(process.env.GIT_CONFIG_COUNT ?? 0)
  for (const [event, command] of Object.entries(hooks(api.conversationId))) {
    execution.env[`GIT_CONFIG_KEY_${count}`] = `hook.ultimate-${event}.event`
    execution.env[`GIT_CONFIG_VALUE_${count++}`] = event
    execution.env[`GIT_CONFIG_KEY_${count}`] = `hook.ultimate-${event}.command`
    execution.env[`GIT_CONFIG_VALUE_${count++}`] = command
  }
  execution.env.GIT_CONFIG_COUNT = String(count)
  execution.env.ULTIMATE_COMMIT_LOG = commitLog(api)
}

type Made = { sha: string; branch?: string; toplevel: string; common: string; merged?: string }

/** The commits bash call `api` made, from its hook log, which this removes: newest line per commit wins. */
async function madeCommits(api: Pick<ToolExecutionApi, 'conversationId' | 'taskId'>) {
  const path = commitLog(api)
  const log = await readFile(path, 'utf8').catch(() => '')
  if (!log) return []
  await rm(path, { force: true })
  const made = new Map<string, Made>()
  const rewritten = new Map<string, string>()
  for (const line of log.split('\n')) {
    const [kind, sha, branch, toplevel, common, before] = line.split('\t')
    if (kind === 'rewrite') rewritten.set(branch, sha)
    else if ((kind === 'commit' || kind === 'merge') && sha && common)
      made.set(sha, {
        sha,
        ...(branch ? { branch } : {}),
        toplevel,
        common,
        ...(kind === 'merge' ? { merged: before ?? '' } : {}),
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
      '--format=%H%x00%P%x00%s%x00%(trailers:key=Ultimate-Conversation,valueonly,separator=%x2C)%x1e',
      ...commits.map((commit) => commit.sha),
    ).catch(() => '')
    const details = new Map(
      shown
        .split('\x1e')
        .map((record) => record.trim().split('\0'))
        .map(([sha, parents, subject, trailer]) => [sha, { parents, subject, trailer }]),
    )
    for (const commit of commits) {
      const found = details.get(commit.sha)
      if (!found) continue
      const parents = found.parents ? found.parents.split(' ') : []
      // A merge commit on top of the HEAD it started from, carrying this conversation's trailer; not a fast-forward.
      if (
        commit.merged !== undefined &&
        !(
          parents.length > 1 &&
          parents[0] === commit.merged &&
          found.trailer.trim() === String(api.conversationId)
        )
      )
        continue
      const repo = basename(common) === '.git' ? dirname(common) : common
      const from = rewritten.get(commit.sha)
      events.push({
        conversation: api.conversationId as number,
        sha: commit.sha,
        parents,
        repo,
        ...(commit.toplevel && commit.toplevel !== repo ? { worktree: commit.toplevel } : {}),
        ...(commit.branch ? { branch: commit.branch } : {}),
        subject: found.subject,
        ...(from ? { rewrittenFrom: from } : {}),
      })
    }
  }
  return events
}

export default function codingTools(host: Pick<ExtensionHost, 'emit'>) {
  const shell = createBashTool({ prepare: prepareBash })
  // In the tool itself, not a wrap, so the events carry the call's trace and conversation.
  const bashTool: typeof shell = {
    ...shell,
    async execute(args, api, context) {
      try {
        return await shell.execute(args, api, context)
      } finally {
        // A failed or stopped command may still have committed, so record what it made either way.
        const commits = await madeCommits(api)
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
