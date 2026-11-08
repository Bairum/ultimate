/** To-dos for other extensions' browser code: the point where they add rows to the user's list. */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

/**
 * Rows another extension adds to the user's "For you" section (the advisor: @ultimate's open concerns and blockers),
 * with how many they are for the header's count; several may provide it, shown in discovery order. Input is unused.
 */
export const ForYou = definePoint<null, { count: number; rows: ReactNode } | undefined>(
  'todos.for-you',
)
