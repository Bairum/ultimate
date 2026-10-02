import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
  wrapTool,
} from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { createBashTool } from '@earendil-works/pi-durable/tools'
import type { ActionContext } from '../../../server/actions.ts'

/**
 * The agent never writes to GitHub: it proposes labels or a reply with `triage_propose`, the Triage surface shows the
 * proposal with Apply and Discard, and only the user's confirmed click calls the write actions below.
 */
const shimDir = fileURLToPath(new URL('./bin/', import.meta.url))
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export default defineExtension({
  name: 'github-triage',
  wraps: [
    wrapTool(createBashTool(), (bash) => ({
      ...bash,
      execute: (args, api, context) => {
        return bash.execute(
          {
            ...args,
            command: `export PATH=${shellQuote(shimDir)}:"$PATH"\nunset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN\n${args.command}`,
          },
          api,
          context,
        )
      },
    })),
  ],
  sections: [
    section(
      'github_triage',
      () =>
        'The Triage surface (github-triage) lists GitHub issues and pull requests. Never write to GitHub yourself: no `gh issue edit`, `gh issue comment`, `gh pr edit`, `gh pr comment`, or `gh api` calls that change anything. To change labels or post a reply, call triage_propose; the user reviews it in the UI and applies it or not. Read with gh freely.',
    ),
  ],
  tools: [
    defineTool({
      name: 'triage_propose',
      description:
        'Propose labels or a reply for one GitHub issue or pull request. Nothing is written: the user sees the proposal in the Triage surface and applies, edits, or discards it. Use only labels that exist in the repository.',
      replay: 'safe',
      parameters: Type.Object({
        repo: Type.String({ description: 'owner/name' }),
        kind: Type.Union([Type.Literal('issue'), Type.Literal('pr')]),
        number: Type.Integer({ minimum: 1 }),
        addLabels: Type.Optional(Type.Array(Type.String())),
        removeLabels: Type.Optional(Type.Array(Type.String())),
        reply: Type.Optional(Type.String({ description: 'Markdown comment to post' })),
        reason: Type.Optional(Type.String({ description: 'One line: why' })),
      }),
      async execute(args) {
        const labels = (args.addLabels?.length ?? 0) + (args.removeLabels?.length ?? 0)
        if (!labels && !args.reply?.trim())
          return {
            isError: true,
            content: [{ type: 'text', text: 'Propose labels to add or remove, or a reply.' }],
          }
        return {
          content: [
            {
              type: 'text',
              text: `Proposed for ${args.repo}#${args.number}. The user applies or discards it in the Triage surface; do not apply it yourself.`,
            },
          ],
        }
      },
    }),
  ],
})

type Gh =
  | { ok: true; stdout: string }
  | { ok: false; missing: boolean; killed: boolean; message: string }

/**
 * Runs gh; a failure becomes its first stderr line (execFile puts stderr after "Command failed: …"). `killed` means
 * gh was stopped by the timeout, so a write may or may not have reached GitHub.
 */
async function gh(ctx: ActionContext, args: string[]): Promise<Gh> {
  try {
    return { ok: true, stdout: (await ctx.exec('gh', args)).stdout }
  } catch (error) {
    if (ctx.signal.aborted) throw error
    const { code, message, killed } = error as NodeJS.ErrnoException & { killed?: boolean }
    const detail = message.split('\n').slice(1).join('\n').trim() || message
    return {
      ok: false,
      missing: code === 'ENOENT',
      killed: killed === true,
      message: detail.split('\n')[0] ?? detail,
    }
  }
}

/**
 * What became of each half of a proposal, by `triage_propose` tool call id, in the conversation that made it.
 * `pending` is claimed before the GitHub write and replaced by its result in the same action, so a second tab, a
 * second click, or a retry after a crash finds the proposal taken and cannot write twice.
 */
export type Outcome =
  | { state: 'pending'; at: string }
  | { state: 'applied'; at: string; labels: string[] }
  | { state: 'posted'; at: string; text: string; url: string }
  | { state: 'discarded'; at: string }
