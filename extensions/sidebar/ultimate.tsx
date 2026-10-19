import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, Provided, useDocOf, useStore, useTasks, useUltimate } from '@/sdk'
import { AnswerWaits, BoardDoc, emptyBoard, waitingOnUser } from '../board/ui.tsx'
import { AgentMark, ConversationPhase, useOverview, usePrimaryAgent } from '../conversations/ui.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'

/** Renders with how many of @ultimate's messages and final answers wait on the user's answer. */
export function WaitingOnUser({ children }: { children: (waiting: number) => ReactNode }) {
  const board = useDocOf(1, BoardDoc) ?? emptyBoard
  return (
    <Provided input={null} point={AnswerWaits}>
      {(asks) => children(waitingOnUser(board, asks))}
    </Provided>
  )
}

/** A busy standing agent's word: its classified phase, lower case like its idle line, else "working". */
const workingWord = (phase: { word: string; waiting: boolean } | undefined) =>
  phase && !phase.waiting ? phase.word : 'working'

/** A busy standing agent's line in the sidebar: its working word in the brand colour. */
export function StandingPhase({ id }: { id: number }) {
  return (
    <Provided input={id} point={ConversationPhase}>
      {(phase) => <span className="shrink-0 text-brand">{workingWord(phase)}</span>}
    </Provided>
  )
}

/** The title bar's way to @ultimate from every surface, with its state and the questions that wait on you. */
export function UltimateButton() {
  const actions = useUltimate()
  const name = usePrimaryAgent()
  const id = useDocOf(1, StandingDoc)?.[name]
  const tasks = useTasks()
  const runState = useOverview()[id ?? -1]?.runState
  const shown = useStore((state) => state.view?.conversation.id ?? state.requested)
  const working =
    id !== undefined &&
    (runState === 'working' ||
      Object.values(tasks?.tasks ?? {}).some(
        (task) => !task.background && task.conversationId === id,
      ))
  const active = id !== undefined && shown === id && actions.surface === 'agent'
  return (
    <WaitingOnUser>
      {(waiting) => (
        <Provided input={working ? id : undefined} point={ConversationPhase}>
          {(phase) => {
            const word = workingWord(phase)
            const label = working ? word : waiting ? `${waiting} waiting on you` : 'idle'
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-current={active ? 'page' : undefined}
                    aria-label={`Talk to @${name} (${label})`}
                    className={cn(
                      'flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
                      active && 'text-foreground',
                    )}
                    data-ultimate-button
                    onClick={() => void talkToUltimate(actions)}
                    type="button"
                  >
                    <AgentMark
                      name={name}
                      presence={working ? 'working' : waiting ? 'waiting' : undefined}
                      size="sm"
                    />
                    @{name}
                    {working && word !== 'working' && <span className="text-brand">{word}</span>}
                    {waiting > 0 && (
                      <span className="text-amber-700 dark:text-amber-300">{waiting}</span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  Talk to @{name} · {label}
                </TooltipContent>
              </Tooltip>
            )
          }}
        </Provided>
      )}
    </WaitingOnUser>
  )
}
