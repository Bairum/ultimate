/**
 * Cloud's components for other extensions: a move's progress card and its phase, which @sync's move card shows, and
 * the point where another extension offers help with moves (sync's "Ask @sync" link).
 */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

export { phaseOf, TransitionCard } from './transition.tsx'

/** Help with moving this project, under the standby page's and the cloud popover's state (`sync` provides it). */
export const MoveHelp = definePoint<null, ReactNode>('cloud.move-help')
