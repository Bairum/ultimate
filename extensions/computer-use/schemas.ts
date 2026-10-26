import { Type } from '@earendil-works/pi-ai'
import type { Static, TSchema } from '@earendil-works/pi-ai'
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import { normalizeArguments } from './policy.ts'
export const windowSchema = Type.Optional(Type.Union([Type.String(), Type.Integer()]))

export const predicates = Type.Array(Type.Record(Type.String(), Type.Any()))

export function prepare(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return normalizeArguments(raw)
  const args = raw as Record<string, unknown>
  return {
    ...args,
    ...(Array.isArray(args.actions) ? { actions: args.actions.map(normalizeArguments) } : {}),
  }
}

/**
 * One model-facing object for a tool whose arguments are a union of `{action, …}` objects: `action` stays required,
 * every other field becomes optional, with the union of its branch schemas when they differ. Provider adapters keep
 * only a root object's `properties` (Anthropic's drops a root `anyOf` whole), so a union root reaches the model as no
 * parameters and every object argument arrives as a string. Check the arguments against the union with `checkAction`.
 */
export function actionObject(branches: { properties: Record<string, TSchema> }[]) {
  const fields = new Map<string, TSchema[]>()
  for (const branch of branches)
    for (const [key, schema] of Object.entries(branch.properties)) {
      const list = fields.get(key) ?? []
      if (!list.some((known) => JSON.stringify(known) === JSON.stringify(schema))) list.push(schema)
      fields.set(key, list)
    }
  return Type.Object(
    Object.fromEntries(
      [...fields].map(([key, list]) => {
        const schema = list.length === 1 ? list[0] : Type.Union(list)
        return [key, key === 'action' ? schema : Type.Optional(schema)]
      }),
    ),
  )
}

/** `args` checked against the exact per-action union, with the validator's message when no branch fits. */
export function checkAction<S extends TSchema>(
  name: string,
  union: S,
  args: unknown,
): { ok: true; args: Static<S> } | { ok: false; message: string } {
  try {
    const checked = validateToolArguments(
      { name, description: '', parameters: union },
      { type: 'toolCall', id: name, name, arguments: args as Record<string, never> },
    ) as Static<S>
    return { ok: true, args: checked }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
