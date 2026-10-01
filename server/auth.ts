import { randomUUID } from 'node:crypto'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { FauxProviderHandle } from '@earendil-works/pi-ai/providers/faux'
import { isModelType } from '@earendil-works/pi-ai/models'
import type { AuthPrompt, AuthType } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { AuthFlowEvent, ModelsResponse } from '../shared/protocol.ts'

export class AuthBridge {
  readonly runtime: ModelRuntime
  readonly emit: (event: AuthFlowEvent) => void
  readonly flows = new Map<
    string,
    { controller: AbortController; answer?: (value: string) => void }
  >()
  constructor(runtime: ModelRuntime, emit: (event: AuthFlowEvent) => void) {
    this.runtime = runtime
    this.emit = emit
  }
  login(provider: string, type: AuthType): string {
    const definition = this.runtime.getProvider(provider)
    if (!definition?.auth[type === 'oauth' ? 'oauth' : 'apiKey']?.login)
      throw new Error('Unsupported provider or login type')
    const flowId = randomUUID()
    const flow: { controller: AbortController; answer?: (value: string) => void } = {
      controller: new AbortController(),
    }
    this.flows.set(flowId, flow)
    // The POST response reaches the browser before the first prompt event.
    setImmediate(() => {
      void this.runtime
        .login(provider, type, {
          signal: flow.controller.signal,
          prompt: (prompt: AuthPrompt) =>
            new Promise<string>((resolve, reject) => {
              const signals = [flow.controller.signal, prompt.signal].filter(
                (signal): signal is AbortSignal => !!signal,
              )
              const cleanup = () => {
                for (const signal of signals) signal.removeEventListener('abort', abort)
                delete flow.answer
              }
              const abort = () => {
                cleanup()
                reject(new Error('Login cancelled'))
              }
              flow.answer = (value) => {
                cleanup()
                resolve(value)
              }
              for (const signal of signals) {
                if (signal.aborted) {
                  abort()
                  return
                }
                signal.addEventListener('abort', abort, { once: true })
              }
              const { signal: _signal, ...wire } = prompt
              this.emit({ flowId, type: 'prompt', prompt: wire })
            }),
          notify: (event) => this.emit({ flowId, type: 'event', event }),
        })
        .then(
          () => {
            this.emit({ flowId, type: flow.controller.signal.aborted ? 'cancel' : 'complete' })
          },
          () => {
            // Provider errors may include secrets or callback codes; never forward them.
            this.emit(
              flow.controller.signal.aborted
                ? { flowId, type: 'cancel' }
                : { flowId, type: 'error', error: 'Login failed' },
            )
          },
        )
        .finally(() => this.flows.delete(flowId))
    })
    return flowId
  }
  answer(id: string, value: string) {
    const answer = this.flows.get(id)?.answer
    if (!answer) throw new Error('No pending prompt for flow')
    answer(value)
  }
  cancel(id: string) {
    const flow = this.flows.get(id)
    if (!flow) throw new Error('Unknown login flow')
    flow.controller.abort()
  }
  close() {
    for (const flow of this.flows.values()) flow.controller.abort()
  }
}

export async function listModels(
  runtime: ModelRuntime,
  faux?: FauxProviderHandle,
): Promise<ModelsResponse> {
  const available = new Set(
    (await runtime.getAvailable()).map((model) => `${model.provider}/${model.id}`),
  )
  if (faux) available.add('faux/faux-1')
  return {
    providers: [...runtime.getProviders(), ...(faux ? [faux.provider] : [])].map((provider) => ({
      id: provider.id,
      name: provider.auth.oauth?.name ?? provider.auth.apiKey?.name ?? provider.id,
      authTypes: [
        ...(provider.auth.apiKey?.login
          ? [{ type: 'api_key' as const, name: provider.auth.apiKey.name }]
          : []),
        ...(provider.auth.oauth?.login
          ? [{ type: 'oauth' as const, name: provider.auth.oauth.name }]
          : []),
      ],
      status:
        provider.id === 'faux' ? { configured: true } : runtime.getProviderAuthStatus(provider.id),
      isUsingSubscription: runtime.isUsingSubscription(provider.id),
    })),
    models: [...runtime.getAllModels(), ...(faux?.models ?? [])]
      .filter((model) => isModelType(model, 'chat'))
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        thinkingLevels: getSupportedThinkingLevels(model),
        cost: model.cost,
        available: available.has(`${model.provider}/${model.id}`),
      })),
  }
}
