import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, cn, getState, useDocOf, useStore, useSystem, useTasks, useUltimate } from '@/sdk'
import type { UltimateActions } from '@/sdk'
import { primaryAgent } from '../subagents/primary.ts'
import { emptyBoard, waitingOnUser } from '../board/data.tsx'
import type { BoardData } from '../board/data.tsx'
import type { QuestionsBoard } from '../questions/open.tsx'
import { phaseText, usePhase } from '../phase/chip.tsx'
import { useOverview } from './feature.tsx'

/** The home's primary standing agent: @sync in the machine home, else @ultimate. */
const primaryOf = (system: ReturnType<typeof useSystem>) =>
  system ? primaryAgent(system.project.root, system.machine.home) : 'ultimate'
export const usePrimaryAgent = () => primaryOf(useSystem())

/** Show the primary agent's standing conversation on the Agent surface: @ultimate starts branches and keeps tallies. */
export async function talkToUltimate(
  actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>,
) {
  const name = primaryOf(getState().system)
  const id = await api.action<number>('subagents', 'standing', { name })
  actions.switchConversation(id)
  actions.showSurface('agent')
}

/** How many of @ultimate's messages and final answers wait on the user's answer. */
export const useWaitingOnUser = () =>
  waitingOnUser(
    useDocOf<BoardData>(1, 'board') ?? emptyBoard,
    useDocOf<QuestionsBoard>(1, 'questions.board'),
  )

/** @ultimate's dot: pulsing while it works, amber while questions wait on you, else muted. */
export function UltimateDot({ working, waiting }: { working: boolean; waiting: number }) {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        working
          ? 'animate-pulse-dot bg-brand'
          : waiting
            ? 'bg-amber-400'
            : 'bg-muted-foreground/50',
      )}
    />
  )
}

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
  const id = useDocOf<Record<string, number>>(1, 'ultimate.standing-agents')?.[name]
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
          <UltimateDot waiting={waiting} working={working} />@{name}
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
