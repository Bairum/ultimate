import { defineWebExtension, provide, useDocOf } from '@/sdk'
import { AnswerWaits, MessageAnswers } from '../board/ui.tsx'
import { MessageQuestions, ReplyQuestions } from './card.tsx'
import { QuestionsDoc } from './refs.ts'

/** @ultimate's asking final answer waits on you once, whatever its number of questions. */
const useAnswerWaits = () => !!useDocOf(1, QuestionsDoc)?.reply

export default defineWebExtension({
  entries: {
    'pi.assistant': ReplyQuestions,
    // Retired cards have no interaction; hide them instead of exposing their raw JSON.
    'questions.asked': () => null,
    'questions.answers': () => null,
  },
  provides: [
    provide(MessageAnswers, (message) => <MessageQuestions message={message} />),
    provide(AnswerWaits, useAnswerWaits),
  ],
})
