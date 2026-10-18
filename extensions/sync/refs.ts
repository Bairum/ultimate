/**
 * Sync in the browser: the link from a project's home to this machine's home, and the progress of a project's move.
 * Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'
import type { Transition } from '../../cloud/protocol.ts'

/** Project homes: no arguments → `{ url }` of this machine's running machine home, or null while it is not running. */
export const HomeAction = actionRef<null, { url: string } | null>('sync', 'home')
/**
 * Machine home: `{ project }` → `{ transition, machine }`: the project's current move for its move card (null without
 * one), from its local server or the cloud, and this machine's name.
 */
export const TransitionAction = actionRef<
  { project: string },
  { transition: Transition | null; machine: string }
>('sync', 'transition')
