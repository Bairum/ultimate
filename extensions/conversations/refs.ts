/**
 * Conversations in the browser: the overview of what each conversation is about, and the actions that rename,
 * conclude and resume conversations and pick the summary model. Browser-safe.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { KeptWork, OverviewState } from './types.ts'

/** The effective `summaryModel` setting and where it comes from. */
export type SummaryModelSetting = {
  value: unknown
  source: 'default' | 'user' | 'project'
  default: string
  /** The project's settings file, when it decides the model. */
  path?: string
}

/** Each conversation's summary, feature, activity and assessment, on conversation 1. */
export const OverviewDoc = docRef<OverviewState>('ultimate.conversation-overview')

/** `{ id, title }` → `{ ok }`: rename top-level conversation `id`; a blank title lets its first message name it again. */
export const RenameAction = actionRef<{ id: number; title: string }, { ok: boolean }>(
  'conversations',
  'rename',
)
/**
 * `{ ids }` → `{ concluded, kept }`: conclude these conversations and free their worktrees; `kept` lists the worktrees
 * kept because they are busy or hold unlanded work.
 */
export const ConcludeAction = actionRef<
  { ids: number[] },
  { concluded: number[]; kept: KeptWork[] }
>('conversations', 'conclude')
/** `{ ids }` → `{ resumed }`: resume these conversations and their ancestors; `resumed` lists the ones concluded before. */
export const ResumeAction = actionRef<{ ids: number[] }, { resumed: number[] }>(
  'conversations',
  'resume',
)
/** No arguments → the effective summary model setting. */
export const SummaryModelAction = actionRef<null, SummaryModelSetting>(
  'conversations',
  'summaryModel',
)
/**
 * `{ value }` → the new effective setting: set `summaryModel` ("provider/id[:thinking]") in the user's settings, or
 * remove it with `null`. Refuses while the project's settings decide it.
 */
export const SetSummaryModelAction = actionRef<{ value: string | null }, SummaryModelSetting>(
  'conversations',
  'setSummaryModel',
)
