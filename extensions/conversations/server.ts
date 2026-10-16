import { join } from 'node:path'
import type { Context, JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension, ROOT_CONVERSATION_ID, section } from '@earendil-works/pi-durable'
import type { CommitPublication, ConversationId } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { BranchedEvent } from '../lineage/server.ts'
import type { LandingSubject } from '../workspaces/types.ts'
import type { WorkspaceService } from '../workspaces/server.ts'
// oxlint-disable-next-line no-restricted-imports -- conversations publishes the core UI state document
import { UiState } from '../../server/ui-state.ts'
import { Summaries, summaryBehavior } from './summary.ts'
import { summaryModelSetting } from './summary-model.ts'
import { parseSummaryModel } from './summary-model-ref.ts'
import { updateSettings } from '../onboarding/settings.ts'
import { Overview, overviewBehavior } from './overview.ts'
import { activityBehavior } from './activity.ts'

export const docs = [Summaries, Overview]

const record = (host: Pick<ExtensionHost, 'harness'>, id: ConversationId, caller: Context) =>
  host.harness().commit((tx) => tx.conversation(id), caller)

/** The id of a top-level conversation: not owned by another conversation. */
async function topLevelId(host: ExtensionHost, args: JsonValue) {
  const id = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('Expected a conversation id')
  const found = await record(host, id as ConversationId, context)
  if (!found) throw new Error(`Unknown conversation ${id}`)
  if (found.owner) throw new Error(`Conversation ${id} is owned, not a top-level conversation`)
  return id as ConversationId
}

async function setTitle(host: ExtensionHost, id: ConversationId, title: string | undefined) {
  await host.harness().commit(async (tx) => {
    const metadata = await tx.doc(host.metadata, id)
    if (title) metadata.title = title
    else delete metadata.title
  }, context)
}

const projectFile = (host: ExtensionHost) => join(host.projectRoot, '.ultimate/settings.json')

async function effectiveSummaryModel(host: ExtensionHost) {
  const setting = await summaryModelSetting(host)
  return setting.source === 'project' ? { ...setting, path: projectFile(host) } : setting
}

// Render last: Durable appends a section that appears, and re-sends the whole prompt when that breaks the order.
export const order = 100

