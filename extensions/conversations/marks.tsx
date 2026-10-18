import { BotIcon, GitMergeIcon, ScrollTextIcon, ArrowLeftRightIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/sdk'

/** The display names of the agents Ultimate ships with; any other standing agent is its name, capitalised. */
const names: Record<string, string> = {
  ultimate: 'Ultimate',
  lander: 'Lander',
  cloudflare: 'Cloudflare',
  sync: 'Sync',
}
export const agentTitle = (name: string) =>
  names[name] ?? name.charAt(0).toUpperCase() + name.slice(1)

/** Cloudflare's cloud (Simple Icons, CC0), in Cloudflare orange. */
function CloudflareGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727" />
    </svg>
  )
}

/** Each known agent's tile: its tint and glyph. Glyphs size to the tile through `size-[60%]`. */
const tiles: Record<string, { tint: string; glyph: ReactNode }> = {
  ultimate: {
    tint: 'bg-brand/12 text-brand ring-brand/25',
    // The top bar's wordmark, reduced to its first letter.
    glyph: <span className="font-sans leading-none font-semibold">U</span>,
  },
  cloudflare: {
    tint: 'bg-[#f38020]/10 text-[#f38020] ring-[#f38020]/25',
    glyph: <CloudflareGlyph className="size-[72%]" />,
  },
  lander: {
    tint: 'bg-success/10 text-success ring-success/25',
    glyph: <GitMergeIcon className="size-[60%]" strokeWidth={2.25} />,
  },
  sync: {
    tint: 'bg-sky-500/10 text-sky-600 ring-sky-500/25 dark:text-sky-300',
    glyph: <ArrowLeftRightIcon className="size-[60%]" strokeWidth={2.25} />,
  },
  root: {
    tint: 'bg-brand/8 text-brand/90 ring-brand/20',
    glyph: <ScrollTextIcon className="size-[58%]" strokeWidth={2} />,
  },
}
const fallback = {
  tint: 'bg-muted text-muted-foreground ring-border',
  glyph: <BotIcon className="size-[60%]" strokeWidth={2} />,
}

/** The presence dot in a mark's corner: pulsing while it works, amber while it waits on you, else muted. */
export type Presence = 'working' | 'waiting' | 'idle'

/**
 * An agent's avatar: a small rounded tile in its colour with its glyph, the same in the sidebar, the title bar and
 * chat headers. `name` is a standing agent's name, `lander`, or `root` for a project's context.
 */
export function AgentMark({
  name,
  size = 'md',
  presence,
}: {
  name: string
  size?: 'xs' | 'sm' | 'md'
  presence?: Presence
}) {
  const tile = tiles[name] ?? fallback
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-[5px] ring-1 ring-inset',
        tile.tint,
        size === 'md' && 'size-6 text-[12px]',
        size === 'sm' && 'size-4 rounded-[4px] text-[9.5px]',
        size === 'xs' && 'size-3.5 rounded-[3px] text-[8.5px]',
      )}
      data-agent-mark={name}
    >
      {tile.glyph}
      {presence && (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-sidebar',
            size === 'md' ? 'size-2' : 'size-1.5 ring-[1.5px]',
            presence === 'working'
              ? 'animate-pulse-dot bg-brand'
              : presence === 'waiting'
                ? 'bg-amber-400'
                : 'bg-muted-foreground/60',
          )}
          data-presence={presence}
        />
      )}
    </span>
  )
}
