import { defineWebExtension } from '@/sdk'
import { Line, Operate, QuestionCard } from './cards.tsx'

export default defineWebExtension({
  tools: { codex_operate: Operate },
  toolLines: { codex_operate: Line },
  entries: {
    'codex-computer.question': QuestionCard,
    // Codex's milestones are context for the parent agent; the running card already lists them.
    'codex-computer.progress': () => null,
  },
})
