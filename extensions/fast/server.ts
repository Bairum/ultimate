import { join } from 'node:path'
import { lazyStream } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { JsonValue } from '@earendil-works/chord'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ActionContext, ExtensionAction } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings, updateSettings } from '../onboarding/settings.ts'

type Overlay = Parameters<ExtensionHost['modelRuntime']['registerProvider']>[1]
type Stream = NonNullable<Overlay['streamSimple']>
type FastHost = Pick<ExtensionHost, 'userHome' | 'projectSettings' | 'notice'>

const reported = new Set<string>()

const userFile = (host: Pick<ExtensionHost, 'userHome'>) =>
  join(host.userHome, '.ultimate/settings.json')

/** The raw `fastModels` value: the project's settings, else the user's. */
async function fastSetting(host: Pick<FastHost, 'userHome' | 'projectSettings'>) {
  // Invalid settings JSON is reported where settings load; here it counts as unset.
  const user: JsonObject = await readSettings(userFile(host)).catch(() => ({}))
  const project = await host.projectSettings()
  return Object.hasOwn(project, 'fastModels')
    ? { value: project.fastModels, project: true }
    : { value: user.fastModels, project: false }
}

/** The models `fastModels` names, read at each request so a change applies to the next one. */
export async function fastModels(host: FastHost): Promise<Set<string>> {
  const { value } = await fastSetting(host)
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

const status = async (host: FastHost) => ({
  models: [...(await fastModels(host))],
  project: (await fastSetting(host)).project,
})

export const actions = {
  /** `{ models, project }`: the fast models, and whether the project's settings decide them. */
  async status(_args: JsonValue, { host }: ActionContext) {
    return status(host)
  },
  /**
   * `{ model, on }`: adds `"openai/<id>"` to the user's `fastModels` or removes it. The project's tracked settings
   * file is never written: while it sets the list, this refuses.
   */
  async set(args: JsonValue, { host }: ActionContext) {
    const { model, on } = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof model !== 'string' || !model.startsWith('openai/') || typeof on !== 'boolean')
      throw new Error('Expected { model: "openai/<id>", on: boolean }')
    if ((await fastSetting(host)).project)
      throw new Error('Fast models are set by project settings; edit that file to change them')
    await updateSettings(userFile(host), (settings) => {
      const listed = new Set(
        Array.isArray(settings.fastModels)
          ? settings.fastModels.filter((entry) => typeof entry === 'string')
          : [],
      )
      if (on) listed.add(model)
      else listed.delete(model)
      if (listed.size) settings.fastModels = [...listed]
      else delete settings.fastModels
    })
    return status(host)
  },
} satisfies Record<string, ExtensionAction>

/** Stream OpenAI Responses requests, asking for the priority (fast) service tier for the models `listed` names. */
export function fastStream(listed: () => Promise<Set<string>>, api = openAIResponsesApi()): Stream {
  return (model, context, options) =>
    lazyStream(model, async () => {
      if (!(await listed()).has(`${model.provider}/${model.id}`))
        return api.streamSimple(model, context, options)
      // Sign in with ChatGPT rejects the documented "fast"; "priority" is the same tier.
      // Pi upstream: @earendil-works/pi-ai@1.3.0 src/api/simple-options.ts — simple stream options drop serviceTier, so it goes into the payload. Drop when buildBaseOptions forwards serviceTier and Pi Durable stream settings accept it.
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
