/** The @ultimate button's state word: paused before working, then what waits on you, else idle. Browser-safe. */
export function primaryLabel(state: {
  paused: boolean
  working: boolean
  word: string
  waiting: number
}) {
  if (state.paused) return 'paused'
  if (state.working) return state.word
  return state.waiting ? `${state.waiting} waiting on you` : 'idle'
}
