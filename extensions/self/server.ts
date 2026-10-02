import { awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'

import type { ExtensionHost } from '../../server/extensions.ts'

export default (host: ExtensionHost) =>
  defineExtension({
    name: 'self',
    tools: [
      defineTool({
        name: 'restart',
        description:
          'Apply changes to server/ or shared/ with a verified core swap. Not needed for web/, extensions/, or agents/.',
        parameters: Type.Object({}),
        replay: 'safe',
        async execute(_args, api, context): Promise<ToolExecutionResult> {
          const key = `restart:${api.taskId}`
          const done = await api.memo<{
            generation: number
            fromGeneration: number
            build: string
          }>(key, context)
          if (done && Number(process.env.ULTIMATE_GENERATION) !== done.generation)
            return {
              isError: true,
              details: {
                fromGeneration: done.fromGeneration,
                toGeneration: Number(process.env.ULTIMATE_GENERATION),
                fromBuild: done.build,
                toBuild: host.build().id,
                rolledBack: true,
                error: host.system().process.activationError ?? 'Activation failed',
              },
              content: [
                {
                  type: 'text',
                  text: `Restart failed during activation; rolled back to generation ${process.env.ULTIMATE_GENERATION}. ${host.system().process.activationError ?? ''}`,
                },
              ],
            }
          if (done)
            return {
              details: {
                fromGeneration: done.fromGeneration,
                toGeneration: done.generation,
                fromBuild: done.build,
                toBuild: host.build().id,
              },
              content: [
                {
                  type: 'text',
                  text: `Restarted. Now running generation ${process.env.ULTIMATE_GENERATION ?? done.generation} (pid ${process.pid}), build ${done.build} → ${host.build().id}.`,
                },
              ],
            }
          const error = await awaitWithContext(
            host.restart(async (generation) => {
              await api.memo(
                key,
                {
                  generation,
                  fromGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
                  build: host.build().id,
                },
                context,
              )
            }),
            context,
          )
          return {
            isError: true,
            details: {
              fromGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
              toGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
              fromBuild: host.build().id,
              toBuild: host.build().id,
              error,
            },
            content: [{ type: 'text', text: error }],
          }
        },
      }),
    ],
  })
