import {
  createClaudeCodeProvider,
  claudeCodeEnv,
} from '@earendil-works/pi-claude-code/src/provider.ts'
import {
  getClaudeStatus,
  closeClaudeProcesses,
} from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import { defineExtension, GenerationTask, hook, ProviderDoc } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { ClaudeCodeEnv } from './api.ts'
import type { ClaudeCodeEnvService } from './api.ts'
import { StatusAction } from './refs.ts'

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
  // Retained across facet reloads, so it holds only data and long-lived handles: a reloaded facet gets the object
  // the first load created. Behaviour stays in the facet below, so new code takes effect on reload. Adding a field
  // here needs a host restart (or a new key).
  const shared = host.resource('claude-code.provider', () => {
    const state = {
      provider: createUltimateClaudeCodeProvider(),
      /** Settlement of every request still streaming, from any facet. */
      active: new Set<Promise<unknown>>(),
      closing: false,
      facets: new Set<symbol>(),
      // Requests carry Pi's provider session id, not a conversation: `beforeRequest` below maps one to the other.
      sessions: new Map<string, number>(),
    }
    host.onClose(async () => {
      state.closing = true
      // Extension cleanup precedes harness suspension. Let its signal stop active
      // requests before closing warm workers; never turn suspension into an error.
      if (state.active.size)
        void Promise.allSettled(state.active)
          .then(() => closeClaudeProcesses())
          .catch((error: unknown) =>
            host.notice(`Closing Claude processes failed: ${String(error)}`),
          )
      else await closeClaudeProcesses()
    })
    return state
  })
  const upstream = shared.provider
  const withEnv = <O extends { env?: Record<string, string | undefined>; sessionId?: string }>(
    options: O | undefined,
  ) => {
    const sessionId = options?.sessionId
    const env: ClaudeCodeEnvService | undefined = host.want(ClaudeCodeEnv)
    const extra = env?.env(sessionId === undefined ? undefined : shared.sessions.get(sessionId))
    return extra ? ({ ...options, env: { ...options?.env, ...extra } } as O) : options
  }
  const track = (response: ReturnType<typeof upstream.streamSimple>) => {
    const settled = response.result()
    shared.active.add(settled)
    void settled.then(
      () => shared.active.delete(settled),
      // The stream consumer receives the failure; tracking must not create another rejection.
      () => shared.active.delete(settled),
    )
    return response
  }
  const stream: typeof upstream.stream = (model, context, options) => {
    if (shared.closing) throw new Error('Claude Code provider is closing')
    return track(upstream.stream(model, context, withEnv(options)))
  }
  const streamSimple: typeof upstream.streamSimple = (model, context, options) => {
    if (shared.closing) throw new Error('Claude Code provider is closing')
    return track(upstream.streamSimple(model, context, withEnv(options)))
  }
  const provider = { ...upstream, stream, streamSimple }
  // Keep subscription accounting, but do not offer an in-app login for external auth.
  if (provider.auth.oauth) Reflect.deleteProperty(provider.auth.oauth, 'login')
  const facet = Symbol('claude-code')
  shared.facets.add(facet)
  host.onClose(async () => {
    shared.facets.delete(facet)
    if (!shared.facets.size) host.modelRuntime.unregisterProvider(provider.id)
  })
  // The replacement factory runs before the old facet closes. Keep its models
  // registered throughout that handoff, including disposal of a failed reload.
  host.modelRuntime.registerNativeProvider(provider)
  return defineExtension({
    name: 'claude-code',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const session = await api.snapshot(ProviderDoc, api.conversationId, context)
          if (!session) return
          shared.sessions.delete(session.sessionId)
          shared.sessions.set(session.sessionId, api.conversationId)
          if (shared.sessions.size > 10_000)
            shared.sessions.delete(shared.sessions.keys().next().value!)
        },
      }),
    ],
  })
}

export const actions = {
  status: implementAction(StatusAction, async (_args, { host, signal }) => {
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
  }),
}
