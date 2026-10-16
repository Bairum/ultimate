import { join } from 'node:path'
import { lazyStream } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings } from '../onboarding/settings.ts'

type Overlay = Parameters<ExtensionHost['modelRuntime']['registerProvider']>[1]
type Stream = NonNullable<Overlay['streamSimple']>
type FastHost = Pick<ExtensionHost, 'userHome' | 'projectSettings' | 'notice'>

const reported = new Set<string>()

/** `fastModels` from the project's settings, else the user's, read at each request so a change applies to the next one. */
export async function fastModels(host: FastHost): Promise<Set<string>> {
  // Invalid settings JSON is reported where settings load; here it counts as unset.
  const user: JsonObject = await readSettings(join(host.userHome, '.ultimate/settings.json')).catch(
    () => ({}),
  )
  const project = await host.projectSettings()
  const value = Object.hasOwn(project, 'fastModels') ? project.fastModels : user.fastModels
  if (value === undefined) return new Set()
  const valid =
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.startsWith('openai/'))
  if (valid) return new Set(value as string[])
  const message = `Invalid fastModels ${JSON.stringify(value)}: expected ["openai/<id>", …]; fast mode is off`
  if (!reported.has(message)) {
    reported.add(message)
    host.notice(message)
  }
  return new Set()
}

/** Stream OpenAI Responses requests, asking for the priority (fast) service tier for the models `listed` names. */
export function fastStream(listed: () => Promise<Set<string>>, api = openAIResponsesApi()): Stream {
  return (model, context, options) =>
    lazyStream(model, async () => {
      if (!(await listed()).has(`${model.provider}/${model.id}`))
        return api.streamSimple(model, context, options)
      // Sign in with ChatGPT rejects the documented "fast"; "priority" is the same tier.
      // Pi upstream: @earendil-works/pi-ai@1.2.0 src/api/simple-options.ts — simple stream options drop serviceTier, so it goes into the payload. Drop when buildBaseOptions forwards serviceTier and Pi Durable stream settings accept it.
      return api.streamSimple(model, context, {
        ...options,
        onPayload: async (payload, payloadModel) => ({
          ...(((await options?.onPayload?.(payload, payloadModel)) ?? payload) as object),
          service_tier: 'priority',
        }),
      })
    })
}

export default function fast(host: ExtensionHost) {
  // A reload installs the new facet before the old one closes; unregister only when none remain.
  const facets = host.resource('fast.facets', () => new Set<symbol>())
  const facet = Symbol('fast')
  facets.add(facet)
  host.onClose(async () => {
    facets.delete(facet)
    if (!facets.size) host.modelRuntime.unregisterProvider('openai')
  })
  host.modelRuntime.registerProvider('openai', {
    api: 'openai-responses',
    streamSimple: fastStream(() => fastModels(host)),
  })
  return { name: 'fast' }
}
