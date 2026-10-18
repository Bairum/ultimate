import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, useDocOf, useStore, useTasks, useUltimate } from '@/sdk'
import { BoardDoc, emptyBoard, waitingOnUser } from '../board/ui.tsx'
import { AgentMark, useOverview, usePrimaryAgent } from '../conversations/ui.tsx'
import { phaseText, usePhase } from '../phase/ui.tsx'
import { QuestionsDoc } from '../questions/ui.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'

/** How many of @ultimate's messages and final answers wait on the user's answer. */
export const useWaitingOnUser = () =>
  waitingOnUser(useDocOf(1, BoardDoc) ?? emptyBoard, useDocOf(1, QuestionsDoc))

/** A busy standing agent's word: its classified phase, lower case like its idle line, else "working". */
export function useWorkingWord(id: number | undefined, working: boolean) {
  const phase = usePhase(working ? id : undefined)
  return phase && phase !== 'waiting' ? phaseText(phase).toLowerCase() : 'working'
}

/** A busy standing agent's line in the sidebar: its working word in the brand colour. */
export function StandingPhase({ id }: { id: number }) {
  return <span className="shrink-0 text-brand">{useWorkingWord(id, true)}</span>
}

/** The title bar's way to @ultimate from every surface, with its state and the questions that wait on you. */
export function UltimateButton() {
  const actions = useUltimate()
  const name = usePrimaryAgent()
  const id = useDocOf(1, StandingDoc)?.[name]
  const tasks = useTasks()
  const runState = useOverview()[id ?? -1]?.runState
  const shown = useStore((state) => state.view?.conversation.id ?? state.requested)
  const waiting = useWaitingOnUser()
  const working =
    id !== undefined &&
    (runState === 'working' ||
      Object.values(tasks?.tasks ?? {}).some(
        (task) => !task.background && task.conversationId === id,
      ))
  const active = id !== undefined && shown === id && actions.surface === 'agent'
  const word = useWorkingWord(id, working)
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
          {waiting > 0 && <span className="text-amber-700 dark:text-amber-300">{waiting}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        Talk to @{name} · {label}
      </TooltipContent>
    </Tooltip>
  )
}
