/** Context compression range and turn descriptions. */
export type Range = {
  id: string
  fromEntry: number
  toEntry: number
  entryIds: number[]
  turnIds: number[]
  summary: string
  tokens: number
  active: boolean
  at: number
}
export type Turn = {
  id: number
  fromEntry: number
  toEntry: number
  tokens: number
  gist: string
  compressed: string | null
}
