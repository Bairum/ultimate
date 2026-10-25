import { ScanEyeIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import { AdvisorNoteCard } from './card.tsx'
import { Chip } from './chip.tsx'
import { AdvisorPanel } from './panel.tsx'
import { NoteNavigation, PANEL, openAdvisorPanel } from './parts.tsx'
import { NOTE_ENTRY } from './refs.ts'

export default defineWebExtension({
  entries: { [NOTE_ENTRY]: AdvisorNoteCard },
  slots: {
    'statusline.right': [{ component: Chip, order: -3, phone: true }],
    overlay: [NoteNavigation],
  },
  panels: [
    {
      id: PANEL,
      title: 'Advisor',
      icon: ScanEyeIcon,
      component: AdvisorPanel,
      // Opened from the chip, a card or ⌘K; it earns no tab while it has nothing to say.
      tab: false,
    },
  ],
  commands: [{ id: 'advisor.open', title: 'Advisor…', run: openAdvisorPanel }],
})
