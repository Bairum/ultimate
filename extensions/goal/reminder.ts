/**
 * The goal reminder: an automation that wakes @ultimate every 30 minutes while a goal is open, so a stalled goal never
 * waits silently. Every goal change (start, pause, resume, end) creates a sync task in its own commit; the task brings
 * the automation in line with the goal as it is when the task runs. A crash leaves at most a task to rerun, and a rerun
 * finds the automation an earlier try made by its name instead of making a second one.
 */
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationDocToken, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AutomationsApi } from '../automations/api.ts'
import type { Automation } from '../automations/refs.ts'
import { Standing } from '../subagents/api.ts'
import type { Goal } from './refs.ts'

export const SCHEDULE = 'every 30m'
/** Each goal's reminder has its own name: a rerun adopts it, and no goal touches another's. */
export const reminderName = (goal: number) => `Goal reminder · goal ${goal}`

/**
 * Steps at most: each makes one change (delete a stray, create, link, pause or resume) and looks again, so a pause and
 * resume that race still end on the newest goal.
 */
const STEPS = 6

type Goals = ConversationDocToken<{ next: number; goals: Goal[] }>

export function reminderTask(host: ExtensionHost, Goals: Goals) {
  const find = async (tx: Tx, id: number) =>
    (await tx.doc(Goals, ROOT_CONVERSATION_ID)).goals.find((item) => item.id === id)
  /** One look: the change it made, or undefined once the automation matches the goal. */
  async function step(id: number) {
    const automations = host.need(AutomationsApi)
    const { goal, ultimate } = await host.harness().commit(
      async (tx) => ({
        // A plain copy: the document's overlay is unusable after the commit.
        goal: await find(tx, id).then(
          (found) => found && (JSON.parse(JSON.stringify(found)) as Goal),
        ),
        ultimate: (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate,
      }),
      context,
    )
    const list = (await host.invoke(
      'automations',
      'list',
      null,
      new AbortController().signal,
    )) as Automation[]
    const named = list.filter((item) => item.name === reminderName(id) && !item.prompt)
    const open = goal && !goal.ended
    const own = open
      ? (named.find((item) => item.id === goal.reminder) ?? (goal.reminder ? undefined : named[0]))
      : undefined
    const extra = named.find((item) => item !== own)
    if (extra) return automations.delete(extra.id)
    // One the user deleted in the Automations panel stays deleted.
    if (open && !own && !goal.reminder && ultimate !== undefined)
      return automations.create({
        name: reminderName(id),
        schedule: SCHEDULE,
        subscribers: [ultimate],
      })
    if (!own || !goal) return undefined
    if (goal.reminder !== own.id)
      return host.harness().commit(async (tx) => {
        const current = await find(tx, id)
        if (current) current.reminder = own.id
      }, context)
    if (own.enabled === !!goal.waiting)
      return goal.waiting ? automations.pause(own.id) : automations.resume(own.id)
    return undefined
  }
  return defineTask<{ goal: number }, { phase: 'sync' }, null>({
    name: 'goal.reminder',
    version: 1,
    initial: () => ({ phase: 'sync' }),
    phases: {
      sync: async (task, runtime, ctx) => {
        for (let i = 0; i < STEPS; i++) if ((await step(task.input.goal)) === undefined) break
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
