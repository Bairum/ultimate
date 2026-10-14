import { defineWebExtension, getConversation, getState } from '@/sdk'
import { Conversations, Seen } from './sidebar.tsx'
import { createConversation, NewDialog, newKeys } from './new-dialog.tsx'
import { openReset, ResetDialog, SummaryModelDialog, summaryModelDialog } from './dialogs.tsx'
import { SummaryAction } from './summary-entry.tsx'

export default defineWebExtension({
  entries: {
    'conversations.title-changed': SummaryAction,
    'conversations.intent-summarized': SummaryAction,
    'conversations.summarized': SummaryAction,
    'conversations.assessed': SummaryAction,
    'conversations.summary-discarded': SummaryAction,
  },
  slots: { sidebar: Conversations, overlay: [NewDialog, ResetDialog, SummaryModelDialog, Seen] },
  commands: [
    {
      id: 'conversations.new',
      title: 'New conversation',
      keys: newKeys,
      group: 'Conversations',
      run: (context) => createConversation(context),
    },
    {
      id: 'conversations.new-isolated',
      title: 'New isolated conversation',
      group: 'Conversations',
      run: (actions) => createConversation(actions, true),
    },
    {
      id: 'conversations.summary-model',
      title: 'Summary model…',
      group: 'Conversations',
      run: (actions) => actions.open(summaryModelDialog),
    },
    {
      id: 'conversations.reset',
      title: 'Clear the context',
      group: 'Conversations',
      when: () => {
        const { id, busy, entries } = getConversation()
        const summary = getState().conversations.find((conversation) => conversation.id === id)
        return (
          id !== undefined &&
          !busy &&
          entries.length > 0 &&
          summary?.parentConversationId === undefined
        )
      },
      run: (context) => {
        const { id } = getConversation()
        if (id !== undefined) openReset(context, id)
      },
    },
  ],
})
