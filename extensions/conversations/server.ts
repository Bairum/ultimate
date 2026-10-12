import type { Context, JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension, section } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Summaries, summaryBehavior } from './summary.ts'
import { Overview, overviewBehavior } from './overview.ts'

export const docs = [Summaries, Overview]

const record = (host: Pick<ExtensionHost, 'harness'>, id: ConversationId, caller: Context) =>
  host.harness().commit((tx) => tx.conversation(id), caller)

/** The id of a top-level conversation: neither owned (a subagent) nor forked. */
async function topLevelId(host: ExtensionHost, args: JsonValue) {
  const id = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('Expected a conversation id')
  const found = await record(host, id as ConversationId, context)
  if (!found) throw new Error(`Unknown conversation ${id}`)
  if (found.owner || found.parent)
    throw new Error(`Conversation ${id} is a subagent or a fork, not a top-level conversation`)
  return id as ConversationId
}

async function setTitle(host: ExtensionHost, id: ConversationId, title: string | undefined) {
  await host.harness().commit(async (tx) => {
    const metadata = await tx.doc(host.metadata, id)
    if (title) metadata.title = title
    else delete metadata.title
  }, context)
}

// Render last: Durable appends a section that appears, and re-sends the whole prompt when that breaks the order.
export const order = 100

/** Called by the sidebar; each acts on a top-level conversation by id. */
export const actions = {
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

/** Tells each top-level conversation which other conversations work in this project. */
export default (host: ExtensionHost) => {
  overviewBehavior(host)
  /** Whether each conversation is top-level, read once: `owner` and `parent` never change after creation. */
  const topLevel = new Map<ConversationId, boolean>()
  return defineExtension({
    name: 'conversations',
    ...summaryBehavior(host),
    sections: [
      section('conversations', async (input, caller) => {
        // Summaries can lag behind a new conversation, so its record decides; subagents and forks get nothing.
        if (!topLevel.has(input.conversationId)) {
          const own = await record(host, input.conversationId, caller)
          if (!own) return undefined
          topLevel.set(input.conversationId, !own.owner && !own.parent)
        }
        if (!topLevel.get(input.conversationId)) return undefined
        const archived = (await host.uiState(caller))['ext.conversations.archived']
        // Only membership, titles and cwds go in, so the text changes rarely and prompt caches stay warm.
        const others = host
          .conversations()
          .filter(
            (summary) =>
              summary.id !== input.conversationId &&
              summary.parentConversationId === undefined &&
              summary.inputAt !== undefined &&
              !(Array.isArray(archived) && archived.includes(summary.id)),
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