/** Called by the sidebar; each acts on a top-level conversation by id. */
export const actions = {
  async conclude(args: JsonValue, { host }: ActionContext) {
    const ids = conversationIds(args)
    await host.harness().commit(async (tx) => {
      for (const id of ids) {
        const found = await tx.conversation(id)
        if (!found) throw new Error(`Unknown conversation ${id}`)
        if (found.owner)
          throw new Error(`Conversation ${id} is owned, not a top-level conversation`)
      }
      const ui = await tx.doc(UiState, ROOT_CONVERSATION_ID)
      const previous = ui['ext.conversations.concluded']
      ui['ext.conversations.concluded'] = [
        ...new Set([...(Array.isArray(previous) ? previous : []), ...ids]),
      ]
    }, context)
    const kept = (await host.use<WorkspaceService>('workspaces')?.release(ids, context)) ?? []
    return { concluded: ids, kept }
  },
  async resume(args: JsonValue, { host }: ActionContext) {
    const ids = conversationIds(args)
    const resumed = await resume(host, ids)
    return { resumed }
  },
  /** `{id, title}`: a blank title removes it, so the first message names the conversation again. */
  async rename(args: JsonValue, { host }: ActionContext) {
    const id = await topLevelId(host, args)
    const title = (args as { title?: JsonValue }).title
    if (typeof title !== 'string') throw new Error('Expected a title')
    const normalized = title.replace(/\s+/g, ' ').trim().slice(0, 160)
    await host.harness().commit(async (tx) => {
      const state = await tx.doc(Summaries, id)
      delete state.generatedTitle
      const metadata = await tx.doc(host.metadata, id)
      if (normalized) metadata.title = normalized
      else delete metadata.title
    }, context)
    return { ok: true }
  },
  /**
   * The effective `summaryModel` setting: `{ value, source: 'default' | 'user' | 'project', default, path? }`, with the
   * project file's `path` when the project's settings decide it.
   */
  async summaryModel(_args: JsonValue, { host }: ActionContext) {
    return effectiveSummaryModel(host)
  },
  /**
   * `{value}`: sets `summaryModel` in the user's settings; `null` removes it, back to the default. The project's
   * tracked settings file is never written: while it sets the model, this refuses.
   */
  async setSummaryModel(args: JsonValue, { host }: ActionContext) {
    const value = args && typeof args === 'object' && !Array.isArray(args) ? args.value : undefined
    if (value !== null && (typeof value !== 'string' || !parseSummaryModel(value)))
      throw new Error('Expected value "provider/id[:thinking]" or null')
    if ((await summaryModelSetting(host)).source === 'project')
      throw new Error(
        `The summary model is set by project settings in ${projectFile(host)}; edit that file to change it`,
      )
    await updateSettings(join(host.userHome, '.ultimate/settings.json'), (settings) => {
      if (value === null) delete settings.summaryModel
      else settings.summaryModel = value
    })
    return effectiveSummaryModel(host)
  },
  /** `{id}`: starts a new context, keeping the conversation's title. */
  async reset(args: JsonValue, { host }: ActionContext) {
    const id = await topLevelId(host, args)
    const graph = await host.harness().taskGraph(context)
    try {
      const summary = host.conversations().find((item) => item.id === id)
      if (
        Object.values(graph.value.tasks).some(
          (task) => task.conversationId === id && !task.background,
        )
      )
        throw new Error(`Conversation ${id} is working; stop it before clearing it`)
      // The derived title comes from the first message in the active context, which the reset empties.
      if (summary?.title && !(await host.harness().snapshot(host.metadata, id, context))?.title)
        await setTitle(host, id, summary.title)
    } finally {
      graph.dispose()
    }
    await host.harness().commit(async (tx) => {
      const state = await tx.doc(Summaries, id)
      state.exchanges = 0
      state.revision++
      delete state.intentRequested
      delete state.lastYield
      delete state.lastAnswer
      delete state.pending
      delete state.summary
      delete state.abstract
      delete state.feature
      delete state.summaryOwed
      delete state.assessment
      delete state.activity
      delete state.assessmentStatus
      delete state.status
    }, context)
    await (await host.harness().conversation(id, context))!.reset(undefined, context)
    return { ok: true }
  },
}

/** Only placed composer inputs reopen ancestry; extension inputs and passive writes do not. */
function placedInputs(publication: CommitPublication) {
  return publication.changes.flatMap((change) =>
    change.type === 'submission' &&
    change.value.type === 'input' &&
    change.value.status === 'placed' &&
    publication.changes.some(
      (entry) =>
        entry.type === 'entry' &&
        entry.value.id === change.value.entry &&
        entry.value.kind === 'pi.user',
    )
      ? [change.value.conversationId]
      : [],
  )
}

function conversationIds(args: JsonValue): ConversationId[] {
  const ids = args && typeof args === 'object' && !Array.isArray(args) ? args.ids : undefined
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
  )
    throw new Error('Expected conversation ids')
  return [...new Set(ids)] as ConversationId[]
}

async function resume(host: ExtensionHost, ids: ConversationId[]) {
  return host.harness().commit(async (tx) => {
    const ancestors = new Set<ConversationId>()
    for (const id of ids) {
      let current: ConversationId | undefined = id
      while (current !== undefined && !ancestors.has(current)) {
        ancestors.add(current)
        const found = await tx.conversation(current)
        if (!found) throw new Error(`Unknown conversation ${current}`)
        current = found.owner?.conversationId ?? found.parent?.conversationId
      }
    }
    const ui = await tx.doc(UiState, ROOT_CONVERSATION_ID)
    const previous = ui['ext.conversations.concluded']
    const removed = Array.isArray(previous)
      ? previous.filter((id) => ancestors.has(id as ConversationId))
      : []
    if (removed.length)
      ui['ext.conversations.concluded'] = (previous as JsonValue[]).filter(
        (id) => !ancestors.has(id as ConversationId),
      )
    return removed
  }, context)
}

function reopenOnInput(host: ExtensionHost) {
  let stop: (() => void) | undefined
  host.onOpen(async () => {
    stop = host.harness().subscribeCommits((publication) => {
      const ids = placedInputs(publication)
      if (!ids.length) return
      void resume(host, ids).catch((error) =>
        host.notice('Unable to reopen conversation: ' + String(error)),
      )
    })
  })
  host.onClose(async () => {
    stop?.()
  })
}

