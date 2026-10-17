import { existsSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  configure,
  defineExtension,
  defineTool,
  hook,
  ROOT_CONVERSATION_ID,
  section,
  ToolTask,
} from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
// oxlint-disable-next-line no-restricted-imports -- workspace discovery shares the core root watcher
import { watchRoots } from '../../server/watch-roots.ts'
import type { ConversationsService } from '../conversations/server.ts'
import { agentRoots } from '../subagents/agents.ts'
import { empty, git, isolatable, noCommit, noRepository } from './git.ts'
import { Workspaces, workspaces } from './workspaces.ts'
export type WorkspaceService = ReturnType<typeof workspaces> & {
  git: typeof git
  doc: typeof Workspaces
  setupGit(): Promise<void>
}
export const order = -200
export const docs = [Workspaces]
export const userActions = ['setupGit']
/** A project trust change moves the definition roots: reopening rewatches them and reconfigures the landers. */
export const reloadOnSettings = true
const finish = (value: unknown) => ({
  output: [{ type: 'text' as const, text: JSON.stringify(value) }],
})
function workspaceId(args: JsonValue) {
  const id = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new Error('Expected a workspace conversation id')
  return id as ConversationId
}
async function setupGit(host: ExtensionHost) {
  const checkout = await isolatable(host.projectRoot)
  if (!('reason' in checkout)) return
  if (!(await empty(host.projectRoot)))
    throw new Error('This folder has files; ask the agent to choose what the first commit holds')
  if (checkout.reason === noRepository) await git(host.projectRoot, 'init')
  else if (checkout.reason !== noCommit) throw new Error(checkout.reason)
  await git(host.projectRoot, 'commit', '--allow-empty', '--message', 'Initial commit')
  await workspaces(host).standLander(context)
}

