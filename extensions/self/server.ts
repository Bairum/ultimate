import { resolve } from 'node:path'
import { awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'

import type { ExtensionHost } from '../../server/extensions.ts'

export default (host: ExtensionHost) =>
  defineExtension({
    name: 'self',
    sections: [
      section('self', (input) => {
        const cwd = input.env?.cwd ?? input.agent.cwd ?? host.projectRoot
        const isolated = resolve(cwd) !== resolve(host.projectRoot)
        const sourceRoot =
          isolated && host.projectRoot === host.ultimateRoot ? cwd : host.ultimateRoot
        return [
          `Project (your work): ${cwd}`,
          `Host project: ${host.projectRoot}`,
          `Ultimate (running host): ${host.ultimateRoot}`,
          ...(host.projectRoot === host.ultimateRoot
            ? ['The host project is Ultimate itself.']
            : []),
          `Direct project edits to ${cwd}; project-specific extensions, agents, skills, and surfaces belong in ${cwd}/.ultimate/.`,
          `The running host loads project config and extensions from ${host.projectRoot}/.ultimate/ and built-ins from ${host.ultimateRoot}/extensions/. These are host-scoped, not switched by your work cwd.`,
          `Before changing Ultimate, read ${sourceRoot}/AGENTS.md (layers, reloads, durability) and ${sourceRoot}/extensions/README.md (new UI is a new extension folder).`,
          isolated
            ? 'You are working in a separate checkout from the running host. Isolated edits do not hot-reload the host. Preview and verify this checkout separately; land changes for the host to pick them up. The restart tool is unavailable from this cwd.'
            : 'UI and extension changes in the running host reload live. Call restart only after editing server/ or shared/, never for web/, extensions/, or agents/.',
          'Restart swaps the shared Ultimate host for all conversations, not just your checkout. Landing changes does not automatically restart it; leave any required host restart to the coordinator or user.',
        ].join('\n')
      }),
    ],
    tools: [
      defineTool({
        name: 'restart',
        description:
          'Restart the shared Ultimate host for all conversations after changes to server/ or shared/. Only available from the host project cwd; not needed for web/, extensions/, or agents/.',
        parameters: Type.Object({}),
        replay: 'safe',
        async execute(_args, api, context): Promise<ToolExecutionResult> {
          const cwd = api.env?.cwd ?? (await api.agent(context)).cwd ?? host.projectRoot
          if (resolve(cwd) !== resolve(host.projectRoot)) {
            const error = `Restart refused: your cwd (${cwd}) is not the host project (${host.projectRoot}). Restart affects the shared Ultimate host for all conversations, not this checkout. Preview and verify your checkout separately; leave any host restart after landing to the coordinator or user.`
            return {
              isError: true,
              details: { refused: true, error },
              content: [{ type: 'text', text: error }],
            }
          }
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