export type ConversationsService = {
  /** What conversation `id` is about now: its title, summary and feature, for a record that outlives a retitle. */
  subject: (id: ConversationId, caller: Context) => Promise<LandingSubject>
  concluded: (caller: Context) => Promise<Set<ConversationId>>
}

export async function subject(
  host: Pick<ExtensionHost, 'harness' | 'metadata'>,
  id: ConversationId,
  caller: Context,
): Promise<LandingSubject> {
  const [metadata, state] = await Promise.all([
    host.harness().snapshot(host.metadata, id, caller),
    host.harness().snapshot(Summaries, id, caller),
  ])
  return {
    ...(metadata?.title ? { title: metadata.title } : {}),
    ...(state?.summary ? { summary: state.summary } : {}),
    ...(state?.feature ? { feature: state.feature } : {}),
  }
}

/** Tells each top-level conversation which other conversations work in this project. */
export default (host: ExtensionHost) => {
  host.provide('conversations', {
    subject: (id, caller) => subject(host, id, caller),
    concluded: async (caller) => {
      const ids = (await host.uiState(caller))['ext.conversations.concluded']
      return new Set(Array.isArray(ids) ? (ids as ConversationId[]) : [])
    },
  } satisfies ConversationsService)
  // A new branch or root is called by its intent until its summary names it.
  const named = (data: unknown) => {
    const { tx, id, intent, waitUntil } = data as BranchedEvent
    waitUntil(
      (async () => {
        const title = intent.replace(/\s+/g, ' ').slice(0, 80)
        ;(await tx.doc(Summaries, id)).generatedTitle = title
        ;(await tx.doc(host.metadata, id)).title = title
      })(),
    )
  }
  host.events.on('lineage:branched', named)
  host.events.on('lineage:rooted', named)
  activityBehavior(host)
  overviewBehavior(host)
  reopenOnInput(host)
  /** Whether each conversation is top-level, read once: `owner` and `parent` never change after creation. */
  const topLevel = new Map<ConversationId, boolean>()
  return defineExtension({
    name: 'conversations',
    ...summaryBehavior(host),
    sections: [
      section('conversations', async (input, caller) => {
        // Summaries can lag behind a new conversation, so its record decides; owned conversations get nothing.
        if (!topLevel.has(input.conversationId)) {
          const own = await record(host, input.conversationId, caller)
          if (!own) return undefined
          topLevel.set(input.conversationId, !own.owner)
        }
        if (!topLevel.get(input.conversationId)) return undefined
        const concluded = (await host.uiState(caller))['ext.conversations.concluded']
        // Only membership, titles and cwds go in, so the text changes rarely and prompt caches stay warm.
        const others = host
          .conversations()
          .filter(
            (summary) =>
              summary.id !== input.conversationId &&
              summary.parentConversationId === undefined &&
              summary.inputAt !== undefined &&
              !(Array.isArray(concluded) && concluded.includes(summary.id)),
          )
          .toSorted((a, b) => b.inputAt! - a.inputAt!)
          .slice(0, 10)
          .toSorted((a, b) => a.id - b.id)
        const projectCount = (await host.projects()).filter((project) => !project.current).length
        const projectLine = projectCount
          ? `${projectCount} other ${projectCount === 1 ? 'project exists' : 'projects exist'}; in codemode, \`ultimate.projects()\` lists them with their conversations and URL when running.`
          : undefined
        if (!others.length) return projectLine
        return [
          `You are conversation #${input.conversationId}. Other conversations in this project, each a separate agent with its own context:`,
          ...others.map(
            (summary) =>
              `- #${summary.id} ${summary.title ?? 'untitled'}` +
              (summary.cwd === input.agent.cwd ? '' : ` (cwd: ${summary.cwd})`),
          ),
          '',
          'They work in the same checkout unless a cwd says otherwise: check `git status` before broad changes, never revert or reformat changes you did not make, and coordinate through the user. In codemode, `ultimate.entries(id)` shows what another conversation did and `ultimate.taskGraph()` whether it is working.',
          ...(projectLine ? ['', projectLine] : []),
        ].join('\n')
      }),
    ],
  })
}
