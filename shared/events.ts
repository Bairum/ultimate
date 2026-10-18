import type { JsonValue } from '@earendil-works/chord'

/** Ids of the work an event happened in, from the call trace: a reactor's run continues `traceId` under `parentCall`. */
export type EventContext = {
  traceId?: string
  conversationId?: number
  taskId?: number
  entryId?: number
  parentCall?: string
}

/** One durable event as readers and reactors see it: `id` is its entry in the event log and gives one global order. */
export type EventRecord<D extends JsonValue = JsonValue> = {
  id: number
  name: string
  kind: string
  /** The version of the event's data shape when it was emitted. */
  v: number
  at: string
  data: D
  context?: EventContext
}

/** A typed event: `name` like `workspaces.landed`, stored as entry kind `event.<name>`. Plain data, browser-safe. */
export interface EventToken<D extends JsonValue = JsonValue> {
  readonly name: string
  readonly kind: string
  readonly version: number
  is(event: EventRecord | undefined): event is EventRecord<D>
}

/** The data of a token, or the union over a union of tokens. */
export type EventData<T> = T extends EventToken<infer D extends JsonValue> ? D : never

export function defineEvent<D extends JsonValue>(
  name: string,
  options: { version?: number } = {},
): EventToken<D> {
  const kind = `event.${name}`
  return {
    name,
    kind,
    version: options.version ?? 1,
    is: (event): event is EventRecord<D> => event?.kind === kind,
  }
}

/** A notice an extension showed (`host.notice`), recorded once per distinct message and facet load. */
export const NoticeEvent = defineEvent<{ extension: string; message: string; level: string }>(
  'ultimate.notice',
)

/** Root document with the newest events, which `useEvents()` streams to the browser. */
export const EVENT_FEED = 'ultimate.event-feed'
export const EVENT_FEED_SIZE = 100
