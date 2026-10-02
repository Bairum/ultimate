import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension, defineTool, section, wrapTool } from '@earendil-works/pi-durable'
import { createBashTool } from '@earendil-works/pi-durable/tools'
import type { ActionContext } from '../../../server/actions.ts'

/**
 * The agent never writes to GitHub: it proposes labels or a reply with `triage_propose`, the Triage surface shows the
 * proposal with Apply and Discard, and only the user's confirmed click calls the write actions below.
 */
/** gh commands that change something on GitHub. The agent proposes; only the user's click in the UI writes. */
const GITHUB_WRITES = [
  /\bgh\s+(?:issue|pr)\s+(?:comment|edit|close|reopen|create|merge|review|lock|unlock|delete|transfer|pin|unpin|ready)\b/,
  /\bgh\s+label\s+(?:create|edit|delete|clone)\b/,
  /\bgh\s+api\b[^\n]*(?:(?:-X|--method)\s*['"]?(?:POST|PATCH|PUT|DELETE)\b|\s(?:-f|-F|--field|--raw-field|--input)\b)/i,
]

export default defineExtension({
  name: 'github-triage',
  wraps: [
    wrapTool(createBashTool(), (bash) => ({
      ...bash,
      execute: (args, api, context) => {
        if (GITHUB_WRITES.some((pattern) => pattern.test(args.command)))
          throw new Error(
            'Blocked by github-triage: the agent never writes to GitHub. Propose labels or a reply with triage_propose; the user applies it in the Triage surface.',
          )
        return bash.execute(args, api, context)
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

type Gh = { ok: true; stdout: string } | { ok: false; missing: boolean; message: string }

/** Runs gh; a failure becomes its first stderr line (execFile puts stderr after "Command failed: …"). */
async function gh(ctx: ActionContext, args: string[]): Promise<Gh> {
  try {
    return { ok: true, stdout: (await ctx.exec('gh', args)).stdout }
  } catch (error) {
    if (ctx.signal.aborted) throw error
    const { code, message } = error as NodeJS.ErrnoException
    const detail = message.split('\n').slice(1).join('\n').trim() || message
    return { ok: false, missing: code === 'ENOENT', message: detail.split('\n')[0] ?? detail }
  }
}

function field(args: JsonValue, name: string): JsonValue | undefined {
  return args && typeof args === 'object' && !Array.isArray(args) ? args[name] : undefined
}

function repoArg(args: JsonValue): string {
  const repo = field(args, 'repo')
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo))
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
    if (add.length) {
      const fields = add.flatMap((name) => ['-f', `labels[]=${name}`])
      const result = await gh(ctx, [
        'api',
        '-X',
        'POST',
        `repos/${repo}/issues/${number}/labels`,
        ...fields,
      ])
      if (!result.ok) return { status: 'error', message: result.message }
    }
    for (const name of remove) {
      const path = `repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`
      const result = await gh(ctx, ['api', '-X', 'DELETE', path])
      if (!result.ok) return { status: 'error', message: result.message }
    }
    return { status: 'ok' }
  },
  /** Posts a comment; the UI calls it only after the user confirmed. Returns the new comment's URL. */
  async comment(args: JsonValue, ctx: ActionContext) {
    const repo = repoArg(args)
    if (!(await writable(ctx, repo))) return readOnly(repo)
    const number = numberArg(args)
    const body = textArg(args, 'body', 65536)
    if (!body) throw new Error('Expected a body')
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
    if (!result.ok) return { status: 'error', message: result.message }
    return { status: 'ok', url: result.stdout.trim() }
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
