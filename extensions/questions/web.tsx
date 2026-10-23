import { MessageCircleQuestionIcon } from 'lucide-react'
import { defineWebExtension, provide } from '@/sdk'
import { MessageAnswers } from '../messages/ui.tsx'
import { MessageQuestions } from './card.tsx'
import { Playground } from './playground.tsx'

export default defineWebExtension({
  entries: {
    // Retired cards have no interaction; hide them instead of exposing their raw JSON.
    'questions.asked': () => null,
    'questions.answers': () => null,
  },
  surfaces: [
    {
      id: 'questions.playground',
      title: 'Questions playground',
      icon: MessageCircleQuestionIcon,
      description: 'Every answer-card kind with sample data',
      order: 90,
      component: Playground,
    },
  ],
  commands: [
    {
      id: 'questions.open',
      title: 'Show open questions',
      run: (context) => context.openPanel('todos'),
    },
  ],
  provides: [provide(MessageAnswers, (message) => <MessageQuestions message={message} />)],
})
