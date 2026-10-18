import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, cn, useDocOf, useStore, useTasks, useUltimate } from '@/sdk'
import type { UltimateActions } from '@/sdk'
import { emptyBoard, waitingOnUser } from '../board/data.tsx'
import type { BoardData } from '../board/data.tsx'
import { useOverview } from './feature.tsx'

/** Show @ultimate's standing conversation on the Agent surface; it starts branches and keeps the tallies. */
export async function talkToUltimate(
  actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>,
) {
  const id = await api.action<number>('subagents', 'standing', { name: 'ultimate' })
  actions.switchConversation(id)
  actions.showSurface('agent')
}

/** How many of @ultimate's questions wait on the user's answer. */
export const useWaitingOnUser = () => waitingOnUser(useDocOf<BoardData>(1, 'board') ?? emptyBoard)

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

/** The title bar's way to @ultimate from every surface, with its state and the questions that wait on you. */
export function UltimateButton() {
  const actions = useUltimate()
  const id = useDocOf<Record<string, number>>(1, 'ultimate.standing-agents')?.ultimate
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
  const label = working ? 'working' : waiting ? `${waiting} waiting on you` : 'idle'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-current={active ? 'page' : undefined}
          aria-label={`Talk to @ultimate (${label})`}
          className={cn(
            'flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
            active && 'text-foreground',
          )}
          data-ultimate-button
          onClick={() => void talkToUltimate(actions)}
          type="button"
        >
          <UltimateDot waiting={waiting} working={working} />
          @ultimate
          {waiting > 0 && <span className="text-amber-700 dark:text-amber-300">{waiting}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent>Talk to @ultimate · {label}</TooltipContent>
    </Tooltip>
  )
}
