import { awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'

import type { ExtensionHost } from '../../server/extensions.ts'

export default (host: ExtensionHost) =>
  defineExtension({
    name: 'self',
    sections: [
      section(
        'self',
        () =>
          `Project (your work): ${host.projectRoot}\nUltimate (yourself): ${host.ultimateRoot}\n${host.projectRoot === host.ultimateRoot ? 'The project is Ultimate itself.\n' : ''}Project-specific extensions, agents, skills, and surfaces belong in ${host.projectRoot}/.ultimate/. Ultimate's core and built-ins live in its clone.\nBefore changing yourself, read ${host.ultimateRoot}/AGENTS.md (layers, reloads, durability) and ${host.ultimateRoot}/extensions/README.md (new UI is a new extension folder).\nUI and extension changes reload live. Call restart only after editing server/ or shared/, never for web/, extensions/, or agents/.`,
      ),
    ],
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
