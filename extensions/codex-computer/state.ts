import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { StateDoc } from './refs.ts'
import type { CodexState } from './refs.ts'

const initial = (): CodexState => ({})
export const State = defineDoc<CodexState>({
  kind: StateDoc.kind,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial,
})
export async function updateState(
  host: ExtensionHost,
  conversation: number,
  change: (state: CodexState) => void,
) {
  await host
    .harness()
    .commit(async (tx) => change(await tx.doc(State, conversation as ConversationId)), context)
}
/**
 * Whether Codex may use `app` (its parsed name, else the whole request text). Without a project list every app is
 * allowed; with one, a listed name matches loosely either way round, so "Chrome" covers "Google Chrome".
 */
export function allowed(app: string, list?: readonly string[]) {
  if (!list) return true
  const name = app.trim().toLowerCase()
  return list.some((entry) => {
    const listed = entry.trim().toLowerCase()
    return !!listed && !!name && (name.includes(listed) || listed.includes(name))
  })
}
export function validate<T>(
  args: T,
): asserts args is T &
  Exclude<T, string | number | boolean | unknown[] | null> & { conversation: number } {
  if (
    !args ||
    typeof args !== 'object' ||
    !('conversation' in args) ||
    !Number.isSafeInteger(args.conversation) ||
    (args.conversation as number) < 1
  )
    throw new Error('conversation must be a positive integer')
}

/** Screen strings are data, never instructions; escaping prevents closing the boundary from screen text. */
export function untrusted(text: string) {
  return `<untrusted_screen_content>\n${text.replace(/<\/untrusted_screen_content>/gi, '&lt;/untrusted_screen_content&gt;')}\n</untrusted_screen_content>`
}
