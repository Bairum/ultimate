import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { OpenAction } from './refs.ts'
import { defaults, offload, openOutput, pruneOutputs } from './store.ts'
import type { Options } from './store.ts'

export const userActions = ['open']
export const actions = {
  open: implementAction(OpenAction, async (args, { host }) => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.path !== 'string')
      throw new Error('Expected { path: string }')
    return openOutput(host.home, args.path)
  }),
}

export default function outputOffload(host: ExtensionHost) {
  host.onOpen(() => pruneOutputs(host.home))
  async function options(): Promise<Options> {
    const user = await readSettings(userSettingsPath(host.userHome))
    const project = await host.projectSettings()
    const selected: Options = { ...defaults }
    for (const settings of [user, project]) {
      const value = settings.outputOffload
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      if (value.thresholdBytes !== undefined) {
        if (
          typeof value.thresholdBytes !== 'number' ||
          !Number.isSafeInteger(value.thresholdBytes) ||
          value.thresholdBytes < 1
        )
          throw new Error('outputOffload.thresholdBytes must be a positive integer')
        selected.thresholdBytes = value.thresholdBytes
      }
      if (value.exclude !== undefined) {
        if (
          !Array.isArray(value.exclude) ||
          !value.exclude.every((name) => typeof name === 'string')
        )
          throw new Error('outputOffload.exclude must be an array of tool names')
        selected.exclude = value.exclude
      }
    }
    return selected
  }
  return defineExtension({
    name: 'output-offload',
    hooks: [
      hook(ToolTask, {
        afterTool: async (call, result, api) => {
          if (call.parent || call.name === 'read') return undefined
          try {
            return await offload(host.home, api.conversationId, call, result, await options())
          } catch (error) {
            return {
              ...result,
              diagnostics: [
                ...(result.diagnostics ?? []),
                {
                  severity: 'warn',
                  code: 'output_offload',
                  message: `Output offload failed; original result kept: ${String(error)}`,
                },
              ],
            }
          }
        },
      }),
    ],
  })
}
