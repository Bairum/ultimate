import { MoonIcon } from 'lucide-react'
import {
  defineWebExtension,
  provide,
  useConversation,
  useDocOf,
  useModels,
  useUltimate,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { MemoryHeader } from '../lineage/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { JournalCard, StartedCard } from './journal.tsx'
import { DreamDialog, dreamDialog } from './modal.tsx'
import { DreamDoc } from './refs.ts'

/** Above this share of its context window, a compacted @ultimate has lived long enough to be worth a dream. */
const FULL = 0.5

/**
 * The share of the context window the latest response was sent with, or undefined when a compaction or reset came
 * after it (the context is fresh then) or nothing answered yet.
 */
function contextShare(entries: readonly EntryRecord[], window: number) {
  let marker = -1
  let answered = -1
  let used = 0
  for (const entry of entries) {
    if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset')
      marker = Math.max(marker, entry.id)
    const model = entry.model?.[0]
    if (entry.kind === 'pi.assistant' && model?.role === 'assistant' && entry.id > answered) {
      answered = entry.id
      used = model.usage.input + model.usage.cacheRead + model.usage.cacheWrite
    }
  }
  return answered > marker ? used / window : undefined
}

/**
 * A quiet hint in the status line when @ultimate is shown, has compacted at least once and is past half its context
 * again, and no dream is open: a good time to dream. Clicking it explains what a dream does.
 */
function TimeToDream() {
  const { id, entries, agent } = useConversation()
  const ultimate = useDocOf(1, StandingDoc)?.ultimate
  const open = useDocOf(1, DreamDoc)?.sessions.some((item) => item.endedAt === undefined)
  const models = useModels()
  const actions = useUltimate()
  if (ultimate === undefined || id !== ultimate || open !== false) return null
  if (!entries.some((entry) => entry.kind === 'pi.compaction')) return null
  const window = models?.models.find(
    (model) => model.provider === agent.model?.provider && model.id === agent.model.modelId,
  )?.contextWindow
  const share = window ? contextShare(entries, window) : undefined
  if (share === undefined || share <= FULL) return null
  return (
    <button
      className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      data-dream-hint
      onClick={() => actions.open(dreamDialog)}
      title="@ultimate has learned a lot since its last dream: see what dreaming does"
      type="button"
    >
      <MoonIcon className="size-3 text-brand/80" />
      Time to dream?
    </button>
  )
}

/** The Memory panel's Dream button: dreaming distils this memory, among other things. */
function useDreamButton() {
  const actions = useUltimate()
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
      <span className="text-[11px] text-muted-foreground">What every new branch starts from</span>
      <button
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-dream-open
        onClick={() => actions.open(dreamDialog)}
        title="Process what Ultimate learned: a journal and proposals for you to decide"
        type="button"
      >
        <MoonIcon className="size-3 text-brand" />
        Dream…
      </button>
    </div>
  )
}

export default defineWebExtension({
  entries: { 'dream.started': StartedCard, 'dream.journal': JournalCard },
  slots: { 'statusline.right': [TimeToDream], overlay: [DreamDialog] },
  commands: [{ id: 'dream.open', title: 'Dream…', run: (context) => context.open(dreamDialog) }],
  provides: [provide(MemoryHeader, useDreamButton)],
})
