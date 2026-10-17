// The sync WebSocket between one machine's Ultimate host and its cloud replica (a Durable Object).
//
// The machine owns the Pi Durable storage; the replica is a read copy plus an outbox. Data flows one way, machine to
// cloud, except outbox items, which the machine submits with `requestId: item.id` so Pi admits each exactly once.
//
// Order of a connection:
// 1. The machine connects to `/sync?machine=<name>&project=<absolute root>` with
//    `Authorization: Bearer <token>` and sends `hello` with the same identity and its local HTTP port.
//    Each machine/project has its own replica; a mismatched hello closes with `PROJECT_MISMATCH`.
//    The machine then stops reconnecting and tells the user,
//    since retrying cannot succeed.
// 2. The cloud answers `cursor`: per conversation, the newest of its own entries it holds, and the hash of every
//    document it holds.
// 3. The machine subscribes to commits first (buffering them), then sends catch-up `batch`es, reading page by page
//    outside any commit and never more than the unacknowledged window ahead: every conversation record, each
//    conversation's own entries newer than its cursor value in ascending order, and every current conversation-scoped
//    document whose hash differs or which the cloud lacks (and a retirement, `value: null`, for one the cloud holds but
//    the machine no longer has). Then it flushes the buffered commits and keeps sending live `batch`es in commit order.
// 4. The cloud applies each batch atomically, in order, and answers `ack` with its `batch` number. The machine keeps at
//    most a few batches unacknowledged.
// 5. The cloud sends `outbox` with every undelivered item at connect and whenever one is added; the machine answers
//    `delivered` once Pi admitted the submission, and the cloud deletes the item.
//
// Entry IDs come from one counter allocated by Pi's serialized commits, so each conversation's entries arrive in
// ascending order, catch-up and live alike, and a conversation's cursor value never has a gap below it, even when a
// connection drops in the middle of catch-up. Every message is idempotent: applying a record or document twice is
// harmless.

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

export const PROJECT_MISMATCH = 4009

export type MachineMessage =
  | {
      type: 'hello'
      machine: string
      build: string
      uiBuild?: string
      port: number
      /** Absolute project root. Pi IDs are per project, so one replica must never mix two. */
      project: string
    }
  | {
      type: 'batch'
      batch: number
      conversations: ConversationRecord[]
      entries: EntryRecord[]
      docs: ReplicaDoc[]
    }
  /** Full replacement once per connection, then upserts and removed IDs only. */
  | { type: 'summaries'; value: ConversationSummary[]; removed: number[]; full: boolean }
  | { type: 'uiBuild'; value: string }
  | { type: 'system'; value: SystemInfo }
  | { type: 'models'; value: unknown }
  | { type: 'delivered'; id: string; submissionId: number }

export type CloudMessage =
  | {
      type: 'cursor'
      /** Conversation ID to the newest of its own entries the replica holds; absent conversations hold none. */
      entries: Record<string, number>
      /** Document ID to the hash the replica holds. */
      docs: Record<string, string>
    }
  | { type: 'ack'; batch: number }
  | { type: 'outbox'; items: OutboxItem[] }

/** SHA-256 hex of the JSON text; works in Node and in Workers. */
export async function docHash(value: JsonObject | null): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
