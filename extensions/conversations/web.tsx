import { defineWebExtension } from '@/sdk'
import { Conversations, Seen } from './sidebar.tsx'
import { SummaryModelDialog, summaryModelDialog } from './dialogs.tsx'
import { SummaryAction } from './summary-entry.tsx'
import { UltimateButton } from './ultimate.tsx'
import { MentionLink } from './mention.tsx'

export default defineWebExtension({
  link: MentionLink,
  entries: {
    'conversations.title-changed': SummaryAction,
    'conversations.intent-summarized': SummaryAction,
    'conversations.summarized': SummaryAction,
    'conversations.assessed': SummaryAction,
    'conversations.summary-discarded': SummaryAction,
  },
  slots: {
    sidebar: Conversations,
    // Last in the title bar's left side, beside the surfaces.
    'titlebar.left': [{ component: UltimateButton, order: 100 }],
    overlay: [SummaryModelDialog, Seen],
  },
  commands: [
    {
      id: 'conversations.summary-model',
      title: 'Summary model…',
      group: 'Conversations',
      run: (actions) => actions.open(summaryModelDialog),
    },
  ],
})
