import type { JsonValue } from '@earendil-works/chord'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ComputerDetails, ActStepDetails } from './refs.ts'
import { readSession } from './session.ts'
import { redactor } from './content.ts'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const strings = (value: unknown) =>
  Object.values(record(value)).filter((v): v is string => typeof v === 'string')

/** Add card data without changing either model output or the program-facing result. */
export async function withDetails<T extends { structuredOutput?: JsonValue; details?: unknown }>(
  host: ExtensionHost,
  conversation: number,
  name: string,
  args: unknown,
  value: T,
) {
  const session = await readSession(host, conversation)
  const state = session.task
  const input = record(args)
  const actions = Array.isArray(input.actions) ? input.actions.map(record) : []
  const params = [
    ...Object.values(state?.spec.scope.params ?? {}),
    ...Object.values(state?.pendingChange?.scope?.params ?? {}),
    ...strings(record(input.goal).params),
    ...strings(record(record(input.spec).scope).params),
    ...strings(record(input.scope).params),
    ...actions.flatMap((action) =>
      [action.text, action.value].filter((v): v is string => typeof v === 'string'),
    ),
  ]
  const raw = record(value.structuredOutput)
  // A plain Driver reply (listings, launches) carries `ok` and `refusal` instead of a status: name one, so a refused or
  // failed reply never renders as a success.
  const refusal = record(raw.refusal)
  const data =
    typeof raw.status !== 'string' && typeof raw.ok === 'boolean'
      ? {
          ...raw,
          status: raw.ok ? 'ok' : typeof refusal.code === 'string' ? refusal.code : 'failed',
          ...(raw.ok
            ? {}
            : {
                message:
                  typeof refusal.message === 'string'
                    ? refusal.message
                    : typeof raw.text === 'string'
                      ? raw.text.slice(0, 500)
                      : undefined,
              }),
        }
      : raw
  const details = record(value.details)
  const active = state?.subgoals.find((s) => s.status === 'active')
  const task: ComputerDetails['task'] = state
    ? {
        id: state.spec.id,
        status: state.status,
        subgoal: active ? { id: active.id, text: active.text } : null,
        subgoals: state.subgoals.length,
        criteria: { met: state.criteriaMet?.length ?? 0, total: state.spec.criteria.length },
        steps: { used: state.counters.steps, limit: state.spec.stop.steps },
        lastCheck: state.ledger.findLast((entry) => entry.kind === 'checkpoint')?.reason,
      }
    : null
  if (name === 'computer_act' && !details.act) {
    details.act = {
      mode: input.goal ? 'goal' : 'explicit',
      decisions: [],
      steps: actions.map((action, index): ActStepDetails => ({
        kind: action.kind as ActStepDetails['kind'],
        status: index ? 'not_run' : 'refused',
        ...(!index && typeof data.status === 'string' ? { code: data.status } : {}),
        ...(!index && typeof data.message === 'string' ? { message: data.message } : {}),
      })),
    }
  }
  if (name !== 'computer_act' && !details.observe)
    details.summary = { value: data.structured ?? value.structuredOutput ?? null, untrusted: true }
  const redact = redactor(params)
  const safe = JSON.parse(
    JSON.stringify(
      {
        ...details,
        task,
        ...(typeof data.status === 'string' ? { status: data.status } : {}),
        ...(typeof data.message === 'string' ? { message: data.message } : {}),
      },
      // Protocol enums are not payload echoes; keep them usable by card renderers.
      (key, v: unknown) =>
        typeof v === 'string' &&
        !['kind', 'status', 'mode', 'verdict', 'outcome', 'escalationReason', 'role'].includes(key)
          ? redact(v)
          : v,
    ),
  ) as ComputerDetails
  return { ...value, details: safe }
}
