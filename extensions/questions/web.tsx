import { MessageCircleQuestionIcon } from 'lucide-react'
import { defineWebExtension, provide } from '@/sdk'
import { MessageAnswers } from '../board/ui.tsx'
import { MessageQuestions } from './card.tsx'
import { OpenQuestions } from './panel.tsx'

export default defineWebExtension({
  entries: {
    // Retired cards have no interaction; hide them instead of exposing their raw JSON.
    'questions.asked': () => null,
    'questions.answers': () => null,
  },
  panels: [
    {
      id: 'questions',
      title: 'Questions',
      icon: MessageCircleQuestionIcon,
      component: OpenQuestions,
      order: -5,
    },
  ],
  commands: [
    {
      id: 'questions.open',
      title: 'Show open questions',
      run: (context) => context.openPanel('questions'),
    },
  ],
  provides: [provide(MessageAnswers, (message) => <MessageQuestions message={message} />)],
})
