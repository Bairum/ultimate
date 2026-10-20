import { RotateCwIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { BuildNote } from './refs.ts'

const short = (id: string) => id.slice(0, 7)

/** The note on an input saying the build or the agent's instructions changed: one quiet divider, its text on hover. */
function Note({ entry }: { entry: EntryRecord }) {
  const note = (entry.data ?? {}) as BuildNote
  const content = entry.model?.[0]?.content
  const parts = [
    note.from && note.to && `build ${short(note.from)} → ${short(note.to)}`,
    note.instructions?.length && `instructions: ${note.instructions.join(', ')}`,
    note.docs?.length && `docs: ${note.docs.join(', ')}`,
  ].filter(Boolean)
  if (parts.length === 0) return null
  const label = note.from ? 'Reloaded' : 'Instructions changed'
  return (
    <div
      className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/80 before:h-px before:flex-1 before:bg-brand/25 after:h-px after:flex-1 after:bg-brand/25"
      title={typeof content === 'string' ? content : undefined}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <RotateCwIcon className="size-3 shrink-0 text-brand" />
        <span className="shrink-0 text-brand">{label}</span>
        <span className="truncate">· {parts.join(' · ')}</span>
      </span>
    </div>
  )
}

export default defineWebExtension({
  entries: { 'prompt.build': Note },
})
