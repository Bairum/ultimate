import { useEffect, useSyncExternalStore } from 'react'
import { cn, useUltimate } from '@/sdk'

/**
 * Temporary: the message styles on trial, picked with a floating switcher and kept in localStorage. Removing the trial
 * is deleting this file, the switcher's overlay slot in web.tsx and the branches on `useMessageStyle()` in cards.tsx.
 */
export type MessageStyle = 'bubble' | 'prose' | 'card'

const KEY = 'ultimate.messages.style'
const styles: readonly { id: MessageStyle; label: string; title: string }[] = [
  { id: 'bubble', label: 'A', title: 'A · Bubble: tinted surface, mark in the margin' },
  { id: 'prose', label: 'B', title: 'B · Prose: header line, text on the page' },
  { id: 'card', label: 'C', title: 'C · Card: hairline outline, tinted top' },
]

// A `?message-style=` parameter wins, so a screenshot can pick a style without a click.
const read = (): MessageStyle => {
  const stored =
    new URLSearchParams(location.search).get('message-style') ?? localStorage.getItem(KEY)
  return styles.some((style) => style.id === stored) ? (stored as MessageStyle) : 'bubble'
}
const subscribe = (change: () => void) => {
  window.addEventListener('storage', change)
  window.addEventListener(KEY, change)
  return () => {
    window.removeEventListener('storage', change)
    window.removeEventListener(KEY, change)
  }
}
const choose = (style: MessageStyle) => {
  localStorage.setItem(KEY, style)
  window.dispatchEvent(new Event(KEY))
}

export const useMessageStyle = () =>
  useSyncExternalStore(subscribe, read, (): MessageStyle => 'bubble')

/**
 * Screenshot aids for the trial: `?theme=light|dark` switches this browser to that theme;
 * `?message-at=<text>` scrolls to the first message containing that text once the transcript shows it.
 */
function useScreenshotParameters() {
  const { setTheme } = useUltimate()
  useEffect(() => {
    const parameters = new URLSearchParams(location.search)
    const theme = parameters.get('theme')
    if (theme === 'light' || theme === 'dark') setTheme(theme)
    const needle = parameters.get('message-at')
    if (!needle) return undefined
    let tries = 0
    const timer = setInterval(() => {
      const found = [...document.querySelectorAll('[data-compact-bubble]')].find((element) =>
        element.textContent?.includes(needle),
      )
      if (found) found.scrollIntoView({ block: 'start' })
      if (++tries > 12) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [setTheme])
}

/** A small A/B/C pill at the bottom left of the page that switches the message style. */
export function MessageStyleSwitcher() {
  const current = useMessageStyle()
  useScreenshotParameters()
  return (
    <div
      className="fixed bottom-14 left-3 z-50 max-sm:top-24 max-sm:right-3 max-sm:bottom-auto max-sm:left-auto flex items-center gap-0.5 rounded-full border border-border bg-popover/95 p-0.5 font-mono text-[11px] shadow-sm backdrop-blur"
      role="radiogroup"
      aria-label="Message style"
    >
      <span className="px-1.5 text-muted-foreground">style</span>
      {styles.map((style) => (
        <button
          aria-checked={current === style.id}
          className={cn(
            'size-6 cursor-pointer rounded-full transition-colors',
            current === style.id
              ? 'bg-brand/15 text-brand'
              : 'text-muted-foreground hover:text-foreground',
          )}
          key={style.id}
          onClick={() => choose(style.id)}
          role="radio"
          title={style.title}
          type="button"
        >
          {style.label}
        </button>
      ))}
    </div>
  )
}
