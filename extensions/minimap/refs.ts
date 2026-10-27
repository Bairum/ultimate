/** The minimap's marks for the browser. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** What a mark stands for; the rail draws each kind its own way. */
export type MarkKind =
  | 'user'
  | 'answer'
  | 'message'
  | 'branch'
  | 'landed'
  | 'failed'
  | 'submit'
  | 'commit'
  | 'preview'
  | 'subagent'
  | 'report'
  | 'screenshot'
  | 'restart'
  | 'compaction'

/** One mark: the conversation's entry it reveals, its kind, a line of text and when it happened (ms), when known. */
export interface Mark {
  entry: number
  kind: MarkKind
  text: string
  at?: number
}

/** `{ conversationId }` → every mark of that conversation's own history, oldest first. */
export const MarksAction = actionRef<{ conversationId: number }, Mark[]>('minimap', 'marks')
