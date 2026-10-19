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

/** Where a join stopped: checking the cloud (and the input), saving the two secrets, or saving the settings. */
export type JoinStep = 'check' | 'secrets' | 'settings'
export type JoinResult =
  | { ok: true; url: string; host: string; machine: string; projects: string[] }
  | { ok: false; step: JoinStep; error: string }
/** This machine's cloud sync setup, without secret values. */
export interface JoinState {
  /** Set when `cloud.url` and both secrets are. */
  joined?: { url: string; host: string; machine: string }
  /** `cloud.url`, when set. */
  url?: string
  /** `cloud.machine`, else the hostname. */
  machine: string
  /** The secret names this machine lacks. */
  missing: string[]
}
/** No arguments → whether this machine has joined the fleet, for the Join card. */
export const JoinStateAction = actionRef<null, JoinState>('sync', 'joinState')
/**
 * User-only: `{ url, machine, token, snapshotKey }` → checks `GET /sync/directory` with the token, then stores both
 * secrets and `cloud.url`/`cloud.machine` in the user's settings; nothing is stored when a step before fails.
 */
export const JoinAction = actionRef<
  { url: string; machine: string; token: string; snapshotKey: string },
  JoinResult
>('sync', 'join')
