import { BrainIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn, defineWebExtension, useDoc } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { useOpenMemory } from '../lineage/ui.tsx'
import { RecallDoc } from './refs.ts'
import { RECALL_ENTRY } from './types.ts'
import type { Recalled } from './types.ts'

/** While recall checks this message, a band of light runs around the bubble's border, then fades. */
function Shimmer({ entry }: { entry: EntryRecord }) {
  const pending = useDoc(RecallDoc)?.pending === entry.id
  // Mounted once the check starts, so the fade-out plays; never on history.
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (pending) setSeen(true)
  }, [pending])
  if (!seen) return null
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 rounded-lg p-px transition-opacity duration-700',
        pending ? 'animate-sweep opacity-100' : 'opacity-0',
      )}
      data-recall-checking={pending || undefined}
      style={{
        background:
          'linear-gradient(90deg, transparent 30%, var(--color-brand) 50%, transparent 70%) 0 0 / 300% 100%',
        mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
      }}
    />
  )
}

/** The memories recalled for the message above, as chips under it that open the Memory panel. */
function Recall({ entry }: { entry: EntryRecord }) {
  const recalled = entry.data as Recalled
  const openMemory = useOpenMemory()
  const row = useRef<HTMLDivElement>(null)
  // Fly in only when it arrives live, not when history loads.
  const [live] = useState(() => Date.now() - (entry.model?.[0]?.timestamp ?? 0) < 10_000)
  useEffect(() => {
    if (!live) return
    row.current?.querySelectorAll('button').forEach((chip, index) =>
      chip.animate(
        [
          { opacity: 0, transform: 'translateY(-8px) scale(0.9)' },
          { opacity: 1, transform: 'none' },
        ],
        {
          duration: 450,
          delay: index * 80,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'backwards',
        },
      ),
    )
  }, [live])
  return (
    <div
      className="-mt-1 mb-1 flex flex-wrap justify-end gap-1"
      data-recall={recalled.input}
      ref={row}
    >
      {recalled.memories.map(({ slug, line }) => (
        <button
          className="inline-flex h-6 max-w-full cursor-pointer items-center gap-1 rounded-full border border-border/70 bg-background px-2 font-mono text-[10.5px] text-muted-foreground outline-none hover:border-brand/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          data-recall-memory={slug}
          key={slug}
          onClick={() => openMemory(slug)}
          title={`Recalled from memory: ${line}`}
          type="button"
        >
          <BrainIcon className="size-3 shrink-0 text-brand" />
          <span className="truncate">{slug}</span>
        </button>
      ))}
    </div>
  )
}

export default defineWebExtension({
  userBubble: [Shimmer],
  entries: { [RECALL_ENTRY]: Recall },
})
