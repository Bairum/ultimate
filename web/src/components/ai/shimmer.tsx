// Adapted from vercel/ai-elements packages/elements/src/shimmer.tsx (Apache-2.0, see LICENSE).
// Changes: a CSS animation (`animate-shimmer` in index.css) instead of motion.
import { cn } from 'cn'
import type { CSSProperties, ElementType } from 'react'

export interface ShimmerProps {
  children: string
  as?: ElementType
  className?: string
  /** Width of the highlight, in px per character. */
  spread?: number
}

export const Shimmer = ({
  children,
  as: Component = 'span',
  className,
  spread = 2,
}: ShimmerProps) => (
  <Component
    className={cn(
      'inline-block animate-shimmer bg-size-[250%_100%,auto] bg-clip-text text-transparent [background-repeat:no-repeat,padding-box]',
      className,
    )}
    style={
      {
        '--spread': `${children.length * spread}px`,
        backgroundImage:
          'linear-gradient(90deg, #0000 calc(50% - var(--spread)), var(--color-foreground), #0000 calc(50% + var(--spread))), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))',
      } as CSSProperties
    }
  >
    {children}
  </Component>
)
