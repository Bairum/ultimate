/** Subscriptions: start, stop and read supervised background scripts, and their durable lifecycle events. */
import { defineApi } from '../../shared/extension-api.ts'
import type { SubscriptionListItem } from './types.ts'

export type SubscriptionsService = {
  /**
   * Start subscription `id` (`S<n>`) from its current `run`, restarting a live process; `$SUBSCRIPTION_STATE` is kept.
   * Use it to resume a script that stopped itself with `DONE`. It commits, so call it outside a transaction: from a
   * reactor, do not await it.
   */
  start(id: string): Promise<SubscriptionListItem>
  /** Stop subscription `id` and terminate its process group; the same as the `stop` action. Commits, like `start`. */
  stop(id: string): Promise<SubscriptionListItem>
  /** Subscription `id` as `list` returns it, with `state`, `enabled` and whether its process is `alive`. */
  status(id: string): Promise<SubscriptionListItem>
}
/** Start, stop and read subscriptions; optional, so `want` it. */
export const SubscriptionsApi = defineApi<SubscriptionsService>()('subscriptions')
export { Fired, Started, Exited, Escalated, Done } from './refs.ts'
