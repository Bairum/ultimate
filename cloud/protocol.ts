// The sync WebSocket between one machine's Ultimate host and its cloud replica (a Durable Object).
//
// The machine owns the Pi Durable storage; the replica is a read copy plus an outbox. Data flows one way, machine to
// cloud, except outbox items, which the machine submits with `requestId: item.id` so Pi admits each exactly once.
//
// Order of a connection:
// 1. The machine connects to `/sync` with `Authorization: Bearer <token>` and sends `hello`.
// 2. The cloud answers `cursor`: the newest entry it holds and the hash of every document it holds.
// 3. The machine subscribes to commits first (buffering them), then sends catch-up `batch`es: every conversation
//    record, its own entries newer than `maxEntryId`, and every current conversation-scoped document whose hash differs
//    or which the cloud lacks (and a retirement, `value: null`, for one the cloud holds but the machine no longer has).
//    Then it flushes the buffered commits and keeps sending live `batch`es in commit order.
// 4. The cloud applies each batch atomically, in order, and answers `ack` with its `batch` number. The machine keeps at
//    most a few batches unacknowledged.
// 5. The cloud sends `outbox` with every undelivered item at connect and whenever one is added; the machine answers
//    `delivered` once Pi admitted the submission, and the cloud deletes the item.
//
// Entry IDs come from one counter allocated by Pi's serialized commits, so entries applied in commit order leave no gap
// below the replica's `maxEntryId`. Every message is idempotent: applying a record or document twice is harmless.

import type { ConversationRecord, EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import type { ConversationSummary, SystemInfo } from '../shared/protocol.ts'

/** The current value of one conversation-scoped Pi document incarnation, or its retirement. */
export interface ReplicaDoc {
  /** Pi DocumentId of the incarnation. */
  id: number
  kind: string
  /** Family member key; absent for singleton documents. */
  key?: string
  conversationId: number
  /** `null` retires the incarnation. */
  value: JsonObject | null
  /** `docHash(value)` computed by the machine; the cloud stores it and returns it in `cursor`. */
  hash: string
}

/** A prompt sent from the cloud UI while the machine was offline. */
export interface OutboxItem {
  /** UUID; the machine submits with it as `requestId`. */
  id: string
  conversationId: number
  text: string
  whenBusy?: 'steer' | 'followUp'
  createdAt: number
}

export type MachineMessage =
  | { type: 'hello'; machine: string; build: string }
  | {
      type: 'batch'
      batch: number
      conversations: ConversationRecord[]
      entries: EntryRecord[]
      docs: ReplicaDoc[]
    }
  | { type: 'summaries'; value: ConversationSummary[] }
  | { type: 'system'; value: SystemInfo }
  | { type: 'models'; value: unknown }
  | { type: 'delivered'; id: string; submissionId: number }

export type CloudMessage =
  | { type: 'cursor'; maxEntryId: number; docs: Record<string, string> }
  | { type: 'ack'; batch: number }
  | { type: 'outbox'; items: OutboxItem[] }

/** SHA-256 hex of the JSON text; works in Node and in Workers. */
export async function docHash(value: JsonObject | null): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
