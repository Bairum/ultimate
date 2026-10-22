export type Subscription = {
  id: string
  title: string
  ask: string
  once: boolean
  enabled: boolean
  conversationId: number
  subscribers: number[]
  secrets?: string[]
  createdAt: number
  updatedAt: number
  state: 'writing' | 'running' | 'investigating' | 'failed' | 'stopped' | 'done'
  pid?: number
  startedAt?: number
  exitedAt?: number
  exitCode?: number
  lastFireAt?: number
  fires: number
  lastOutputAt?: number
  error?: string
}
export type SubscriptionListItem = Subscription & { alive: boolean }
export type CreateArgs = {
  ask: string
  title?: string
  once?: boolean
  secrets?: string[]
  subscribers?: number[]
}
export type Args = Partial<CreateArgs> & {
  action: string
  id?: string
  to?: string
  lines?: number
  reason?: string
}

/** Only stdout has a protocol; progress on stderr never fires a subscription. */
export function fireText(line: string, stdout: boolean): string | undefined {
  return stdout && /^FIRE(?:\s|$)/.test(line) ? line.slice(4).trim() : undefined
}

/** `DONE [text]` on stdout asks to stop cleanly; it takes effect when the script then exits 0. */
export function doneText(line: string, stdout: boolean): string | undefined {
  return stdout && /^DONE(?:\s|$)/.test(line) ? line.slice(4).trim() : undefined
}

/** Keep both bounds even for a single very long output line. */
export function trimLog(text: string): string {
  const lines = text.split('\n').slice(-2001).join('\n')
  const bytes = Buffer.from(lines)
  return bytes.length > 256 * 1024 ? bytes.subarray(-256 * 1024).toString('utf8') : lines
}