export type Outcomes = { [callId: string]: { labels?: Outcome; reply?: Outcome } }
export const Proposals = defineDoc<Outcomes>({
  kind: 'github-triage.proposals',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  // A fork shows the same calls; they stay applied there too.
  fork: 'current',
  initial: () => ({}),
})
export const docs = [Proposals]

type Part = 'labels' | 'reply'

/** The proposal an action writes for: its tool call id in the calling conversation, and which half. */
function proposalArg(args: JsonValue, ctx: ActionContext) {
  const callId = field(args, 'callId')
  if (typeof callId !== 'string' || !callId || callId.length > 256)
    throw new Error('Expected callId')
  if (ctx.conversationId === undefined) throw new Error('Expected a conversation')
  return { callId, conversationId: ctx.conversationId as ConversationId }
}

/** Changes the proposals document of the proposal's conversation in one commit. */
async function record<T>(
  ctx: ActionContext,
  { conversationId }: ReturnType<typeof proposalArg>,
  change: (outcomes: Outcomes) => T,
) {
  const conversation = await ctx.host.harness().conversation(conversationId, BACKGROUND_CONTEXT)
  if (!conversation) throw new Error('Unknown conversation')
  return conversation.commit(
    async (tx) => change(await tx.doc(Proposals, conversationId)),
    BACKGROUND_CONTEXT,
  )
}

/** Claims one half for a write in its own commit; a message when it already has an outcome. */
function claim(ctx: ActionContext, proposal: ReturnType<typeof proposalArg>, part: Part) {
  return record(ctx, proposal, (outcomes) => {
    const outcome = outcomes[proposal.callId]?.[part]
    if (outcome)
      return outcome.state === 'pending'
        ? 'This proposal is already being written; check GitHub before proposing it again.'
        : `This proposal was already ${outcome.state}.`
    outcomes[proposal.callId] = {
      ...outcomes[proposal.callId],
      [part]: { state: 'pending', at: new Date().toISOString() },
    }
    return null
  })
}

/** Replaces the claim with the result, or releases it when GitHub surely refused the write. */
function settle(
  ctx: ActionContext,
  proposal: ReturnType<typeof proposalArg>,
  part: Part,
  outcome: Outcome | null,
) {
  return record(ctx, proposal, (outcomes) => {
    const entry = { ...outcomes[proposal.callId] }
    if (outcome) entry[part] = outcome
    else delete entry[part]
    outcomes[proposal.callId] = entry
  })
}

/**
 * The result of a failed write. Only a GitHub refusal (HTTP 4xx) surely wrote nothing and releases the claim; anything
 * else (a timeout, a network error, a 5xx) keeps it, since the write may have landed — the user checks and discards.
 */
async function failed(
  ctx: ActionContext,
  proposal: ReturnType<typeof proposalArg>,
  part: Part,
  result: Gh & { ok: false },
) {
  if (!result.killed && /\bHTTP 4\d\d\b/.test(result.message))
    await settle(ctx, proposal, part, null)
  return { status: 'error', message: result.message }
}

function field(args: JsonValue, name: string): JsonValue | undefined {
  return args && typeof args === 'object' && !Array.isArray(args) ? args[name] : undefined
}

function repoArg(args: JsonValue): string {
  const repo = field(args, 'repo')
  if (
    typeof repo !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    repo.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Expected repo as owner/name')
  return repo
}

function kindArg(args: JsonValue): 'issue' | 'pr' {
  const kind = field(args, 'kind')
  if (kind !== 'issue' && kind !== 'pr') throw new Error('Expected kind issue or pr')
  return kind
}

function numberArg(args: JsonValue): number {
  const number = field(args, 'number')
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1)
    throw new Error('Expected number')
  return number
}

function namesArg(args: JsonValue, name: string): string[] {
  const names = field(args, name) ?? []
  if (
    !Array.isArray(names) ||
    names.length > 20 ||
    !names.every((label) => typeof label === 'string' && label.trim() && label.length <= 100)
  )
    throw new Error(`Expected ${name} as label names`)
  return names as string[]
}

function textArg(args: JsonValue, name: string, max: number): string {
  const value = field(args, name) ?? ''
  if (typeof value !== 'string' || value.length > max) throw new Error(`Expected ${name} as text`)
  return value.trim()
}

interface Author {
  login: string
}
interface Label {
  name: string
  color: string
}

