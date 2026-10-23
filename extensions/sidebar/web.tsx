import { defineWebExtension } from '@/sdk'
import { Conversations, Seen } from './sidebar.tsx'
import { UltimateButton } from './ultimate.tsx'

export default defineWebExtension({
  slots: {
    sidebar: Conversations,
    // Phones only, where the sidebar with @ultimate's row is hidden; last in the title bar's left side.
    'titlebar.left': [{ component: UltimateButton, order: 100 }],
    overlay: [Seen],
  },
})
