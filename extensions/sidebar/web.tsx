import { defineWebExtension } from '@/sdk'
import { Conversations, Seen } from './sidebar.tsx'
import { UltimateButton } from './ultimate.tsx'

export default defineWebExtension({
  slots: {
    sidebar: Conversations,
    // Last in the title bar's left side, beside the surfaces.
    'titlebar.left': [{ component: UltimateButton, order: 100 }],
    overlay: [Seen],
  },
})
