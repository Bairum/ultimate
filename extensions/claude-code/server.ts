import {
  createClaudeCodeProvider,
  claudeCodeEnv,
} from '@earendil-works/pi-claude-code/src/provider.ts'
import {
  getClaudeStatus,
  closeClaudeProcesses,
} from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ExtensionAction } from '../../server/actions.ts'

export default function claudeCode(host: ExtensionHost) {
  const provider = createClaudeCodeProvider()
  // Keep subscription accounting, but do not offer an in-app login for external auth.
  if (provider.auth.oauth) Reflect.deleteProperty(provider.auth.oauth, 'login')
  host.onOpen(async () => {
    host.modelRuntime.registerNativeProvider(provider)
  })
  host.onClose(async () => {
    host.modelRuntime.unregisterProvider(provider.id)
    await closeClaudeProcesses()
  })
  return { name: 'claude-code' }
}

export const actions = {
  async status(_args, { host, signal }) {
    signal.throwIfAborted()
    const refreshed = await host.modelRuntime.refresh({ allowNetwork: false, signal })
    if (refreshed.aborted || refreshed.errors.has('claude-code'))
      throw new Error('Claude Code status refresh failed')
    const status = await getClaudeStatus(claudeCodeEnv(), signal)
    // Only expose status metadata, never CLI output or account identity.
    return {
      available: status.available,
      loggedIn: status.loggedIn,
      subscription: status.subscription,
      plan: status.plan ?? null,
    }
  },
} satisfies Record<string, ExtensionAction>