const labelOf = ({ name, color }: Label) => ({ name, color })

/** Repositories the UI may write to, from `githubTriage.writableRepos` in the project's `.ultimate/settings.json`. */
async function writable(ctx: ActionContext, repo: string) {
  try {
    const settings = JSON.parse(
      await readFile(join(ctx.host.projectRoot, '.ultimate', 'settings.json'), 'utf8'),
    )
    const repos: unknown = settings?.githubTriage?.writableRepos
    return (
      Array.isArray(repos) &&
      repos.some((name) => String(name).toLowerCase() === repo.toLowerCase())
    )
  } catch {
    return false
  }
}
const readOnly = (repo: string) => ({
  status: 'error',
  message: `Writes to ${repo} are off. To allow them, add "${repo}" to githubTriage.writableRepos in .ultimate/settings.json.`,
})

/** The UI calls these with `useAction('github-triage', name, args)`; each returns JSON. */
export const actions = {
  /** Whether gh is installed and logged in, and the project's own GitHub repository. */
  async status(_args: JsonValue, ctx: ActionContext) {
    const version = await gh(ctx, ['--version'])
    if (!version.ok) return { status: 'missing' }
    const user = await gh(ctx, ['api', 'user', '--jq', '.login'])
    if (!user.ok) return { status: 'auth', message: user.message }
    const repo = await gh(ctx, [
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '--jq',
      '.nameWithOwner',
    ])
    return {
      status: 'ready',
      login: user.stdout.trim(),
      defaultRepo: repo.ok ? repo.stdout.trim() : null,
    }
  },
  /** Up to 100 open issues or pull requests, optionally with one label and a GitHub search query. */
  async list(args: JsonValue, ctx: ActionContext) {
    const repo = repoArg(args)
    const kind = kindArg(args)
    const label = textArg(args, 'label', 100)
    const search = textArg(args, 'search', 200)
    const fields = ['number', 'title', 'author', 'labels', 'createdAt', 'updatedAt']
    if (kind === 'pr') fields.push('isDraft')
    const command = [kind, 'list', '-R', repo, '--state', 'open', '--limit', '100']
    if (label) command.push('--label', label)
    if (search) command.push('--search', search)
    const result = await gh(ctx, [...command, '--json', fields.join(',')])
    if (!result.ok) return { status: 'error', message: result.message }
    const items = JSON.parse(result.stdout) as {
      number: number
      title: string
      author: Author
      labels: Label[]
      createdAt: string
      updatedAt: string
      isDraft?: boolean
    }[]
    return {
      status: 'ok',
      items: items.map((item) => ({
        number: item.number,
        title: item.title,
        author: item.author.login,
        labels: item.labels.map(labelOf),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        draft: item.isDraft ?? false,
      })),
    }
  },
  /** One issue or pull request with its body and comments. */
  async show(args: JsonValue, ctx: ActionContext) {
    const repo = repoArg(args)
    const kind = kindArg(args)
    const number = numberArg(args)
    const fields = ['number', 'title', 'author', 'labels', 'createdAt', 'body', 'comments', 'url']
    if (kind === 'pr')
      fields.push('isDraft', 'baseRefName', 'headRefName', 'additions', 'deletions')
    const result = await gh(ctx, [
      kind,
      'view',
      String(number),
      '-R',
      repo,
      '--json',
      fields.join(','),
    ])
    if (!result.ok) return { status: 'error', message: result.message }
    const item = JSON.parse(result.stdout) as {
      number: number
      title: string
      author: Author
      labels: Label[]
      createdAt: string
      body: string
      url: string
      comments: { id: string; author: Author; body: string; createdAt: string }[]
      isDraft?: boolean
      baseRefName?: string
      headRefName?: string
      additions?: number
      deletions?: number
    }
    return {
      status: 'ok',
      item: {
        kind,
        number: item.number,
        title: item.title,
        author: item.author.login,
        labels: item.labels.map(labelOf),
        createdAt: item.createdAt,
        body: item.body,
        url: item.url,
        draft: item.isDraft ?? false,
        branch:
          kind === 'pr' ? { base: item.baseRefName ?? '', head: item.headRefName ?? '' } : null,
        diff:
          kind === 'pr' ? { additions: item.additions ?? 0, deletions: item.deletions ?? 0 } : null,
        comments: item.comments.map((comment) => ({
          id: comment.id,
          author: comment.author.login,
          body: comment.body,
          createdAt: comment.createdAt,
        })),
      },
    }
  },
  /** Adds and removes labels; the UI calls it only after the user confirmed. Issues and pull requests share the API. */
  async label(args: JsonValue, ctx: ActionContext) {
    const repo = repoArg(args)
    if (!(await writable(ctx, repo))) return readOnly(repo)
    const number = numberArg(args)
    const add = namesArg(args, 'add')
    const remove = namesArg(args, 'remove')
    const existing = await actions.labels({ repo }, ctx)
    const unknown = [...add, ...remove].filter(
      (name) => !existing.some((label) => label.name === name),
    )
    if (unknown.length)
      return { status: 'error', message: `Unknown repository labels: ${unknown.join(', ')}` }
    const proposal = proposalArg(args, ctx)
    const taken = await claim(ctx, proposal, 'labels')
    if (taken) return { status: 'error', message: taken }
    if (add.length) {
      const fields = add.flatMap((name) => ['-f', `labels[]=${name}`])
      const result = await gh(ctx, [
        'api',
        '-X',
        'POST',
        `repos/${repo}/issues/${number}/labels`,
        ...fields,
      ])
      if (!result.ok) return failed(ctx, proposal, 'labels', result)
    }
    for (const name of remove) {
      const path = `repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`
      const result = await gh(ctx, ['api', '-X', 'DELETE', path])
      if (!result.ok) return failed(ctx, proposal, 'labels', result)
    }
    const at = new Date().toISOString()
    await settle(ctx, proposal, 'labels', { state: 'applied', at, labels: [...add, ...remove] })
    return { status: 'ok' }
  },
  /** Posts a comment; the UI calls it only after the user confirmed. Returns the new comment's URL. */
  async comment(args: JsonValue, ctx: ActionContext) {
    const repo = repoArg(args)
    if (!(await writable(ctx, repo))) return readOnly(repo)
    const number = numberArg(args)
    const body = textArg(args, 'body', 65536)
    if (!body) throw new Error('Expected a body')
    const proposal = proposalArg(args, ctx)
    const taken = await claim(ctx, proposal, 'reply')
    if (taken) return { status: 'error', message: taken }
    const path = `repos/${repo}/issues/${number}/comments`
    const result = await gh(ctx, [
      'api',
      '-X',
      'POST',
      path,
      '-f',
      `body=${body}`,
      '--jq',
      '.html_url',
    ])
    if (!result.ok) return failed(ctx, proposal, 'reply', result)
    const url = result.stdout.trim()
    await settle(ctx, proposal, 'reply', {
      state: 'posted',
      at: new Date().toISOString(),
      text: body,
      url,
    })
    return { status: 'ok', url }
  },
  /** Discards one half in one commit: an open half, or one left `pending` by an interrupted or unclear write. */
  async discard(args: JsonValue, ctx: ActionContext) {
    const part = field(args, 'part')
    if (part !== 'labels' && part !== 'reply') throw new Error('Expected part labels or reply')
    const proposal = proposalArg(args, ctx)
    const taken = await record(ctx, proposal, (outcomes) => {
      const outcome = outcomes[proposal.callId]?.[part]
      if (outcome && outcome.state !== 'pending')
        return `This proposal was already ${outcome.state}.`
      outcomes[proposal.callId] = {
        ...outcomes[proposal.callId],
        [part]: { state: 'discarded', at: new Date().toISOString() },
      }
      return null
    })
    return taken ? { status: 'error', message: taken } : { status: 'ok' }
  },
  /** The repository's labels, for the filter and for suggestions. */
  async labels(args: JsonValue, ctx: ActionContext) {
    const repo = repoArg(args)
    const result = await gh(ctx, [
      'label',
      'list',
      '-R',
      repo,
      '--limit',
      '200',
      '--json',
      'name,color',
    ])
    if (!result.ok) return []
    return (JSON.parse(result.stdout) as Label[]).map(labelOf)
  },
}
