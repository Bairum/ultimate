export type AgentOrigin = {
  sender: number
  entry?: number
  kind: 'instruction' | 'report'
}
