import { useState } from 'react'
import { cn, events } from '@/sdk'

/**
 * Temporary, for the preview: a pill that picks how the rows between @ultimate's messages recede (`ultimate.recede` in
 * localStorage, `?recede=` for screenshots). Removing the trial is deleting this file, its overlay slot in web.tsx and
 * `useRecede` in web/src/app/transcript.tsx.
 */
const KEY = 'ultimate.recede'
const options = [
  { id: 'fade', label: 'A', title: 'A · Faded rows, full on hover' },
  { id: 'line', label: 'B', title: 'B · One summary line, click to open' },
  { id: 'off', label: '–', title: 'As before' },
] as const

export function RecedeSwitcher() {
  const [current, setCurrent] = useState(
    () => new URLSearchParams(location.search).get('recede') ?? localStorage.getItem(KEY) ?? 'fade',
  )
  return (
    <div
      aria-label="Between messages"
      className="fixed bottom-14 left-3 z-50 flex items-center gap-0.5 rounded-full border border-border bg-popover/95 p-0.5 font-mono text-[11px] shadow-sm backdrop-blur max-sm:top-24 max-sm:right-3 max-sm:bottom-auto max-sm:left-auto"
      role="radiogroup"
    >
      <span className="px-1.5 text-muted-foreground">between</span>
      {options.map((option) => (
        <button
          aria-checked={current === option.id}
          className={cn(
            'size-6 cursor-pointer rounded-full transition-colors',
            current === option.id
              ? 'bg-brand/15 text-brand'
              : 'text-muted-foreground hover:text-foreground',
          )}
          key={option.id}
          onClick={() => {
            localStorage.setItem(KEY, option.id)
            const url = new URL(location.href)
            url.searchParams.delete('recede')
            history.replaceState(history.state, '', url)
            setCurrent(option.id)
            events.emit(KEY, option.id)
          }}
          role="radio"
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
