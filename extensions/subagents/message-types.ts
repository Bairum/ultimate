export type AgentOrigin = {
  body: string
  agent: string
  failed?: boolean
  sender: number
  entry?: number
  kind: 'instruction' | 'report'
}
