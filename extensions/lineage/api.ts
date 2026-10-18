/**
 * Lineage: the project's conversation trees. Roots keep a tally of what happened, branches fork from them for one
 * feature or fix, and notes carry news between conversations without waking them.
 */
import type { Context } from '@earendil-works/chord'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type {
  AbstractInput,
  BranchInput,
  branchOf,
  leaveNote,
  rootOf,
  startBranch,
} from './server.ts'

/** The project's roots, each the top of one conversation tree; a fresh project's first conversation is its first. */
export const Roots = defineDoc<{ roots: number[] }>({
  kind: 'lineage.roots',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ roots: [ROOT_CONVERSATION_ID] }),
})

export type BranchState = { from: number; at: number; intent: string }
/**
 * A branch's origin and prompt, written in its forking commit; absent on roots and on conversations made otherwise.
 * Read it to tell a lineage branch from other conversations, before its first run.
 */
export const Branch = defineDoc<{ branch?: BranchState }>({
  kind: 'lineage.branch',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export type LineageService = {
  /** Start a branch from conversation `input.from` with its prompt as first input; returns the new conversation id. */
  branch: (input: BranchInput, ctx: Context) => ReturnType<typeof startBranch>
  /** The root of the tree conversation `id` belongs to, or undefined outside any tree. */
  rootOf: (id: number, ctx: Context) => ReturnType<typeof rootOf>
  /** Leave `text` in conversation `to` (or the root of the source's tree) for its next turn, without waking it. */
  leaveNote: (
    to: number | 'root',
    text: string,
    source?: Parameters<typeof leaveNote>[3],
  ) => ReturnType<typeof leaveNote>
  /** The root whose tally lists top-level conversation `id`, with its branch intent; undefined for roots and others. */
  branchOf: (id: number, ctx: Context) => ReturnType<typeof branchOf>
  /** Write the abstract of conversation `id` into its tree root's tally inside `tx`; a no-op outside a tree. */
  abstract: (tx: Tx, id: number, input: AbstractInput) => Promise<void>
}
/**
 * A branch started: conversation `id` forked from `from` at entry `at`, its prompt `intent`. Emitted in the forking
 * commit, before the branch's first run; react to it to set up a new branch's own state.
 */
export const Branched = defineEvent<{ id: number; from: number; at: number; intent: string }>(
  'lineage.branched',
)
/** A root was created: conversation `id`, titled `intent`. Emitted in the creating commit. */
export const Rooted = defineEvent<{ id: number; intent: string }>('lineage.rooted')

/** Trees, branches and notes; core, so `need` it. */
export const LineageApi = defineApi<LineageService>()('lineage')