export const actions = {
  pending(args: JsonValue, { host }: ActionContext) {
    const ids = args && typeof args === 'object' && !Array.isArray(args) ? args.ids : undefined
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    )
      throw new Error('Expected workspace conversation ids')
    return workspaces(host).pending(ids as number[], context)
  },
  async create(args: JsonValue, { host }: ActionContext) {
    const input = (args ?? {}) as { cwd?: string; title?: string }
    if (input.cwd !== undefined && typeof input.cwd !== 'string')
      throw new Error('cwd must be a string')
    if (input.title !== undefined && typeof input.title !== 'string')
      throw new Error('title must be a string')
    const root = (await host.harness().conversation(ROOT_CONVERSATION_ID, context))!
    const agent = await root.agent(context)
    const id = await host.harness().commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await configure(tx, conversation.id, {
        model: agent.model,
        thinkingLevel: agent.thinkingLevel,
      })
      if (input.title) (await tx.doc(host.metadata, conversation.id)).title = input.title
      await workspaces(host).create(tx, conversation.id, input.cwd ?? host.projectRoot)
      return conversation.id
    }, context)
    host.harness().resume()
    return { id }
  },
  /**
   * Why the project cannot start isolated conversations, if it cannot, and whether its folder is still empty, so
   * `setupGit` can make the first commit. Once it can, the project's lander is stood if it has none yet, so a first
   * commit made in a conversation brings the lander without a restart.
   */
  async isolation(_args: JsonValue, { host }: ActionContext) {
    const checkout = await isolatable(host.projectRoot)
    if ('reason' in checkout)
      return { reason: checkout.reason, empty: await empty(host.projectRoot) }
    const index = await host.harness().snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
    if (index?.landerConversations[checkout.source] === undefined)
      await workspaces(host).standLander(context)
    return {}
  },
  /**
   * Make an empty folder isolatable: `git init` where there is no repository, then an empty first commit. A folder
   * with files needs judgement about what to commit, so it is left to an agent.
   */
  async setupGit(_args: JsonValue, { host }: ActionContext) {
    await setupGit(host)
    return {}
  },
  info(args: JsonValue, { host }: ActionContext) {
    return workspaces(host).info(workspaceId(args), context)
  },
  discard(args: JsonValue, { host }: ActionContext) {
    return workspaces(host).discard(workspaceId(args), context)
  },
  stats(_args: JsonValue, { host }: ActionContext) {
    return workspaces(host).stats(context)
  },
  disk(_args: JsonValue, { host }: ActionContext) {
    return workspaces(host).disk()
  },
}
/** Call `changed` on any change to a definition folder, also one that appears later. */
function watchDefinitions(
  host: Pick<ExtensionHost, 'ultimateRoot' | 'projectRoot' | 'userHome'>,
  changed: () => void,
) {
  const watchers: FSWatcher[] = []
  const attach = (root: string) => {
    try {
      watchers.push(watch(root, changed))
    } catch {
      // Gone again; watchRoots reports it when it reappears.
    }
  }
  const roots = agentRoots(host.ultimateRoot, host.projectRoot, host.userHome).map(
    (root) => root.path,
  )
  for (const root of roots) if (existsSync(root)) attach(root)
  const stopRoots = watchRoots(roots, (root) => {
    attach(root)
    changed()
  })
  return () => {
    stopRoots()
    for (const watcher of watchers) watcher.close()
  }
}
export default function workspaceExtension(host: ExtensionHost) {
  const service = workspaces(host)
  host.provide('workspaces', {
    ...service,
    git,
    doc: Workspaces,
    setupGit: () => setupGit(host),
  } satisfies WorkspaceService)
  const resume = () =>
    service.resume(context).catch((error: unknown) => {
      host.notice(`Lander resume failed: ${String(error)}`)
    })
  let unsubscribe: (() => void) | undefined
  let stopWatching: (() => void) | undefined
  let pending: ReturnType<typeof setTimeout> | undefined
  let releasing: Promise<unknown> | undefined
  let releaseController: AbortController | undefined
  // A lander task that faults leaves its queue behind. One run by older code, as on a reload of this code that changed
  // the Workspaces document, is replaced at once; a fault of this code's own task would only repeat, so it waits for
  // the next submit or open. Opening (and each reload while open) picks up any such queue. An aborted task stays
  // stopped until then too.
  const stand = () =>
    service.standLander(context).catch((error: unknown) => {
      host.notice(`Lander setup failed: ${String(error)}`)
    })
  host.onOpen(async () => {
    releaseController = new AbortController()
    const { signal } = releaseController
    releasing = (
      host.use<ConversationsService>('conversations')?.concluded(context) ??
      Promise.resolve(new Set<ConversationId>())
    )
      .then((ids) => service.release([...ids], context, signal))
      .catch((error: unknown) => {
        host.notice(`Workspace release failed: ${String(error)}`)
      })
    unsubscribe?.()
    unsubscribe = host.harness().subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (
          change.type !== 'task' ||
          change.value.kind !== service.Lander.definition.name ||
          change.value.state.status !== 'terminal' ||
          change.value.state.outcome.status !== 'faulted'
        )
          continue
        if (service.started.has(change.value.id))
          host.notice(
            `Lander task ${change.value.id} faulted: ${change.value.state.outcome.error.message}; its queue resumes on the next submit or restart`,
          )
        else void resume()
      }
    })
    // A definition edit reconfigures every lander conversation before anyone writes to it again.
    stopWatching?.()
    stopWatching = watchDefinitions(host, () => {
      clearTimeout(pending)
      pending = setTimeout(() => void stand(), 200)
    })
    await stand()
    await resume()
  })
  host.onClose(async () => {
    releaseController?.abort()
    await releasing
    unsubscribe?.()
    unsubscribe = undefined
    stopWatching?.()
    stopWatching = undefined
    clearTimeout(pending)
  })
  return defineExtension({
    name: 'workspaces',
    tasks: [service.Preparation, service.Lander],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (_call, api, caller) => {
          const reason = await service.unavailable(api.conversationId, caller)
          if (reason) return { block: reason }
          const landing = await service.landerOwnsCheckout(api.conversationId, caller)
          return landing ? { block: landing } : undefined
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'workspace',
        description:
          'Inspect your workspace and source tips; submit your clean, verified tip to the lander, which merges it into the target branch, runs the configured checks, fast-forwards the target, pushes when configured, and reports back (submit requires divergence from the original request); or land it synchronously by fast-forward (never rebases or pushes).',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('status'),
            Type.Literal('submit'),
            Type.Literal('land'),
          ]),
          divergence: Type.Optional(
            Type.String({
              description:
                "Required for submit. How the delivered result differs from what was originally asked: new agreements, a different approach or library, changed scope. Say 'None' when it matches.",
            }),
          ),
        }),
        async execute({ action, divergence }, api, caller) {
          if (action === 'status')
            return finish({
              conversationId: api.conversationId,
              workspace: await service.info(api.conversationId, caller),
            })
          await api.commit(async (tx) => {
            const row = await tx.conversation(api.conversationId)
            if (
              !row ||
              row.owner ||
              Object.values(
                (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).landerConversations,
              ).includes(api.conversationId)
            )
              throw new Error(`Only a top-level main conversation can ${action} its own workspace`)
          }, caller)
          if (action === 'submit')
            return finish(await service.submit(api.conversationId, divergence ?? '', caller))
          return finish(await service.land(api.conversationId, caller, true))
        },
      }),
    ],
    sections: [
      section('lander_state', async (input, caller) => {
        const index = await host.harness().snapshot(Workspaces, ROOT_CONVERSATION_ID, caller)
        const source = Object.entries(index?.landerConversations ?? {}).find(
          ([, id]) => id === input.conversationId,
        )?.[0]
        if (!index || source === undefined) return undefined
        const queue = index.queue.filter((item) => item.source === source)
        const results = Object.entries(index.results)
          .filter(([, result]) => result.lander === input.conversationId)
          .slice(-8)
        return [
          `You are the lander of ${source}. Queue (oldest first):`,
          ...(queue.length
            ? queue.map(
                (item) =>
                  `- ${item.id} #${item.conversationId} tip ${item.tip.slice(0, 7)} ${item.state}${item.step ? ` · ${item.step}` : ''}`,
              )
            : ['- empty']),
          'Latest results (oldest first):',
          ...(results.length
            ? results.map(
                ([id, result]) =>
                  `- ${id} ${result.outcome}${result.sha ? ` ${result.sha.slice(0, 7)}` : ''}${result.pushed ? ` pushed to ${result.pushed}` : ''}${result.reason ? ` · ${result.reason}` : ''}${result.fixed ? ` · fixed by lander` : ''}`,
              )
            : ['- none yet']),
        ].join('\n')
      }),
      section('workspace_workflow', async (input, caller) => {
        await service.ready(input.conversationId, caller)
        const own = await service.get(input.conversationId, caller)
        if (!own) return undefined
        return `Workspace: ${own.path} (branch ${own.branch}).\nSource: ${own.source}, target: ${own.target}.\n\`workspace status\` shows both tips. Finish with \`workspace submit\` once your tip is committed and verified: the lander merges it into ${own.target} with whatever landed meanwhile, runs the project's checks, fast-forwards ${own.target}, pushes when configured, and reports the outcome back to you as a message; keep working meanwhile and do not merge ${own.target} yourself first. \`workspace land\` is the synchronous alternative: it only fast-forwards ${own.target} to your tip and never rebases or pushes.`
      }),
    ],
  })
}
