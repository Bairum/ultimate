import { defineWebExtension } from '@/sdk'
import { ReplyQuestions } from './card.tsx'

export default defineWebExtension({
  entries: {
    'pi.assistant': ReplyQuestions,
    // Retired cards have no interaction; hide them instead of exposing their raw JSON.
    'questions.asked': () => null,
    'questions.answers': () => null,
  },
})
