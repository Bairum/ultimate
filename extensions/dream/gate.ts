import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { JsonValue } from '@earendil-works/chord'
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { chapterFiles, requestChapter } from '../../lib/chapters.ts'
import { postAction } from '../../lib/remote.ts'
import type { InstanceService } from '../instance/api.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import type { GateResult } from './refs.ts'
import { writeSeed } from './seed.ts'
import type { Seed } from './types.ts'

/** Memory briefs have no lineage cap. Use 6k tokens, the same envelope as lineage's tally catch-up budget. */
export const BRIEF_BUDGET = 6000

/**
 * lineage/memory.ts memoryBrief for a fresh root: its sorted index and read instructions, with no recent landings.
 * Lineage only publishes tally.briefTokens once a root has branched (Tally.since), so a new chapter must measure this
 * directly. Keep this format in step with memoryBrief; the gate tests compare the two.
 */
function freshBriefTokens(memories: Record<string, MemoryItem>) {
  if (!Object.keys(memories).length) return 0
  return estimateTextTokens(
    [
      '<project_memory root="#1">',
      ...Object.keys(memories)
        .toSorted()
        .map((slug) => {
          const { kind, line, updated } = memories[slug]
          return `${slug} [${kind}] — ${line} (updated ${new Date(updated).toISOString().slice(0, 10)})`
        }),
      '</project_memory>',
      'The full project context (every branch, abstract and landing) is root #1: read it with codemode `ultimate.entries(1)` or `ultimate.search(text)`; read a memory with `memory {read: slug}`; `git log` has the commits.',
    ].join('\n'),
  )
}

/** Boot the actual seed in a disposable home and inspect its API, without asking a model. */
export async function gate(
  seed: Seed,
  chapter: string,
  instances: InstanceService,
): Promise<GateResult> {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-dream-gate-'))
  const checks: GateResult['checks'] = []
  let instance: { id: string; url: string } | undefined
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })
  try {
    await writeSeed(chapterFiles(home, chapter).dir, { ...seed, gate: true })
    await requestChapter(home, chapter)
    instance = await instances.start({ home })
    check('boot', true, 'Instance API is ready')
    const target = { url: instance.url, label: 'Chapter gate' }
    const doc = <T>(kind: string) =>
      postAction(target, 'codemode', 'read', { op: 'doc', args: [kind, 1] }) as Promise<T>
    const memory = await doc<{ memories: Record<string, MemoryItem> }>('lineage.memory')
    const todos = await doc<{ items: { done?: number }[] }>('todos')
    // The preview creates no automation that could fire against the real project; it checks each and records it.
    const automations = (await doc<{ automations: string[] }>('dream.seed')).automations
    const standing = await doc<{ ultimate?: number }>('ultimate.standing-agents')
    const count = (name: string, actual: number, expected: number) =>
      check(name, actual === expected, `${actual} present; expected ${expected}`)
    count('memories', Object.keys(memory.memories).length, seed.counts.memories)
    count(
      'todos',
      todos.items.filter((item) => item.done === undefined).length,
      seed.counts.todos +
        seed.counts.questions +
        seed.subscriptions.filter((item) => item.scope !== 'project').length,
    )
    count('automations', automations.length, seed.counts.automations)
    // Passive entry delivery runs after the seed commit. Wait only for that local effect, not a model.
    const deadline = Date.now() + 10_000
    let entries: unknown[] = []
    do {
      if (standing.ultimate !== undefined)
        entries = (await postAction(target, 'codemode', 'read', {
          op: 'search',
          args: ['"kind":"dream.chapter"', { conversationId: standing.ultimate, limit: 1 }],
        } satisfies JsonValue)) as unknown[]
      if (entries.length) break
      if (Date.now() >= deadline) break
      await sleep(100)
    } while (Date.now() < deadline)
    check(
      'chapter entry',
      entries.length > 0,
      entries.length ? 'Found in @ultimate' : 'No dream.chapter entry in @ultimate',
    )
    const tokens = freshBriefTokens(memory.memories)
    check('memory brief', tokens <= BRIEF_BUDGET, `${tokens} tokens; budget ${BRIEF_BUDGET}`)
  } catch (error) {
    check(instance ? 'inspection' : 'boot', false, String(error))
  } finally {
    try {
      if (instance) await instances.stop(instance.id)
    } catch (error) {
      check('stop', false, String(error))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
  return { ok: checks.every((item) => item.ok), checks }
}
