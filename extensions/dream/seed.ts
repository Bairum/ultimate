import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { SubagentsApi } from '../subagents/api.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import type { Todo } from '../todos/refs.ts'
import { Roots } from '../lineage/api.ts'
import { Messages } from '../messages/api.ts'
import type { Question } from '../questions/types.ts'
import type { Automation } from '../automations/types.ts'
import { deliver } from './delivery.ts'
import type { Session } from './refs.ts'
import type { Seed } from './types.ts'

/** Application and schedule receipts on conversation 1; the seed file itself stays on disk. */
export const SeedState = defineDoc<{ applied?: number; automations: string[] }>({
  kind: 'dream.seed',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ automations: [] }),
})

/** Exported conversation documents are resolved at call time, including after a facet reload. */
async function document<T>(host: ExtensionHost, tx: Tx, kind: string, id = 1): Promise<T> {
  const token = host.doc(kind)
  if (!token) throw new Error(`Chapter seed needs document ${kind}`)
  return (await tx.doc(token, id as ConversationId)) as unknown as T
}

/** Read the settled dream and project context without importing another facet's implementation. */
export async function buildSeed(host: ExtensionHost, session: number): Promise<Seed> {
  const signal = new AbortController().signal
  // These ledgers are session-scoped, not exported conversation docs; their list actions read them.
  const automations = (await host.invoke('automations', 'list', null, signal)) as Automation[]
  return host.harness().commit(async (tx) => {
    const found = (
      await document<{ sessions: Session[] }>(host, tx, 'dream.sessions')
    ).sessions.find((item) => item.id === session)
    if (!found?.journal) throw new Error(`Dream session ${session} has no journal`)
    const roots = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots
    // A null prototype: `constructor` and the like are valid memory slugs.
    const memories = Object.create(null) as Record<string, MemoryItem>
    const about = new Set<string>()
    for (const root of roots) {
      const source = await document<{ memories: Record<string, MemoryItem> }>(
        host,
        tx,
        'lineage.memory',
        root,
      )
      for (const [slug, memory] of Object.entries(source.memories)) {
        if (slug.startsWith('about-')) about.add(slug)
        if (!memories[slug] || memory.updated > memories[slug].updated) memories[slug] = memory
      }
    }
    // Open questions are the user's unanswered messages, as the To-dos panel lists them: their extracted questions, or
    // the message itself when extraction is off, pending or failed. Both live on conversation 1.
    const board = await document<{ asked: Record<string, Question[]> }>(host, tx, 'questions.board')
    const questions: Seed['questions'] = []
    for (const message of (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages) {
      if (message.to !== 'user' || !message.reply || message.state !== 'delivered') continue
      const ref = `#${message.id}`
      const extracted = board.asked[String(message.id)] ?? []
      if (extracted.length) for (const { text } of extracted) questions.push({ text, ref })
      else questions.push({ text: message.text, ref })
    }
    for (const slug of about)
      if (!memories[slug]) throw new Error(`Chapter seed lost user memory ${slug}`)
    const todos = (await document<{ items: Todo[] }>(host, tx, 'todos')).items
      .filter((item) => item.done === undefined)
      .map(({ text, owner }) => ({ text, owner }))
    const schedules = automations
      .filter((item) => item.enabled && item.schedule)
      .map((item) => {
        const { name, prompt, agent, model, thinking } = item
        const schedule = item.schedule!
        return {
          name,
          prompt,
          schedule,
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
        }
      })
    const names = new Set<string>()
    for (const { name } of schedules) {
      if (names.has(name)) throw new Error(`Chapter seed needs unique automation names: ${name}`)
      names.add(name)
    }
    const watchers = automations
      .filter((item) => item.enabled && item.script)
      .map(({ id, scope, name, script, prompt, agent, model, thinking }) => ({
        id,
        ...(scope ? { scope } : {}),
        name,
        ask: script!.ask,
        ...(prompt ? { prompt } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
      }))
    // Materialize document overlays before the transaction releases them.
    return JSON.parse(
      JSON.stringify({
        from: { name: host.chapter.name, number: host.chapter.number },
        session,
        journal: { ...found.journal, proposals: found.proposals },
        memories,
        todos,
        questions,
        automations: schedules,
        scripts: watchers,
        counts: {
          memories: Object.keys(memories).length,
          todos: todos.length,
          questions: questions.length,
          automations: schedules.length,
          scripts: watchers.length,
        },
      }),
    ) as Seed
  }, context)
}

/** Publish a complete seed atomically in the destination chapter's directory. */
export const writeSeed = (dir: string, seed: Seed) => writeJson(join(dir, 'seed.json'), seed)

function chapterText(host: ExtensionHost, seed: Seed) {
  const { from } = seed
  return [
    `We just woke up in Chapter ${host.chapter.number} · ${host.chapter.name}. Chapter ${from.number} · ${from.name} stays on disk: read it with codemode \`ultimate.entries(id, { chapter: '${from.name}' })\` / \`search\` / \`conversations\`; ids continue across chapters, so \`#123\` sources and links into it still name one conversation; write cross-chapter links as \`${from.name}#123\`.`,
    ...seed.journal.learned.map((line) => `- ${line}`),
    `Carried: ${Object.entries(seed.counts)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ')}.`,
    'Greet the user in one or two lines and say you are ready. They check you next in a side chat: what this project is, what is open, what the rules are and who you work with.',
  ].join('\n')
}

/** Apply documents and schedule the chapter entry atomically; reconcile scheduler effects after that commit. */
export async function applySeed(host: ExtensionHost) {
  const seed = await readJson<Seed | undefined>(join(host.chapter.dir, 'seed.json'), undefined)
  if (!seed) return
  const harness = host.harness()
  const state = await harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context)
  if (state?.applied === undefined) {
    const ultimate = await host.need(SubagentsApi).standing('ultimate', context)
    await harness.commit(async (tx) => {
      const receipt = await tx.doc(SeedState, ROOT_CONVERSATION_ID)
      if (receipt.applied !== undefined) return
      const memory = await document<{ memories: Record<string, MemoryItem> }>(
        host,
        tx,
        'lineage.memory',
      )
      Object.assign(memory.memories, seed.memories)
      const todos = await document<{ next: number; items: Todo[] }>(host, tx, 'todos')
      const carried: Seed['todos'] = [
        ...seed.todos,
        ...seed.questions.map(({ ref, text }) => ({
          owner: 'user' as const,
          text: `Open question (${seed.from.name}${ref}): ${text}`,
        })),
        // Project manifests are rediscovered by automations onOpen; user scripts need recreating.
        ...seed.scripts
          .filter((item) => item.scope !== 'project')
          .map(({ id, name, ask, prompt, agent }) => ({
            owner: 'ultimate' as const,
            text: `Recreate script ${id} (${name}): ${ask}${prompt ? ` · prompt: ${prompt}${agent ? ` (agent ${agent})` : ''}` : ''}`,
          })),
        ...seed.automations
          .filter((item) => !item.prompt)
          .map(({ name, schedule }) => ({
            owner: 'ultimate' as const,
            text: `Recreate schedule automation (${name}) with new subscribers: ${JSON.stringify(schedule)}`,
          })),
      ]
      for (const item of carried) todos.items.push({ ...item, id: todos.next++, at: Date.now() })
      // A real chapter wakes @ultimate with it: its first turn is what the wake-up side chat forks from. The gate's
      // preview only writes it, so no model runs there.
      await deliver(host, tx, ultimate, {
        type: seed.gate ? 'write' : 'input',
        session: seed.session,
        kind: 'dream.chapter',
        // The morning card shows where we came from and what came along; the old chapter's documents stay there.
        data: {
          from: seed.from,
          number: host.chapter.number,
          name: host.chapter.name,
          session: seed.session,
          learned: seed.journal.learned,
          carried: seed.counts,
        },
        content: chapterText(host, seed),
      })
      receipt.applied = Date.now()
    }, context)
  }
  const signal = new AbortController().signal
  for (const automation of seed.automations) {
    if (!automation.prompt) continue
    const receipt = await harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context)
    if (receipt?.automations.includes(automation.name)) continue
    if (seed.gate) {
      // The gate's preview runs against the real project: it checks each schedule but creates nothing that could fire.
      await host.invoke('automations', 'describe', { schedule: automation.schedule }, signal)
    } else {
      // Names are unique in a seed and the destination starts empty: a matching name is a create whose receipt was lost.
      // A rediscovered project script may share the name: only a schedule counts as the lost create.
      const current = (await host.invoke('automations', 'list', null, signal)) as {
        name: string
        schedule?: unknown
      }[]
      if (!current.some((item) => item.schedule && item.name === automation.name))
        await host.invoke('automations', 'create', automation, signal)
    }
    await harness.commit(async (tx) => {
      const saved = await tx.doc(SeedState, ROOT_CONVERSATION_ID)
      if (!saved.automations.includes(automation.name)) saved.automations.push(automation.name)
    }, context)
  }
  harness.resume()
}
