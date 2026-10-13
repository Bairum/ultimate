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

export function createUltimateClaudeCodeProvider() {
  const provider = createClaudeCodeProvider()
  const getModels = () =>
    provider
      .getModels()
      .map((model) =>
        model.id === 'claude-sonnet-5'
          ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } }
          : model,
      )
  // Both getters must adapt the current catalog, including discovered/restored rows.
  // Upstream exposes only chat models. Keep its transport and refresh implementation intact.
  return { ...provider, getModels, getAllModels: getModels }
}

export default function claudeCode(host: ExtensionHost) {
  const shared = host.resource('claude-code.provider', () => {
    const provider = createUltimateClaudeCodeProvider()
    const active = new Set<Promise<unknown>>()
    let closing = false
    const track = (response: ReturnType<typeof provider.streamSimple>) => {
      const settled = response.result()
      active.add(settled)
      void settled.finally(() => active.delete(settled))
      return response
    }
    host.onClose(async () => {
      closing = true
      // Extension cleanup precedes harness suspension. Let its signal stop active
      // requests before closing warm workers; never turn suspension into an error.
      if (active.size) void Promise.allSettled(active).then(() => closeClaudeProcesses())
      else await closeClaudeProcesses()
    })
    const stream: typeof provider.stream = (...args) => {
      if (closing) throw new Error('Claude Code provider is closing')
      return track(provider.stream(...args))
    }
    const streamSimple: typeof provider.streamSimple = (...args) => {
      if (closing) throw new Error('Claude Code provider is closing')
      return track(provider.streamSimple(...args))
    }
    return { ...provider, stream, streamSimple }
  })
  const provider = { ...shared }
  // Keep subscription accounting, but do not offer an in-app login for external auth.
  if (provider.auth.oauth) Reflect.deleteProperty(provider.auth.oauth, 'login')
  host.onOpen(async () => {
    host.modelRuntime.registerNativeProvider(provider)
  })
  host.onClose(async () => {
    host.modelRuntime.unregisterProvider(provider.id)
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
