export type Phase =
  | 'exploring'
  | 'planning'
  | 'editing'
  | 'verifying'
  | 'fixing'
  | 'delegating'
  | 'wrapping_up'
export type PhaseRow = {
  generation?: number
  phase?: Phase
  confidence?: number
  at?: number
  pending?: number
}
export type PhaseState = { conversations: Record<string, PhaseRow> }
