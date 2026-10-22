import { createContext, useEffect } from 'react'
import type { ReactNode } from 'react'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { store } from './client.ts'

export const ConversationIdContext = createContext<number | undefined>(undefined)
/** The entries loaded by the nearest transcript or composer; a new scope resets inherited history. */
export const TranscriptContext = createContext<readonly EntryRecord[] | undefined>(undefined)

/**
 * Give descendants their own live conversation without switching the shell's shown conversation.
 * Hooks and transcript/composer contributions inherit this id; commands and the imperative `api` stay global.
 * Scopes of the same id share a stream, released when the last scope unmounts.
 */
export function ConversationScope({ id, children }: { id: number; children: ReactNode }) {
  useEffect(() => store.watchConversation(id), [id])
  return (
    <ConversationIdContext value={id}>
      <TranscriptContext value={undefined}>{children}</TranscriptContext>
    </ConversationIdContext>
  )
}
