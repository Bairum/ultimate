import { Type } from '@earendil-works/pi-ai'
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
