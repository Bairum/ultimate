/** Subscriptions: background script state, browser operations, and lifecycle events. */
import { actionRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { CreateArgs, Subscription, SubscriptionListItem } from './types.ts'

/** `{ ask, title?, once?, secrets?, subscribers? }` → the new subscription; caller is also subscribed. */
export const CreateAction = actionRef<CreateArgs, Subscription>('subscriptions', 'create')
/** No arguments → subscriptions including process-local `alive`. */
export const ListAction = actionRef<null, SubscriptionListItem[]>('subscriptions', 'list')
/** `{ id, to? }` → subscription; `to` is #id or @name, default caller. */
export const SubscribeAction = actionRef<{ id: string; to?: string }, Subscription>(
  'subscriptions',
  'subscribe',
)
/** `{ id, to? }` → subscription after removing that subscriber. */
export const UnsubscribeAction = actionRef<{ id: string; to?: string }, Subscription>(
  'subscriptions',
  'unsubscribe',
)
/** `{ id }` → subscription after starting its current executable `run`. */
export const StartAction = actionRef<{ id: string }, Subscription>('subscriptions', 'start')
/** `{ id }` → stopped subscription; terminates the process group. */
export const StopAction = actionRef<{ id: string }, Subscription>('subscriptions', 'stop')
/** `{ id, lines? }` → last lines of output.log (default 50, maximum 2000). */
export const LogAction = actionRef<{ id: string; lines?: number }, { text: string }>(
  'subscriptions',
  'log',
)
/** `{ id }` → the executable's `path` and its `text` (first 64 KiB; empty while not written yet). */
export const ScriptAction = actionRef<{ id: string }, { path: string; text: string }>(
  'subscriptions',
  'script',
)
/** `{ id, reason }` → failed subscription; notifies @ultimate and subscribers. */
export const EscalateAction = actionRef<{ id: string; reason: string }, Subscription>(
  'subscriptions',
  'escalate',
)
/** `{ id }` → removed id; files and agent conversation remain. */
export const DeleteAction = actionRef<{ id: string }, { id: string }>('subscriptions', 'delete')
/** A stdout FIRE line was committed; `fire` is the subscription's lifetime count. */
export const Fired = defineEvent<{ id: string; text: string; fire: number }>('subscriptions.fired')
/** The supervised executable started. */
export const Started = defineEvent<{ id: string; pid: number }>('subscriptions.started')
/** The executable exited; null code denotes termination by signal or a spawn error. */
export const Exited = defineEvent<{ id: string; code: number | null; signal?: string }>(
  'subscriptions.exited',
)
/** A script printed `DONE [text]` and exited 0: it is stopped, without a failure or a wake; `start` resumes it. */
export const Done = defineEvent<{ id: string; text?: string }>('subscriptions.done')
/** Recovery failed and the subscription agent escalated. */
export const Escalated = defineEvent<{ id: string; reason: string }>('subscriptions.escalated')
