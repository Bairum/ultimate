export type Subscription = {
  /** `S<n>` for a user subscription, the folder's slug for a project subscription. */
  id: string
  /** Committed in `<project>/.ultimate/subscriptions/<id>/`; absent for a user subscription. */
  scope?: 'project'
  title: string
  ask: string
  once: boolean
  enabled: boolean
  /** The owning agent; a discovered project subscription gets an idle one at discovery. */
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
  /** `project` commits the subscription in `<project>/.ultimate/subscriptions/<slug>/`; default `user`. */
  scope?: 'user' | 'project'
  /** A project subscription's id and folder name; derived from the title when absent. */
  slug?: string
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

/** The committed `subscription.json` of a project subscription. */
export type Manifest = { title: string; ask: string; once: boolean; secrets?: string[] }
/**
 * A project subscription's slug: lowercase, so it never collides with a user `S<n>`, and never an inherited object
 * key such as `constructor`, so records stay plain lookups.
 */
export const isSlug = (id: string) => /^[a-z][a-z0-9-]{0,62}$/.test(id) && !(id in Object.prototype)
export const isId = (id: string) => /^S[1-9]\d*$/.test(id) || isSlug(id)

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
